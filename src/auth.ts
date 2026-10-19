#!/usr/bin/env node
/** Independent SIWC credentials. No Codex, browser cookie, or DSH token discovery. */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink, rmdir, lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

export const defaultDirectory = join(homedir(), '.config', 'dsh-cleangpt-plugin');
const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const APP = 'dsh-cleangpt-plugin';
/** Authentication failures stop inference without exposing token values. */
export class AuthError extends Error { readonly code = 'AUTH'; }
interface Session {
  client_id: string; subject?: string; email?: string; issuer?: string;
  access_token?: string; refresh_token?: string; id_token?: string;
  scope?: string; expires_at?: number; refresh_pending?: boolean;
}
interface Tokens {
  access_token: string; refresh_token: string; id_token?: string;
  token_type: string; expires_in: number; scope?: string;
}
function fail(message: string): never { throw new AuthError(message); }
function accountPath(dir: string, account: string) {
  if (account.toLowerCase() === 'host') fail('Account label host is reserved for this plugin metadata');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(account)) fail('Account label must contain 1–64 letters, digits, _ or -');
  return join(dir, `${account}.json`);
}
async function privateDirectory(dir: string) {
  if (!isAbsolute(dir)) fail('Credential directory must be an absolute path');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) fail('Credential directory must be owned by you, mode 0700, and not a symlink');
}
/** Read only owner-private regular files; symlinks are never followed. */
async function read<T>(file: string): Promise<T | undefined> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (isCode(error, 'ENOENT')) return undefined; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) fail('Credential file must be owned by you with mode 0600');
    const raw = await handle.readFile('utf8');
    try { return JSON.parse(raw) as T; } catch (error) { return fail('Credential JSON is invalid; contents suppressed'); }
  } finally { await handle.close(); }
}
async function readSession(file: string) {
  const session = await read<Session>(file);
  if (session && (typeof session !== 'object' || typeof session.client_id !== 'string' || !session.client_id || session.client_id === 'dynamic_agent_client' || ['subject', 'scope', 'access_token', 'refresh_token', 'id_token'].some(key => key in session && typeof session[key as keyof Session] !== 'string'))) fail('Invalid credential record; reauthorize this account');
  return session;
}
function isCode(error: unknown, code: string): boolean { return error instanceof Error && 'code' in error && error.code === code; }
async function write(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, file); }
  catch (error) { await unlink(temporary); throw error; }
}
/** Fail closed on cross-process races; never delete another process's lock. */
export async function exclusive<T>(dir: string, operation: () => Promise<T>): Promise<T> {
  await privateDirectory(dir);
  const lock = join(dir, '.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (isCode(error, 'EEXIST')) fail('ChatGPT credential operation busy; retry after it finishes. A crash may leave .lock: verify no plugin/login process is running before removing it.'); throw error; }
  try { return await operation(); } finally { await rmdir(lock); }
}
function trustedEndpoint(value: unknown): string {
  if (typeof value !== 'string') return fail('Missing OpenAI discovery endpoint');
  const url = new URL(value);
  if (url.origin !== ISSUER || url.username || url.password || url.hash) fail('Untrusted OpenAI discovery endpoint');
  return url.href;
}
async function discovery(signal?: AbortSignal) {
  const response = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: timed(signal), redirect: 'error' });
  if (!response.ok) fail(`OpenAI discovery HTTP ${response.status}`);
  const data = await response.json();
  if (data.issuer !== ISSUER) fail('OpenAI issuer mismatch');
  return { authorize: trustedEndpoint(data.authorization_endpoint), token: trustedEndpoint(data.token_endpoint), jwks: trustedEndpoint(data.jwks_uri), revoke: trustedEndpoint(data.revocation_endpoint) };
}
function timed(signal?: AbortSignal) { return signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000); }
async function postToken(url: string, fields: Record<string, string>, signal?: AbortSignal): Promise<Tokens> {
  const response = await fetch(url, { method: 'POST', redirect: 'error', signal: timed(signal), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  if (!response.ok) fail(`OpenAI token HTTP ${response.status}; credentials retained. Reauthorize this account if invalid/revoked. Request ID: ${response.headers.get('x-request-id') ?? 'unavailable'}`);
  const data = await response.json();
  if (data.token_type?.toLowerCase() !== 'bearer' || typeof data.access_token !== 'string' || !data.access_token || typeof data.refresh_token !== 'string' || !data.refresh_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) fail('Invalid OpenAI token response; credentials were not replaced');
  return data;
}
function hasPermission(scope?: string) { return scope?.split(/\s+/).includes('chatgpt.tokens.use.direct') === true; }

/** Refresh one session under a shared lock and return its OAuth bearer; never infer eligibility. */
const renewals = new Map<string, Promise<string>>();
export async function accessToken(dir = defaultDirectory, account = 'default', signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const key = accountPath(resolve(dir), account);
  let pending = renewals.get(key);
  if (!pending) {
    // A caller owns only its wait; shared rotation has its own bounded lifetime.
    pending = lockedAccessToken(dir, account, AbortSignal.timeout(30_000)).finally(() => renewals.delete(key));
    renewals.set(key, pending);
  }
  return signal ? Promise.race([pending, new Promise<never>((_, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending!.then(() => signal.removeEventListener('abort', abort), () => signal.removeEventListener('abort', abort));
  })]) : pending;
}
async function lockedAccessToken(dir: string, account: string, signal?: AbortSignal): Promise<string> {
  return exclusive(dir, async () => {
    signal?.throwIfAborted();
    const file = accountPath(dir, account), session = await readSession(file);
    if (!session?.access_token || !session.refresh_token) return fail('Continue with ChatGPT first: dsh-cleangpt-plugin login ACCOUNT --approve-access');
    if (!hasPermission(session.scope)) return fail('ChatGPT plan usage permission is disabled; reauthorize this account explicitly');
    if (session.refresh_pending) return fail('Previous token renewal outcome is uncertain. Tokens retained; reauthorize this account instead of replaying a rotating refresh token.');
    if ((session.expires_at ?? 0) > Date.now() + 60_000) return session.access_token;
    const endpoints = await discovery(signal);
    // Persist before sending: a process crash or lost response must not replay a rotated token.
    await write(file, { ...session, refresh_pending: true });
    const tokens = await postToken(endpoints.token, { grant_type: 'refresh_token', client_id: session.client_id, refresh_token: session.refresh_token, resource: RESOURCE }, signal);
    const updated = { ...session, ...tokens, scope: tokens.scope ?? session.scope, expires_at: Date.now() + tokens.expires_in * 1000, refresh_pending: false };
    await write(file, updated);
    if (!hasPermission(updated.scope)) return fail('ChatGPT plan permission was removed; inference stopped');
    return tokens.access_token;
  });
}

/** Construct a fresh PKCE transaction, keeping all secrets in memory. */
export function authorization(endpoints: { authorize: string }, host: string, session?: Session) {
  const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(64).toString('base64url');
  const url = new URL(endpoints.authorize);
  url.search = new URLSearchParams({ client_id: session?.client_id ?? 'dynamic_agent_client', ext_agent_host_id: host, response_type: 'code', scope: SCOPE, resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    ...(session ? {} : { agent_name_hint: APP }), ...(session?.id_token ? { id_token_hint: session.id_token } : {}) }).toString();
  return { url, state, nonce, verifier };
}
/** Validate state and registration before allowing a one-time code exchange. */
export function callback(url: URL, state: string, session?: Session) {
  if (url.pathname !== '/auth/callback' || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state) fail('Invalid OAuth callback/state');
  if (url.searchParams.has('error')) fail('OpenAI authorization declined or failed');
  const client = url.searchParams.get('client_id') ?? session?.client_id;
  if (!client || client === 'dynamic_agent_client' || (session && session.client_id !== client)) fail('Missing or mismatched issued client ID');
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('client_id').length > 1) fail('Missing or ambiguous OAuth code/client ID');
  return { client_id: client, code };
}

/** Verify identity with a trusted issuer key set before replacing a registration's credentials. */
export async function verifyIdentity(token: string, client: string, nonce: string, subject: string | undefined, keys: JWTVerifyGetKey) {
  const { payload } = await jwtVerify(token, keys, { issuer: ISSUER, audience: client, requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 });
  if (payload.nonce !== nonce || !payload.sub || (subject && payload.sub !== subject)) return fail('OpenAI ID-token identity/nonce mismatch; previous credentials retained');
  return payload;
}

/** User-invoked login only. Starts a loopback listener before opening the system browser. */
export async function login(dir = defaultDirectory, account = 'default', signal = AbortSignal.timeout(300_000)): Promise<void> {
  return exclusive(dir, async () => {
    const file = accountPath(dir, account), previous = await readSession(file);
    let host = await read<string>(join(dir, 'host.json'));
    if (host !== undefined && (typeof host !== 'string' || !/^urn:uuid:[0-9a-f-]{36}$/i.test(host))) fail('Invalid host ID record');
    if (!host) { host = `urn:uuid:${randomUUID()}`; await write(join(dir, 'host.json'), host); }
    const endpoints = await discovery(signal), transaction = authorization(endpoints, host, previous);
    let settle!: (value: ReturnType<typeof callback>) => void, reject!: (error: unknown) => void;
    const result = new Promise<ReturnType<typeof callback>>((yes, no) => { settle = yes; reject = no; });
    result.catch(() => { /* The awaited result below owns reporting, including browser/startup races. */ });
    let consumed = false;
    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      try {
        if (request.method !== 'GET' || consumed || request.headers.host !== `127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` || request.headers.origin) { response.writeHead(400).end('Invalid request'); return; }
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.searchParams.get('state') !== transaction.state) { response.writeHead(400).end('Invalid state'); return; }
        consumed = true;
        const value = callback(url, transaction.state, previous);
        response.end('Authorization received. Return to the terminal.'); settle(value);
      } catch (error) { response.writeHead(400).end('Authorization failed. Return to the terminal.'); reject(error); }
    });
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
      const address = server.address();
      if (!address || typeof address === 'string') return fail('Cannot bind OAuth loopback listener');
      const redirect = `http://127.0.0.1:${address.port}/auth/callback`;
      transaction.url.searchParams.set('redirect_uri', redirect);
      signal.throwIfAborted();
      const browser = process.platform === 'darwin' ? ['open', transaction.url.href] : process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', transaction.url.href] : ['xdg-open', transaction.url.href];
      // Never print the URL: returning sign-ins contain a retained ID token hint.
      console.log('Continue with ChatGPT — opening the system browser.');
      const child = spawn(browser[0], browser.slice(1), { stdio: 'ignore' });
      child.on('error', reject); child.on('exit', code => { if (code !== 0) reject(new Error('Cannot open the system browser')); });
      const registration = await result;
      // Retain issued mapping even if code exchange fails; do not register again blindly.
      await write(file, { ...previous, client_id: registration.client_id });
      const tokens = await postToken(endpoints.token, { grant_type: 'authorization_code', client_id: registration.client_id, code: registration.code, code_verifier: transaction.verifier, redirect_uri: redirect, resource: RESOURCE }, signal);
      if (!tokens.id_token) return fail('Missing OpenAI ID token');
      const payload = await verifyIdentity(tokens.id_token, registration.client_id, transaction.nonce, previous?.subject, createRemoteJWKSet(new URL(endpoints.jwks)));
      await write(file, { client_id: registration.client_id, subject: payload.sub, issuer: ISSUER, email: typeof payload.email === 'string' ? payload.email : undefined, ...tokens, expires_at: Date.now() + tokens.expires_in * 1000 });
      console.log(hasPermission(tokens.scope) ? `Signed in: ${account}; ChatGPT plan usage enabled.` : `Signed in: ${account}; plan usage disabled (consent missing).`);
    } finally { signal.removeEventListener('abort', onAbort); server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  });
}

