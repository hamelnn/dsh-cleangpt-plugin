/** Host-owned session transport preferences and safe authentication commands. */
import { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { credentialStatus, login } from './auth.js';

export const defaultServiceTiers = ['auto', 'default', 'fast', 'ultrafast', 'priority', 'flex', 'scale'];
export const speedSchema = z.string().min(1);
export type Speed = z.infer<typeof speedSchema>;
export interface SpeedView { speed: Speed; revision: string; choices: string[]; }
export const sessionDomain = defineDomain({ name: 'cleangpt', version: 1,
  tables: { sessions: domainTable(z.object({ speed: speedSchema })) } });
export interface SafeStatus { account: string; signedIn: boolean; permission: boolean; renewalUncertain: boolean;
  attempt?: string; phase: 'idle' | 'pending' | 'failed' | 'cancelled'; }
export interface SessionPreferences { get(id: string): { speed: Speed } | undefined; put(id: string, value: { speed: Speed }): Promise<void>; }
/** Same turn/step retries retain the first durable selection; new steps read it again. */
export class RequestSpeeds {
  private readonly requests = new WeakMap<AbortSignal, Map<string, { turn: number; step: number; speed: Speed }>>();
  constructor(private readonly sessions: Promise<SessionPreferences>) {}
  async capture(id: string, turn: number, step: number, signal: AbortSignal): Promise<void> {
    let bySession = this.requests.get(signal);
    if (!bySession) { bySession = new Map(); this.requests.set(signal, bySession); }
    const previous = bySession.get(id);
    if (!previous || previous.turn !== turn || previous.step !== step)
      bySession.set(id, { turn, step, speed: (await this.sessions).get(id)?.speed ?? 'auto' });
  }
  async read(id: string, signal?: AbortSignal): Promise<Speed> {
    return (signal ? this.requests.get(signal)?.get(id)?.speed : undefined) ?? (await this.sessions).get(id)?.speed ?? 'auto';
  }
}

/** One controller per plugin instance, never accepts credential paths or account labels from the browser. */
export class Controls extends TypertRemoteService {
  private speedRevision = randomUUID();
  private readonly owner: Context;
  private active?: { id: string; abort: AbortController; done: Promise<void> };
  private phase: SafeStatus['phase'] = 'idle';
  constructor(ctx: Context, private readonly config: { authDir: string; account: string; serviceTiers?: string[]; serviceTier?: string },
    private readonly sessions: Promise<SessionPreferences>,
    private readonly signIn: typeof login = login) {
    super(ctx, 'cleangptControls', { namespace: 'cleangpt' });
    this.owner = ctx;
    this.choices().forEach(value => speedSchema.parse(value));
    ctx.effect(() => () => this.dispose());
    ctx.on('domain/changed', change => { if (change.domain === sessionDomain.name) this.speedRevision = randomUUID(); });
  }
  private choices(current?: string): string[] {
    return [...new Set(['auto', ...(this.config.serviceTiers ?? defaultServiceTiers), ...(this.config.serviceTier ? [this.config.serviceTier] : []), ...(current ? [current] : [])])];
  }
  @Remote
  async status(): Promise<SafeStatus> {
    const safe = await credentialStatus(this.config.authDir, this.config.account);
    return { ...safe, phase: this.phase, ...(this.active ? { attempt: this.active.id } : {}) };
  }
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<SafeStatus> {
    while (!signal.aborted) {
      yield await this.status();
      try { await setTimeout(1000, undefined, { signal }); }
      catch (error) { if (!signal.aborted) throw error; }
    }
  }
  @Remote
  async start(): Promise<SafeStatus> {
    if (!this.active) {
      const abort = new AbortController(), id = randomUUID();
      this.phase = 'pending';
      // Publish ownership before invoking even an immediately rejecting implementation.
      const active = { id, abort, done: Promise.resolve() };
      this.active = active;
      active.done = Promise.resolve().then(() => this.signIn(this.config.authDir, this.config.account,
        AbortSignal.any([abort.signal, AbortSignal.timeout(300_000)])))
        .then(() => { this.phase = 'idle'; }, () => { this.phase = abort.signal.aborted ? 'cancelled' : 'failed'; })
        .finally(() => { if (this.active === active) this.active = undefined; });
    }
    return this.status();
  }
  @Remote
  async cancel(attempt: string): Promise<SafeStatus> {
    z.string().uuid().parse(attempt);
    const active = this.active;
    if (active?.id === attempt) { active.abort.abort(); await active.done; }
    return this.status();
  }
  @Remote
  async getSpeed(sessionId: string): Promise<Speed> {
    z.string().min(1).max(256).parse(sessionId);
    return (await this.sessions).get(sessionId)?.speed ?? 'auto';
  }
  /** Reconnect-safe long poll: initial snapshot, then durable changes or a bounded heartbeat. */
  @Remote
  async watchSpeed(sessionId: string, after: string, signal: AbortSignal): Promise<SpeedView> {
    z.string().min(1).max(256).parse(sessionId); z.string().max(64).parse(after);
    const sessions = await this.sessions; signal.throwIfAborted();
    if (after === this.speedRevision) await new Promise<void>((resolve, reject) => {
      const cleanup = () => { stop(); clearTimeout(timer); signal.removeEventListener('abort', abort); };
      const wake = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal.reason); };
      const stop = this.owner.on('domain/changed', change => {
        if (change.domain === sessionDomain.name && change.table === 'sessions' && change.key === sessionId) wake();
      });
      const timer = globalThis.setTimeout(wake, 15_000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else if (after !== this.speedRevision) wake();
    });
    signal.throwIfAborted();
    const speed = sessions.get(sessionId)?.speed ?? 'auto';
    return { speed, revision: this.speedRevision, choices: this.choices(speed) };
  }
  @Remote
  async setSpeed(sessionId: string, speed: Speed): Promise<Speed> {
    z.string().min(1).max(256).parse(sessionId); speedSchema.parse(speed);
    const sessions = await this.sessions;
    if (!this.choices(sessions.get(sessionId)?.speed).includes(speed)) throw new Error('Speed candidate is not configured');
    await sessions.put(sessionId, { speed });
    return speed;
  }
  async dispose(): Promise<void> { const active = this.active; active?.abort.abort(); await active?.done; }
}
