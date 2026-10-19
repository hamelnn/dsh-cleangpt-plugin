/** Native DSH Responses provider. DSH retains its loop and executes all tools. */
import OpenAI from 'openai';
import type { ResponseCreateParamsStreaming, ResponseInput, ResponseOutputItem } from 'openai/resources/responses/responses.js';
import { LlmAdapter, LlmError, ToolCallId, ProviderRequestId, attributionHeaders, projectToolUpdates, ReasoningEffortId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk, ContentBlock, LlmModelInfo } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import z from '@deepseek-ai/schemastery';
import { accessToken, defaultDirectory, AuthError } from './auth.js';
import { Controls, RequestSpeeds, sessionDomain } from './controls.js';

export const name = 'dsh-cleangpt-plugin';
export const inject = ['llm', 'storageDomain'];
export interface Config { account: string; authDir: string; reasoningEffort: string; reasoningEfforts: string[]; allowUncappedAuxiliary: boolean }
export const Config = z.object({
  account: z.string().default('default'),
  authDir: z.string().default(defaultDirectory),
  reasoningEffort: z.string().default(''),
  reasoningEfforts: z.array(z.string()).default([]),
  allowUncappedAuxiliary: z.boolean().default(false),
});
interface Options {
  account?: string; authDir?: string; reasoningEffort?: string; serviceTier?: string; reasoningEfforts?: string[];
  allowUncappedAuxiliary?: boolean; onWarning?: (message: string) => void;
  token?: (signal?: AbortSignal) => Promise<string>;
  fetch?: typeof globalThis.fetch;
  sessionSpeed?: (sessionId: string, signal?: AbortSignal) => Promise<string>;
}
const ROUTE = 'chatgpt-plan';
const NAMESPACE = 'dsh';
const API = 'https://api.openai.com/v1';

/** Return text without dropping unsupported model-visible blocks. */
function text(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => {
    if (block.type === 'text') return block.text;
    throw new LlmError(`ChatGPT plan text provider cannot serialize ${block.type}`, 'UNSUPPORTED_CONTENT');
  }).join('\n');
}

function uncappedAuxiliary(options: GenerateOptions, config: Options): boolean {
  return config.allowUncappedAuxiliary === true && (options.purpose === 'compaction' || options.purpose === 'session-title');
}

/** Project the complete DSH history; preserve native reasoning items on same-route replay. */
export function requestBody(options: GenerateOptions, config: Options): ResponseCreateParamsStreaming {
  if (options.maxTokens !== undefined && !uncappedAuxiliary(options, config)) throw new LlmError('ChatGPT plan cannot enforce maxTokens; auxiliary calls require explicit allowUncappedAuxiliary: true (no server output cap)', 'UNSUPPORTED_OPTION');
  for (const field of ['temperature', 'stop'] as const)
    if (options[field] !== undefined) throw new LlmError(`ChatGPT plan does not support ${field}; remove it from this route`, 'UNSUPPORTED_OPTION');
  const projected = projectToolUpdates(options.messages, options.tools, undefined, options.toolHistory);
  const input: ResponseInput = [];
  if (options.system) input.push({ role: 'developer', content: options.system });
  for (const message of projected.messages) {
    if (message.role === 'assistant') {
      const replay = message.source.provider === options.provider && message.source.model === options.model
        ? message.source.replayState : undefined;
      if (isReplay(replay) && JSON.stringify(replay.response.content) === JSON.stringify(message.content)) { input.push(...replay.response.output); continue; }
      for (const block of message.content) {
        if (block.type === 'tool-call') input.push({ type: 'function_call', namespace: NAMESPACE, call_id: block.id, name: block.name, arguments: block.arguments });
        else if (block.type === 'text' || block.type === 'reasoning') input.push({ role: 'assistant', content: block.type === 'reasoning' ? `[Prior reasoning summary]\n${block.text}` : block.text });
        else throw new LlmError('Assistant history contains unsupported content', 'UNSUPPORTED_CONTENT');
      }
    } else if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: text(message.content) });
    } else input.push({ role: message.role === 'system' ? 'developer' : message.role, content: text(message.content) });
  }
  const effort = options.reasoningEffort ?? config.reasoningEffort;
  return {
    model: options.model, input, store: false, stream: true,
    include: ['reasoning.encrypted_content'],
    ...(effort ? { reasoning: { effort: effort as NonNullable<ResponseCreateParamsStreaming['reasoning']>['effort'] } } : {}),
    // Opaque configured values intentionally reach OpenAI unchanged, including future values.
    ...(config.serviceTier ? { service_tier: config.serviceTier as ResponseCreateParamsStreaming['service_tier'] } : {}),
    ...(projected.tools?.length ? { tools: [{ type: 'namespace', name: NAMESPACE, description: 'Tools executed by DeepSeek Harness', tools: projected.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })) }] } : {}),
  };
}
type ReplayItem = Extract<ResponseOutputItem, { type: 'message' | 'reasoning' | 'function_call' }>;
interface Replay { version: 1; output: ReplayItem[]; content: ContentBlock[] }
function isReplay(value: unknown): value is { response: Replay } {
  if (typeof value !== 'object' || value === null || !('response' in value)) return false;
  value = value.response;
  return typeof value === 'object' && value !== null && 'version' in value && value.version === 1 && 'output' in value && Array.isArray(value.output) && 'content' in value && Array.isArray(value.content);
}

