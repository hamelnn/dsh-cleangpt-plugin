/** Browser UI uses the authenticated DSH Connection; no credential value crosses it. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import { Button, Menu, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { useEffect, useRef, useState } from 'react';
import type { SafeStatus, Speed, SpeedView } from './controls.js';

export const inject = ['slots', 'connection'];
interface Rpc { <T>(method: string, args?: unknown[], signal?: AbortSignal): Promise<T>; }
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
  const run = async (method: string, args: unknown[] = [], signal?: AbortSignal) => {
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
export function SpeedSelect({ rpc, sessionId, subscribeReset }: { rpc: Rpc; sessionId: string; subscribeReset: (listener: () => void) => () => void }) {
  const [choices, setChoices] = useState<string[]>([]);
  const [open, setOpen] = useState(false), [reload, setReload] = useState(0);
  const [speed, setSpeed] = useState<Speed>(), [busy, setBusy] = useState(false), [error, setError] = useState(false), [offline, setOffline] = useState(false);
  const lifetime = useRef(0);
  useEffect(() => subscribeReset(() => setReload(value => value + 1)), [subscribeReset]);
  useEffect(() => {
    const reset = () => setReload(value => value + 1);
    window.addEventListener('online', reset); window.addEventListener('offline', reset);
    return () => { window.removeEventListener('online', reset); window.removeEventListener('offline', reset); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(), generation = ++lifetime.current;
    let active = true, revision = '';
    setSpeed(undefined); setBusy(false);
    void (async () => {
      while (active) {
        try {
          const view = await rpc<SpeedView>('watchSpeed', [sessionId, revision], controller.signal);
          if (!active || generation !== lifetime.current) return;
          revision = view.revision; setChoices(view.choices); setSpeed(view.speed); setOffline(false);
        } catch {
          if (!active) return;
          setSpeed(undefined); setOffline(true); revision = '';
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [rpc, sessionId, reload]);
  const labels = new Map([['auto', 'Auto'], ['default', 'Standard'], ['fast', 'Fast'], ['ultrafast', 'Ultrafast'], ['priority', 'Priority'], ['flex', 'Flex'], ['scale', 'Scale']]);
  const label = (id: string) => labels.get(id) ?? id;
  return <span>
    <Menu open={open} portal compact side="top" selectedId={speed} onClose={() => setOpen(false)}
      items={choices.map(id => ({ id, label: id === 'auto' ? label(id) : `${label(id)} (server validates)`, disabled: busy || speed === undefined }))}
      anchor={<Button variant="ghost" size="sm" aria-label={`ChatGPT speed: ${speed ? label(speed) : 'Loading'}`}
        aria-haspopup="menu" aria-expanded={open} aria-busy={busy} data-cleangpt-speed={speed ?? ''}
        disabled={busy || speed === undefined} onClick={() => setOpen(value => !value)}
        title="Candidate transport preference; OpenAI validates availability. Applies to the next request in this conversation."
        style={{height:28,fontSize:13,lineHeight:'20px',fontWeight:400,padding:'0 4px 0 8px',color:'var(--dsw-alias-label-secondary)'}}>
        Speed {speed ? label(speed) : '…'}<IconChevronDownOutlineRegular size={12} />
      </Button>}
      onSelect={async id => {
        setOpen(false); setBusy(true); setError(false);
        const generation = lifetime.current;
        try { await rpc<Speed>('setSpeed', [sessionId, id]); } catch { if (generation === lifetime.current) setError(true); }
        finally { if (generation === lifetime.current) setBusy(false); }
      }} />{(error || offline) && <span role="alert">Could not load/save speed. <Button size="sm" disabled={busy} onClick={() => {
      setError(false); setReload(value => value + 1);
    }}>Retry</Button></span>}
  </span>;
}
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionHandle;
  const rpc: Rpc = async <T,>(method: string, args: unknown[] = [], signal?: AbortSignal) => {
    const names: Record<string, string[]> = { status: [], start: [], cancel: ['attempt'], getSpeed: ['sessionId'], watchSpeed: ['sessionId', 'after'], setSpeed: ['sessionId', 'speed'] };
    const result = await connection.rpc.call('/api', `cleangpt/${method}`, { args: Object.fromEntries((names[method] ?? []).map((name, i) => [name, args[i]])) }, signal);
    if (!result.ok) throw new Error('ChatGPT controls unavailable');
    return result.value as T;
  };
  const subscribeReset = (listener: () => void) => ctx.on('connection/reset', listener);
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer', id: 'cleangpt-account', inject: () => ({ rpc }),
  }, AccountPanel));
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'cleangpt-speed', inject: sessionId => ({ rpc, sessionId, subscribeReset }),
  }, props => <SpeedSelect key={props.sessionId} {...props} />));
}