/** Revoke this plugin's renewable session, clear local tokens, and retain its registration. */
export async function logout(dir = defaultDirectory, account = 'default'): Promise<void> {
  return exclusive(dir, async () => {
    const file = accountPath(dir, account), session = await readSession(file);
    if (!session) return;
    let revoked = false;
    try {
      const endpoints = await discovery();
      if (session.refresh_token) {
        const response = await fetch(endpoints.revoke, { method: 'POST', redirect: 'error', signal: timed(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: session.refresh_token, token_type_hint: 'refresh_token', client_id: session.client_id }) });
        revoked = response.status === 200;
      } else revoked = true;
    } catch (error) { /* Clear local credentials even when remote revocation is unavailable. */ }
    await write(file, { client_id: session.client_id, subject: session.subject, issuer: session.issuer, email: session.email });
    console.log(revoked ? 'Signed out.' : 'Signed out locally; remote revocation unconfirmed. Disconnect this app in ChatGPT Settings.');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, account = 'default', ...flags] = process.argv.slice(2);
  const dir = process.env.DSH_CLEANGPT_AUTH_DIR ?? defaultDirectory;
  try {
    if (command === 'login') {
      if (!flags.includes('--approve-access')) fail('Login creates/renews persistent ChatGPT plan access. Run login ACCOUNT --approve-access only after explicit approval.');
      await login(dir, account);
    } else if (command === 'logout') await logout(dir, account);
    else if (command === 'accounts') {
      const { readdir } = await import('node:fs/promises');
      const names = await readdir(dir).catch(error => { if (isCode(error, 'ENOENT')) return []; throw error; });
      for (const entry of names.filter(n => n.endsWith('.json') && n !== 'host.json')) console.log(entry.slice(0, -5));
    } else fail('Usage: dsh-cleangpt-plugin login ACCOUNT --approve-access | logout ACCOUNT | accounts');
  } catch (error) { console.error(error instanceof Error ? error.message : 'ChatGPT authentication failed'); process.exitCode = 1; }
}