function usageChunk(usage: NonNullable<import('openai/resources/responses/responses.js').Response['usage']>): StreamChunk {
  return { type: 'usage', usage: { inputTokens: usage.input_tokens - (usage.input_tokens_details?.cached_tokens ?? 0), cacheReadTokens: usage.input_tokens_details?.cached_tokens ?? 0, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens, reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0 } };
}

/** Official SDK handles SSE parsing; this layer maps events to DSH chunks. */
export class ChatGPTPlanAdapter extends LlmAdapter {
  private readonly requestSpeeds = new WeakMap<object, Promise<string>>();
  constructor(private readonly config: Options = {}) { super(); }
  providerInfo(provider: string) { return { id: provider, name: `dsh-cleangpt-plugin (${this.config.account ?? 'default'})` }; }
  private async client(signal?: AbortSignal) {
    let token: string;
    try { token = await (this.config.token?.(signal) ?? accessToken(this.config.authDir, this.config.account, signal)); }
    catch (error) { if (error instanceof AuthError) throw new LlmError(error.message, error.code, { cause: error }); throw error; }
    return new OpenAI({ apiKey: token, baseURL: API, maxRetries: 0, timeout: 300_000,
      fetch: this.config.fetch, organization: null, project: null, logLevel: 'off', fetchOptions: { redirect: 'error' }, defaultHeaders: attributionHeaders() });
  }
  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const client = await this.client();
    const result = await client.get<{ models: { slug: string; display_name: string; visibility: string }[] }>('/models');
    if (!Array.isArray(result.models)) throw new LlmError('Invalid ChatGPT model catalog', 'PROTOCOL');
    return result.models.filter(m => m.visibility === 'list' && typeof m.slug === 'string').map(m => ({ provider, id: m.slug, name: m.display_name || m.slug, inputModalities: ['text'] }));
  }
  providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 2, retryableCodes: ['SERVER_UNAVAILABLE'] }, ROUTE); }
  async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    // Catalog membership does not establish entitlement; unknown slugs can reach the server.
    const efforts = [...new Set([...(this.config.reasoningEfforts ?? []), ...(this.config.reasoningEffort ? [this.config.reasoningEffort] : [])])];
    return { provider, id: model, name: model, inputModalities: ['text'] as const, ...(efforts.length ? { reasoning: { efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: `${id} (server validates)` })), ...(this.config.reasoningEffort ? { defaultEffort: ReasoningEffortId(this.config.reasoningEffort) } : {}) } } : {}) };
  }
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    options.signal?.throwIfAborted();
    // Freeze once before credential lookup/network I/O; never re-read during the request.
    let speed = this.requestSpeeds.get(options);
    if (!speed) {
      speed = options.sessionId && this.config.sessionSpeed ? this.config.sessionSpeed(options.sessionId, options.signal) : Promise.resolve('auto');
      this.requestSpeeds.set(options, speed);
    }
    const body = requestBody(options, { ...this.config, serviceTier: await speed });
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let requestId: string | undefined;
    const blocks = new Map<string, { index: number; block: ContentBlock }>();
    const toolIds = new Set<string>(), doneTools = new Set<string>();
    let index = 0, completed = false, hasTools = false;
    const begin = (key: string, block: ContentBlock): StreamChunk => {
      const entry = { index: index++, block }; blocks.set(key, entry);
      return { type: 'block-start', index: entry.index, blockType: block.type };
    };
    try {
      signal.throwIfAborted();
      if (options.maxTokens !== undefined && uncappedAuxiliary(options, this.config)) (this.config.onWarning ?? console.warn)(`ChatGPT plan ${options.purpose}: requested maxTokens=${options.maxTokens} is NOT enforced; explicit uncapped auxiliary policy omits the unsupported server output cap.`);
      const client = await this.client(signal);
      const result = await client.responses.create(body, { signal }).withResponse();
      requestId = result.request_id ?? undefined;
      for await (const event of result.data) {
        signal.throwIfAborted();
        if (event.type === 'response.output_item.added' && event.item.type === 'function_call') {
          const item = event.item;
          if (!item.id || !item.call_id || blocks.has(item.id) || toolIds.has(item.call_id)) throw new LlmError('Missing or duplicate tool item/call ID', 'PROTOCOL');
          toolIds.add(item.call_id);
          if (item.namespace !== NAMESPACE || !options.tools?.some(t => t.name === item.name))
            throw new LlmError('OpenAI returned an undeclared tool or namespace', 'PROTOCOL');
          hasTools = true;
          yield begin(item.id!, { type: 'tool-call', id: ToolCallId(item.call_id), name: item.name, arguments: '' });
        } else if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta' || event.type === 'response.reasoning_summary_text.delta') {
          const reasoning = event.type === 'response.reasoning_summary_text.delta';
          const key = `${event.item_id}:${reasoning ? 'r' : 't'}:${'summary_index' in event ? event.summary_index : event.content_index}`;
          if (!blocks.has(key)) yield begin(key, reasoning ? { type: 'reasoning', text: '' } : { type: 'text', text: '' });
          const entry = blocks.get(key)!;
          if (entry.block.type === 'text' || entry.block.type === 'reasoning') entry.block.text += event.delta;
          yield { type: reasoning ? 'reasoning-delta' : 'text-delta', index: entry.index, text: event.delta };
        } else if (event.type === 'response.function_call_arguments.delta') {
          const entry = blocks.get(event.item_id);
          if (doneTools.has(event.item_id)) throw new LlmError('Tool delta after item completion', 'PROTOCOL');
          if (!entry || entry.block.type !== 'tool-call') throw new LlmError('Tool delta without a declared call', 'PROTOCOL');
          entry.block.arguments += event.delta;
          yield { type: 'tool-call-delta', index: entry.index, id: entry.block.id, name: entry.block.name, argumentsDelta: event.delta };
        } else if (event.type === 'response.output_item.done' && event.item.type === 'function_call') {
          const entry = blocks.get(event.item.id!);
          if (doneTools.has(event.item.id!)) throw new LlmError('Duplicate completed tool item', 'PROTOCOL');
          if (!entry || entry.block.type !== 'tool-call' || entry.block.arguments !== event.item.arguments || entry.block.name !== event.item.name || entry.block.id !== event.item.call_id || event.item.namespace !== NAMESPACE)
            throw new LlmError('Incomplete tool argument stream', 'PROTOCOL');
          doneTools.add(event.item.id!);
        } else if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') {
          if (event.type !== 'error' && event.response.usage) yield usageChunk(event.response.usage);
          const detail = event.type === 'error' ? event : event.response.error;
          const code = detail?.code ?? (event.type === 'response.incomplete' ? 'INCOMPLETE' : 'RESPONSE_FAILED');
          throw new LlmError(`ChatGPT plan: ${code}${detail && 'param' in detail && detail.param ? ` (parameter: ${detail.param})` : ''}`, code, { requestId: requestId ? ProviderRequestId(requestId) : undefined, cause: event });
        } else if (event.type === 'response.completed') {
          if (event.response.status !== 'completed') throw new LlmError('Response status was not completed', 'PROTOCOL');
          if (blocks.size === 0) throw new LlmError('Response completed without content or tool calls', 'EMPTY_RESPONSE');
          const finalTools = event.response.output.filter(item => item.type === 'function_call');
          if (finalTools.length !== toolIds.size || new Set(finalTools.map(item => item.id)).size !== finalTools.length || new Set(finalTools.map(item => item.call_id)).size !== finalTools.length) throw new LlmError('Missing or duplicate tool items in completed response', 'PROTOCOL');
          for (const item of finalTools) {
            const streamed = blocks.get(item.id!)?.block;
            if (!doneTools.has(item.id!) || item.namespace !== NAMESPACE || streamed?.type !== 'tool-call' || streamed.id !== item.call_id || streamed.name !== item.name || streamed.arguments !== item.arguments) throw new LlmError('Completed tool call does not match streamed declaration', 'PROTOCOL');
          }
          for (const entry of blocks.values()) yield { type: 'block-end', index: entry.index, block: entry.block };
          const usage = event.response.usage;
          if (usage) yield usageChunk(usage);
          if (!event.response.output.every((item): item is ReplayItem => ['message', 'reasoning', 'function_call'].includes(item.type))) throw new LlmError('Unsupported output item in Responses stream', 'UNSUPPORTED_CONTENT');
          completed = true;
          yield { type: 'finish', reason: { kind: hasTools ? 'tool-calls' : 'stop' }, replayState: { response: { version: 1, output: event.response.output, content: [...blocks.values()].map(entry => entry.block) } satisfies Replay } };
          return;
        }
      }
      if (!completed) throw new LlmError('Stream ended before response.completed', 'STREAM_TRUNCATED');
    } catch (error) {
      if (error instanceof OpenAI.APIError) throw new LlmError(`ChatGPT plan HTTP ${error.status ?? 'unknown'}: ${error.code ?? 'API_ERROR'}${error.param ? ` (parameter: ${error.param})` : ''}`, error.status === 503 ? 'SERVER_UNAVAILABLE' : error.code ?? 'API_ERROR', { status: error.status, requestId: error.requestID ? ProviderRequestId(error.requestID) : undefined, cause: error });
      throw error;
    } finally { controller.abort(); }
  }
}

/** Mount only a model route, with reversible Cordis ownership. */
export function apply(ctx: Context, config: Config): void {
  const domain = ctx.storageDomain.open(sessionDomain);
  ctx.effect(() => async () => { await (await domain).close(); });
  const sessions = domain.then(domain => domain.table('sessions'));
  sessions.catch(error => ctx.logger(name).error('Cannot open session speed storage: %s', error instanceof Error ? error.message : 'storage failure'));
  ctx.plugin(scope => { new Controls(scope, config, sessions); });
  const requests = new RequestSpeeds(sessions);
  ctx.on('agent/request', async ({ agent, turn, step, signal }, next) => {
    await requests.capture(agent.session.id, turn, step, signal);
    return next();
  });
  const adapter = new ChatGPTPlanAdapter({ ...config, sessionSpeed: async (id, signal) =>
    requests.read(id, signal),
    onWarning: message => ctx.logger(name).warn(message) });
  ctx.effect(() => ctx.llm.registerAdapter([ROUTE], adapter));
}
