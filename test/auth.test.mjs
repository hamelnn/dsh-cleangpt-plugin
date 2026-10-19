// All identity/token/bearer values in this file are synthetic fixtures; no real credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, chmod, symlink, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { accessToken, exclusive, authorization, callback, verifyIdentity } from '../dist/auth.js';

const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const issuer = 'https://auth.openai.com';
const previous = { client_id: 'oaiapp_mock', subject: 'sub_mock', id_token: 'mock-hint' };
const temporary = async () => mkdtemp(join(tmpdir(), 'cleangpt-mock-test-'));
const session = () => ({ ...previous, access_token: 'mock-old', refresh_token: 'mock-refresh-old', scope, expires_at: Date.now() - 1 });
const seed = async (dir, value = session()) => writeFile(join(dir, 'default.json'), JSON.stringify(value), { mode: 0o600 });
const read = dir => readFile(join(dir, 'default.json'), 'utf8').then(JSON.parse);
const discovery = { issuer, authorization_endpoint: `${issuer}/api/accounts/authorize`, token_endpoint: `${issuer}/api/accounts/oauth/token`, jwks_uri: `${issuer}/.well-known/jwks.json`, revocation_endpoint: `${issuer}/mock-revoke` };

test('first registration uses fresh PKCE/state/nonce, real app name and stable host identifier', () => {
  const a = authorization({ authorize: discovery.authorization_endpoint }, 'urn:uuid:mock'), b = authorization({ authorize: discovery.authorization_endpoint }, 'urn:uuid:mock');
  assert.notEqual(a.state, b.state); assert.notEqual(a.nonce, b.nonce); assert.notEqual(a.verifier, b.verifier);
  assert.equal(a.url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(a.url.searchParams.get('agent_name_hint'), 'dsh-cleangpt-plugin');
  assert.equal(a.url.searchParams.get('scope'), scope); assert.equal(a.url.searchParams.get('code_challenge_method'), 'S256');
  const returning = authorization({ authorize: discovery.authorization_endpoint }, 'urn:uuid:mock', previous);
  assert.equal(returning.url.searchParams.get('client_id'), previous.client_id); assert.equal(returning.url.searchParams.get('id_token_hint'), 'mock-hint'); assert.equal(returning.url.searchParams.has('agent_name_hint'), false);
});
test('callback validates exact state/path, issued registration and returning client identity', () => {
  const url = query => new URL(`http://127.0.0.1:12345/auth/callback?${query}`);
  assert.deepEqual(callback(url('code=mock-code&state=s&client_id=oaiapp_mock'), 's'), { client_id: 'oaiapp_mock', code: 'mock-code' });
  assert.equal(callback(url('code=c&state=s'), 's', previous).client_id, previous.client_id);
  assert.throws(() => callback(url('code=c&state=s'), 's'));
  for (const query of ['code=c&state=bad', 'code=c&state=s&state=s', 'error=access_denied&state=s', 'code=c&state=s&client_id=dynamic_agent_client', 'code=c&state=s&client_id=other']) assert.throws(() => callback(url(query), 's', previous));
});
test('ID tokens require trusted signature, issuer/audience/expiry/nonce and original account', async () => {
  const keys = await generateKeyPair('RS256'), publicJwk = await exportJWK(keys.publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...publicJwk, kid: 'test', alg: 'RS256' }] });
  const signed = (overrides = {}) => new SignJWT({ nonce: 'n', ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(overrides.iss ?? issuer).setAudience(overrides.aud ?? previous.client_id).setSubject(overrides.sub ?? previous.subject).setIssuedAt().setExpirationTime(overrides.exp ?? '5m').sign(keys.privateKey);
  assert.equal((await verifyIdentity(await signed(), previous.client_id, 'n', previous.subject, jwks)).sub, previous.subject);
  for (const overrides of [{ iss: 'https://untrusted.invalid' }, { aud: 'other' }, { sub: 'other' }, { nonce: 'bad' }, { exp: Math.floor(Date.now() / 1000) - 60 }]) await assert.rejects(verifyIdentity(await signed(overrides), previous.client_id, 'n', previous.subject, jwks));
  const foreign = await generateKeyPair('RS256');
  const forged = await new SignJWT({ nonce: 'n' }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setAudience(previous.client_id).setSubject(previous.subject).setIssuedAt().setExpirationTime('5m').sign(foreign.privateKey);
  await assert.rejects(verifyIdentity(forged, previous.client_id, 'n', previous.subject, jwks));
});
test('one refresh for concurrent callers, exact grant, atomic rotation, owner-only files', async () => {
  const dir = await temporary(), original = globalThis.fetch; await seed(dir); let tokenCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('.well-known')) return Response.json(discovery);
    tokenCalls++; const fields = new URLSearchParams(init.body);
    assert.equal(fields.get('grant_type'), 'refresh_token'); assert.equal(fields.get('client_id'), previous.client_id); assert.equal(fields.get('resource'), 'https://api.openai.com/v1'); assert.equal(fields.has('scope'), false);
    return Response.json({ access_token: 'mock-new', refresh_token: 'mock-rotated', token_type: 'Bearer', expires_in: 3600 });
  };
  try {
    assert.deepEqual(await Promise.all([accessToken(dir), accessToken(dir)]), ['mock-new', 'mock-new']); assert.equal(tokenCalls, 1);
    const saved = await read(dir); assert.equal(saved.refresh_token, 'mock-rotated'); assert.equal(saved.refresh_pending, false); assert.equal(saved.scope, scope); assert.equal((await stat(join(dir, 'default.json'))).mode & 0o777, 0o600);
  } finally { globalThis.fetch = original; await rm(dir, { recursive: true }); }
});
test('uncertain renewal retains tokens and blocks replay after restart', async () => {
  const dir = await temporary(), original = globalThis.fetch; await seed(dir); let requests = 0;
  globalThis.fetch = async url => { requests++; if (String(url).includes('.well-known')) return Response.json(discovery); throw new Error('mock lost response'); };
  try {
    await assert.rejects(accessToken(dir), /lost response/); const saved = await read(dir);
    assert.equal(saved.refresh_token, 'mock-refresh-old'); assert.equal(saved.refresh_pending, true);
    await assert.rejects(accessToken(dir), /uncertain/); assert.equal(requests, 2);
  } finally { globalThis.fetch = original; await rm(dir, { recursive: true }); }
});
test('missing consent, invalid labels, unsafe storage and symlinks fail closed', async () => {
  const dir = await temporary();
  try {
    await seed(dir, { ...session(), scope: 'openid', expires_at: Date.now() + 3600_000 });
    await assert.rejects(accessToken(dir), /permission/); await assert.rejects(accessToken(dir, '../other'), /label/);
    await chmod(join(dir, 'default.json'), 0o644); await assert.rejects(accessToken(dir), /0600/);
    await rm(join(dir, 'default.json')); await symlink('/dev/null', join(dir, 'default.json')); await assert.rejects(accessToken(dir));
    await chmod(dir, 0o755); await assert.rejects(accessToken(dir), /0700/);
  } finally { await rm(dir, { recursive: true }); }
});
test('cross-process lock refuses concurrent writers and is released after failure', async () => {
  const dir = await temporary();
  try {
    await mkdir(join(dir, '.lock'), { mode: 0o700 }); await assert.rejects(exclusive(dir, async () => 1), /busy/);
    await rm(join(dir, '.lock'), { recursive: true }); await assert.rejects(exclusive(dir, async () => { throw new Error('mock'); }));
    assert.equal(await exclusive(dir, async () => 42), 42);
  } finally { await rm(dir, { recursive: true }); }
});

