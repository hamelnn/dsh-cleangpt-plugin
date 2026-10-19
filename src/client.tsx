/** Browser UI uses the authenticated DSH Connection; no credential value crosses it. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { useEffect, useRef, useState } from 'react';
import type { SafeStatus, Speed } from './controls.js';

export const inject = ['slots', 'connection'];
interface Rpc { <T>(method: string, args?: unknown[]): Promise<T>; }
export function AccountPanel({ rpc }: { rpc: Rpc }) {
  const [status, setStatus] = useState<SafeStatus>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const revision = useRef(0), action = useRef(false);
  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      if (action.current) return;
      const generation = revision.current;
      return rpc<SafeStatus>('status').then(value => { if (mounted && generation === revision.current) { setStatus(value); setError(false); } }, () => { if (mounted && generation === revision.current) setError(true); });
    };
    void refresh(); const timer = setInterval(refresh, 1000);
    return () => { mounted = false; clearInterval(timer); };
  }, [rpc]);
  const run = async (method: string, args: unknown[] = []) => {
    if (action.current) return;
    action.current = true; revision.current++;
    setBusy(true); setError(false);
    try { setStatus(await rpc<SafeStatus>(method, args)); } catch { setError(true); }
    finally { action.current = false; setBusy(false); }
  };
  return <section aria-label="ChatGPT subscription" style={{padding:'12px', border:'1px solid #8885', borderRadius:12, display:"grid", gap:10, fontSize:14}}>
    <strong>ChatGPT subscription</strong>
    <p role="status">{status ? `${status.account}: ${status.signedIn ? 'Signed in' : 'Signed out'} · ${status.phase}` : 'Loading…'}</p>
    {status?.signedIn && <p>{status.permission ? 'Plan permission stored; server validates eligibility.' : 'Plan permission missing; reauthorize.'}</p>}
    {status?.renewalUncertain && <p role="alert">Renewal uncertain. Reauthorize this account.</p>}
    <p>Continue opens the official authorization page in the DSH Host’s system browser and grants renewable plan access.</p>
    <Button variant="outline" size="sm" disabled={busy || !status || status.phase === 'pending'} onClick={() => void run('start')}>{status?.signedIn ? 'Reauthorize with ChatGPT' : 'Continue with ChatGPT'}</Button>
    {status?.attempt && <Button variant="outline" size="sm" disabled={busy} onClick={() => void run('cancel', [status.attempt])}>Cancel authorization</Button>}
    {(error || status?.phase === 'failed') && <p role="alert">Authorization unavailable or declined. Retry or check the Host browser.</p>}
  </section>;
}
export function SpeedSelect({ rpc, sessionId }: { rpc: Rpc; sessionId: string }) {
  const [speed, setSpeed] = useState<Speed>(), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  useEffect(() => {
    let mounted = true; setSpeed(undefined); setError(false);
    void rpc<Speed>('getSpeed', [sessionId]).then(value => { if (mounted) setSpeed(value); }, () => { if (mounted) setError(true); });
    return () => { mounted = false; };
  }, [rpc, sessionId]);
  return <label title="Candidate transport preference; OpenAI validates availability. Applies to the next request in this conversation.">
    Speed <select aria-label="ChatGPT speed" disabled={busy || speed === undefined} style={{font:"inherit",background:"transparent",color:"inherit",border:"1px solid #8885",borderRadius:8,padding:"4px 8px"}} value={speed ?? 'auto'} onChange={async event => {
      const selected = event.target.value as Speed; setBusy(true); setError(false);
      try { setSpeed(await rpc<Speed>('setSpeed', [sessionId, selected])); } catch { setError(true); }
      finally { setBusy(false); }
    }}>
      <option value="auto">Auto</option><option value="default">Standard</option><option value="priority">Fast (server validates)</option>
    </select>{error && <span role="alert">Could not load/save speed. <Button size="sm" disabled={busy} onClick={async () => {
      setBusy(true);
      try { setSpeed(await rpc<Speed>('getSpeed', [sessionId])); setError(false); } catch { setError(true); }
      finally { setBusy(false); }
    }}>Retry</Button></span>}
  </label>;
}
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionHandle;
  const rpc: Rpc = async <T,>(method: string, args: unknown[] = []) => {
    const names: Record<string, string[]> = { status: [], start: [], cancel: ['attempt'], getSpeed: ['sessionId'], setSpeed: ['sessionId', 'speed'] };
    const result = await connection.rpc.call('/api', `cleangpt/${method}`, { args: Object.fromEntries((names[method] ?? []).map((name, i) => [name, args[i]])) });
    if (!result.ok) throw new Error('ChatGPT controls unavailable');
    return result.value as T;
  };
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer', id: 'cleangpt-account', inject: () => ({ rpc }),
  }, AccountPanel));
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'cleangpt-speed', inject: sessionId => ({ rpc, sessionId }),
  }, props => <SpeedSelect key={props.sessionId} {...props} />));
}
