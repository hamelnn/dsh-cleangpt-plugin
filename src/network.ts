import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
export function normalizeProxy(value: string): string {
  if (!value.trim()) return '';
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('代理地址须为完整的 HTTP/HTTPS 地址，例如 http://127.0.0.1:7897'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('代理地址仅支持 HTTP/HTTPS，不可包含账号、密码、路径或查询参数');
  return url.origin;
}
export const networkDomain = defineDomain({ name: 'cleangpt_network', version: 1,
  tables: { settings: domainTable(z.object({ proxyUrl: z.string() })) } });
export interface NetworkTable { get(id: string): { proxyUrl: string } | undefined; put(id: string, value: { proxyUrl: string }): Promise<void>; }
export interface ProxyView { proxyUrl: string; }
export class NetworkSettings {
  constructor(private readonly table: Promise<NetworkTable>, private readonly fallback = '') {}
  async get(): Promise<ProxyView> { return { proxyUrl: (await this.table).get('model')?.proxyUrl ?? this.fallback }; }
  async set(proxyUrl: string): Promise<ProxyView> {
    const value = { proxyUrl: normalizeProxy(z.string().max(2048).parse(proxyUrl)) };
    await (await this.table).put('model', value);
    return value;
  }
}