test('CLI refuses persistent authorization without explicit flag and creates no credential directory', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = await temporary(), authDir = join(dir, 'not-created');
  try {
    const result = spawnSync(process.execPath, ['dist/auth.js', 'login', 'default'], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, DSH_CLEANGPT_AUTH_DIR: authDir } });
    assert.equal(result.status, 1); assert.match(result.stderr, /persistent ChatGPT plan access/);
    await assert.rejects(stat(authDir), error => error.code === 'ENOENT');
  } finally { await rm(dir, { recursive: true }); }
});
test('revoked scopes after refresh block inference but preserve the new renewable session', async () => {
  const dir = await temporary(), original = globalThis.fetch; await seed(dir);
  globalThis.fetch = async url => String(url).includes('.well-known') ? Response.json(discovery) : Response.json({ access_token: 'mock-new', refresh_token: 'mock-replaced', token_type: 'Bearer', expires_in: 3600, scope: 'openid profile' });
  try { await assert.rejects(accessToken(dir), /permission was removed/); assert.equal((await read(dir)).refresh_token, 'mock-replaced'); }
  finally { globalThis.fetch = original; await rm(dir, { recursive: true }); }
});
test('discovery refuses credential forwarding to another origin before a refresh token is sent', async () => {
  const dir = await temporary(), original = globalThis.fetch; await seed(dir); let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ ...discovery, token_endpoint: 'https://untrusted.invalid/token' }); };
  try { await assert.rejects(accessToken(dir), /Untrusted/); assert.equal(calls, 1); assert.equal((await read(dir)).refresh_pending, undefined); }
  finally { globalThis.fetch = original; await rm(dir, { recursive: true }); }
});

