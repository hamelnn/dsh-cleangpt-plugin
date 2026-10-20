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
import type { ProxyView } from './network.js';
import { speedLabel } from './labels.js';

export const inject = ['slots', 'connection'];
interface Rpc { <T>(method: string, args?: unknown[], signal?: AbortSignal): Promise<T>; }
export function AccountPanel({ rpc }: { rpc: Rpc }) {
  const [status, setStatus] = useState<SafeStatus>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const revision = useRef(0), action = useRef(false);
  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const refresh = async () => {
      if (!mounted) return;
      let delay = 1000;
      if (!action.current) {
        const generation = revision.current;
        try {
          const value = await rpc<SafeStatus>('status', [], controller.signal);
          if (mounted && generation === revision.current) { setStatus(value); setError(false); }
          delay = value.phase === 'pending' ? 1000 : 5000;
        } catch { if (mounted && generation === revision.current) setError(true); }
      }
      // Windows status checks validate the credential DACL using PowerShell.
      // Schedule only after completion, never accumulate overlapping checks.
      if (mounted) timer = setTimeout(() => void refresh(), delay);
    };
    void refresh();
    return () => { mounted = false; clearTimeout(timer); controller.abort(); };
  }, [rpc]);
  const run = async (method: string, args: unknown[] = [], signal?: AbortSignal) => {
    if (action.current) return;
    action.current = true; revision.current++;
    setBusy(true); setError(false);
    try { setStatus(await rpc<SafeStatus>(method, args)); } catch { setError(true); }
    finally { action.current = false; setBusy(false); }
  };
  return <section aria-label="ChatGPT 订阅" style={{padding:'12px', border:'1px solid #8885', borderRadius:12, display:"grid", gap:10, fontSize:14}}>
    <strong>ChatGPT 订阅</strong>
    <p style={{margin:0}} role="status">{status ? `${status.account === 'default' ? '默认账号' : status.account}： ${status.signedIn ? '已登录' : '未登录'} · ${({idle:'就绪',pending:'等待授权',failed:'授权失败',cancelled:'已取消'})[status.phase]}` : '加载中…'}</p>
    {status?.signedIn && <p style={{margin:0}}>{status.permission ? '已保存订阅授权，实际可用模型与功能由 OpenAI 确认。' : '缺少订阅授权，请重新授权。'}</p>}
    {status?.renewalUncertain && <p style={{margin:0}} role="alert">授权续期状态不确定，请重新授权此账号。</p>}
    <p style={{margin:0}}>点击下方按钮，在运行 DSH 的电脑浏览器中打开 ChatGPT 官方授权页面。授权后可使用订阅额度。</p>
    <Button variant="outline" size="sm" disabled={busy || !status || status.phase === 'pending'} onClick={() => void run('start')}>{status?.signedIn ? '重新授权 ChatGPT' : '使用 ChatGPT 授权登录'}</Button>
    {status?.attempt && <Button variant="outline" size="sm" disabled={busy} onClick={() => void run('cancel', [status.attempt])}>取消授权</Button>}
    {(error || status?.phase === 'failed') && <p style={{margin:0}} role="alert">授权未完成或被拒绝，请重试并检查运行 DSH 的电脑浏览器。</p>}
    <ProxyPanel rpc={rpc} />
  </section>;
}
export function ProxyPanel({ rpc }: { rpc: Rpc }) {
  const [value, setValue] = useState(''), [saved, setSaved] = useState<string>();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    rpc<ProxyView>('getProxy').then(result => { if (active) { setValue(result.proxyUrl); setSaved(result.proxyUrl); } }, () => { if (active) setMessage('无法读取代理设置，请重新打开模型页。'); });
    return () => { active = false; };
  }, [rpc]);
  const save = async () => {
    setBusy(true); setMessage('');
    try {
      const url = value.trim();
      if (url) {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('invalid');
      }
      const result = await rpc<ProxyView>('setProxy', [url]);
      setSaved(result.proxyUrl); setValue(result.proxyUrl); setMessage('已保存，下一次模型请求生效。');
    } catch { setMessage('保存失败，请填写有效的 HTTP/HTTPS 代理地址和端口，并检查连接。'); }
    finally { setBusy(false); }
  };
  return <div style={{display:'grid',gap:8,borderTop:'1px solid #8885',paddingTop:12}}>
    <strong>GPT 订阅模型代理</strong>
    <label>代理地址（含端口）<input aria-label="代理地址（含端口）" value={value} disabled={busy || saved === undefined} onChange={event => setValue(event.target.value)} placeholder="http://127.0.0.1:7897" style={{display:'block',boxSizing:'border-box',width:'100%',padding:8,marginTop:6,border:'1px solid #8885',borderRadius:6,background:'transparent',color:'inherit'}} /></label>
    <p style={{margin:0}}>例如 http://127.0.0.1:7897，其中 7897 为代理端口。地址以运行 DSH 的电脑为准；留空使用 DSH 的网络设置。</p>
    <p style={{margin:0}} role="status">{saved === undefined ? '正在读取代理设置…' : saved ? `当前模型请求通过代理：${saved}` : '当前模型请求使用 DSH 网络设置'}</p>
    <p style={{margin:0}}>用于 GPT 模型列表与订阅对话。登录授权和自动续期使用 DSH 的网络设置。</p>
    <Button variant="outline" size="sm" disabled={busy || saved === undefined} onClick={() => void save()}>{busy ? '正在保存…' : '保存代理设置'}</Button>
    {message && <p style={{margin:0}} role="status">{message}</p>}
  </div>;
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
  const label = speedLabel;
  return <span>
    <Menu open={open} portal compact side="top" selectedId={speed} onClose={() => setOpen(false)}
      items={choices.map(id => ({ id, label: id === 'auto' ? label(id) : `${label(id)}（需账号支持）`, disabled: busy || speed === undefined }))}
      anchor={<Button variant="ghost" size="sm" aria-label={`ChatGPT 加速： ${speed ? label(speed) : '加载中'}`}
        aria-haspopup="menu" aria-expanded={open} aria-busy={busy} data-cleangpt-speed={speed ?? ''}
        disabled={busy || speed === undefined} onClick={() => setOpen(value => !value)}
        title="加速与推理强度分别设置。所选加速档位需模型与账号支持，从本会话下一次请求生效。"
        style={{height:28,fontSize:13,lineHeight:'20px',fontWeight:400,padding:'0 4px 0 8px',color:'var(--dsw-alias-label-secondary)'}}>
        加速 {speed ? label(speed) : '…'}<IconChevronDownOutlineRegular size={12} />
      </Button>}
      onSelect={async id => {
        setOpen(false); setBusy(true); setError(false);
        const generation = lifetime.current;
        try { await rpc<Speed>('setSpeed', [sessionId, id]); } catch { if (generation === lifetime.current) setError(true); }
        finally { if (generation === lifetime.current) setBusy(false); }
      }} />{(error || offline) && <span role="alert">无法读取或保存加速设置。 <Button size="sm" disabled={busy} onClick={() => {
      setError(false); setReload(value => value + 1);
    }}>重试</Button></span>}
  </span>;
}
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionHandle;
  const rpc: Rpc = async <T,>(method: string, args: unknown[] = [], signal?: AbortSignal) => {
    const names: Record<string, string[]> = { getProxy: [], setProxy: ['proxyUrl'], status: [], start: [], cancel: ['attempt'], getSpeed: ['sessionId'], watchSpeed: ['sessionId', 'after'], setSpeed: ['sessionId', 'speed'] };
    const result = await connection.rpc.call('/api', `cleangpt/${method}`, { args: Object.fromEntries((names[method] ?? []).map((name, i) => [name, args[i]])) }, signal);
    if (!result.ok) throw new Error('ChatGPT 设置暂时不可用');
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