test('first caller cancellation leaves shared refresh alive for another caller and releases its lock', async () => {
  const dir = await temporary(), original = globalThis.fetch; await seed(dir);
  const controller = new AbortController(); let started, complete, wireSignal, tokenCalls = 0;
  const arrived = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('.well-known')) return Response.json(discovery);
    tokenCalls++; wireSignal = init.signal; started();
    return new Promise(resolve => { complete = () => resolve(Response.json({ access_token: 'mock-new', refresh_token: 'mock-rotated', token_type: 'Bearer', expires_in: 3600 })); });
  };
  try {
    const first = accessToken(dir, 'default', controller.signal); first.catch(() => {});
    await arrived;
    const shared = accessToken(dir); controller.abort();
    await assert.rejects(first); assert.equal(wireSignal.aborted, false);
    complete(); assert.equal(await shared, 'mock-new'); assert.equal(tokenCalls, 1);
    const saved = await read(dir); assert.equal(saved.refresh_token, 'mock-rotated'); assert.equal(saved.refresh_pending, false);
    await assert.rejects(stat(join(dir, '.lock')), error => error.code === 'ENOENT');
    assert.equal(await accessToken(dir), 'mock-new'); assert.equal(tokenCalls, 1);
  } finally { globalThis.fetch = original; await rm(dir, { recursive: true }); }
});

test('host account label cannot overwrite global host metadata', async () => {
  const dir = await temporary(), file = join(dir, 'host.json');
  await writeFile(file, JSON.stringify('urn:uuid:00000000-0000-4000-8000-000000000000'), { mode: 0o600 });
  try { await assert.rejects(accessToken(dir, 'host'), /reserved/); await assert.rejects(accessToken(dir, 'Host'), /reserved/); assert.equal(JSON.parse(await readFile(file, 'utf8')), 'urn:uuid:00000000-0000-4000-8000-000000000000'); }
  finally { await rm(dir, { recursive: true }); }
});

test('real loopback login with synthetic discovery/JWT retains PKCE, rejects late callbacks after cancellation', async () => {
  const { login } = await import('../dist/auth.js');
  const dir = await temporary(), bin = join(dir, 'bin'), launchFile = join(dir, 'launch');
  await mkdir(bin);
  await writeFile(join(bin, 'xdg-open'), `#!/bin/sh\nprintf '%s' "$1" > '${launchFile}'\n`, { mode: 0o700 });
  const savedPath = process.env.PATH, originalFetch = globalThis.fetch;
  process.env.PATH = `${bin}:${savedPath}`;
  const controller = new AbortController();
  globalThis.fetch = async (url, init) => String(url).startsWith(issuer)
    ? Response.json(discovery) : originalFetch(url, init);
  try {
    const pending = login(dir, 'default', controller.signal);
    let launch;
    for (let i=0;i<100;i++) {
      try { launch = new URL(await readFile(launchFile, 'utf8')); break; }
      catch { await new Promise(r=>setTimeout(r, 10)); }
    }
    assert.ok(launch);assert.equal(launch.searchParams.get('code_challenge_method'),'S256');
    const redirect = new URL(launch.searchParams.get('redirect_uri'));
    redirect.search = new URLSearchParams({state:launch.searchParams.get('state'),code:'mock-code',client_id:'mock-issued'}).toString();
    controller.abort(); await assert.rejects(pending);
    await assert.rejects(originalFetch(redirect));
    await assert.rejects(read(dir), {code:'ENOENT'});
    assert.equal((await stat(dir)).mode & 0o077, 0);
  } finally { process.env.PATH = savedPath; globalThis.fetch = originalFetch; await rm(dir,{recursive:true,force:true}); }
});
