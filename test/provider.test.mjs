// All identity/token/bearer values in this file are synthetic fixtures; no real credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { ChatGPTPlanAdapter, requestBody, apply } from '../dist/index.js';

const options = { provider: 'chatgpt-plan', model: 'server-future-model', messages: [{ role: 'system', content: [{ type: 'text', text: 'DSH rules' }] }, { role: 'user', content: [{ type: 'text', text: 'hello' }] }] };
const output = [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '你好', annotations: [] }] }];
const done = (items = output) => ({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: items, usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 8 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 3 }, total_tokens: 29 } } });
const delta = { type: 'response.output_text.delta', item_id: 'msg_1', content_index: 0, output_index: 0, delta: '你好' };
const sse = events => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'req_mock' } });
function adapter(events, observe = () => {}) {
  return new ChatGPTPlanAdapter({ token: async () => 'mock-only-bearer', fetch: async (url, init) => { observe(url, init); return sse(events); } });
}
const collect = async stream => Array.fromAsync(stream);

test('complete text stream, exact wire restrictions, attribution, disjoint usage', async () => {
  const chunks = await collect(adapter([delta, done()], (url, init) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body);
    assert.equal(body.store, false); assert.equal(body.stream, true);
    assert.equal(body.model, options.model); assert.deepEqual(body.input[0], { role: 'developer', content: 'DSH rules' });
    assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    for (const key of ['previous_response_id', 'temperature', 'max_output_tokens', 'metadata', 'user', 'conversation']) assert.equal(key in body, false);
    assert.match(new Headers(init.headers).get('user-agent'), /deepseek-harness/);
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer mock-only-bearer');
  }).stream(options));
  assert.deepEqual(chunks.find(x => x.type === 'usage').usage, { inputTokens: 12, cacheReadTokens: 8, outputTokens: 9, totalTokens: 29, reasoningTokens: 3 });
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.equal(chunks.find(x => x.type === 'block-end').block.text, '你好');
});

test('all model/effort/tier strings pass through with no coercion or fallback', () => {
  const body = requestBody({ ...options, reasoningEffort: 'future-effort' }, { reasoningEffort: 'low', serviceTier: 'future-tier' });
  assert.equal(body.reasoning.effort, 'future-effort'); assert.equal(body.service_tier, 'future-tier');
  const defaults = requestBody(options, {}); assert.equal('reasoning' in defaults, false); assert.equal('service_tier' in defaults, false);
});

test('namespace tool call, encrypted reasoning replay and complete tool-result round trip', async () => {
  const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', namespace: 'dsh', name: 'echo', arguments: '{"s":"hi"}', status: 'completed' };
  const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-mock', summary: [] };
  const tools = [{ name: 'echo', description: 'echo text', parameters: { type: 'object', properties: { s: { type: 'string' } } } }];
  const chunks = await collect(adapter([
    { type: 'response.output_item.added', item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"s":"hi"}' },
    { type: 'response.output_item.done', item }, done([reasoning, item])
  ]).stream({ ...options, tools }));
  const finish = chunks.at(-1); assert.equal(finish.reason.kind, 'tool-calls');
  const body = requestBody({ ...options, tools, messages: [...options.messages, { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'echo', arguments: item.arguments }], source: { provider: options.provider, model: options.model, replayState: finish.replayState } }, { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'hi' }] }] }, {});
  assert.deepEqual(body.input.slice(-3), [reasoning, item, { type: 'function_call_output', call_id: 'call_1', output: 'hi' }]);
  assert.equal(body.tools[0].type, 'namespace'); assert.equal(body.tools[0].name, 'dsh'); assert.equal(body.tools[0].tools[0].name, 'echo');
});

for (const type of ['response.failed', 'response.incomplete', 'error']) test(`stream ${type} never reports success`, async () => {
  const event = type === 'error' ? { type, code: 'unsupported_capability', param: 'service_tier' } : { type, response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } };
  const chunks = []; await assert.rejects(async () => { for await (const chunk of adapter([delta, event]).stream(options)) chunks.push(chunk); });
  assert.equal(chunks.some(x => x.type === 'finish' && x.reason.kind === 'stop'), false);
});
test('truncated stream errors even after text is visible', async () => { await assert.rejects(collect(adapter([delta]).stream(options)), /before response.completed/); });
test('HTTP errors retain status, code, param, request ID and original structured cause; no retries', async () => {
  let calls = 0;
  const a = new ChatGPTPlanAdapter({ token: async () => 'mock', fetch: async () => { calls++; return new Response(JSON.stringify({ error: { code: 'unsupported_capability', param: 'service_tier', message: 'unavailable' } }), { status: 403, headers: { 'Content-Type': 'application/json', 'x-request-id': 'req_denied' } }); } });
  await assert.rejects(collect(a.stream(options)), error => error.failure.status === 403 && error.failure.requestId === 'req_denied' && error.cause.param === 'service_tier' && /service_tier/.test(error.message));
  assert.equal(calls, 1);
});
test('pre-aborted call makes no credential or network request', async () => {
  let calls = 0; const controller = new AbortController(); controller.abort();
  const a = new ChatGPTPlanAdapter({ token: async () => { calls++; return 'mock'; } });
  await assert.rejects(collect(a.stream({ ...options, signal: controller.signal }))); assert.equal(calls, 0);
});
test('early consumer disposal aborts upstream request', async () => {
  let wireSignal;
  for await (const chunk of adapter([delta, done()], (_, init) => { wireSignal = init.signal; }).stream(options)) { if (chunk.type === 'text-delta') break; }
  assert.equal(wireSignal.aborted, true);
});
test('undeclared namespaces and tool calls fail before DSH execution', async () => {
  await assert.rejects(collect(adapter([{ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc', call_id: 'c', namespace: 'other', name: 'shell', arguments: '' } }]).stream(options)), /undeclared/);
});
test('unsupported request options/content fail before HTTP', () => {
  for (const field of ['maxTokens', 'temperature', 'stop']) assert.throws(() => requestBody({ ...options, [field]: field === 'stop' ? [] : 1 }, {}), /does not support|cannot enforce maxTokens/);
  assert.throws(() => requestBody({ ...options, messages: [{ role: 'user', content: [{ type: 'image' }] }] }, {}), /cannot serialize image/);
});
test('dynamic account catalog preserves order and filters visibility without claiming entitlement', async () => {
  const a = new ChatGPTPlanAdapter({ token: async () => 'mock', fetch: async url => { assert.equal(String(url), 'https://api.openai.com/v1/models'); return Response.json({ models: [{ slug: 'future-b', display_name: 'B', visibility: 'list' }, { slug: 'hidden', display_name: 'H', visibility: 'hide' }, { slug: 'future-a', display_name: 'A', visibility: 'list' }] }); } });
  assert.deepEqual((await a.listModels(options.provider)).map(m => m.id), ['future-b', 'future-a']);
  assert.equal((await a.resolveModel(options.provider, 'not-in-catalog')).id, 'not-in-catalog');
});
test('Cordis native service registers and unloads only this route', async () => {
  const ctx = new Context(); ctx.plugin(LlmRuntime);
  const directory = await mkdtemp(join(tmpdir(), 'cleangpt-domain-'));
  await ctx.plugin(Storage); await ctx.plugin(JsonStorage, { root: directory });
  await ctx.plugin(DomainStorage, { backend: 'json' });
  let ready; const mounted = new Promise(resolve => { ready = resolve; });
  const fiber = ctx.plugin({ name: 'test-mount', inject: ['llm', 'storageDomain'], apply(c) { apply(c, { account: 'mock', authDir: '/unused', reasoningEffort: '', reasoningEfforts: [], allowUncappedAuxiliary: false }); ready(); } });
  await mounted;
  assert.equal(ctx.llm.listProviders().some(p => p.id === 'chatgpt-plan'), true);
  await fiber.dispose(); assert.equal(ctx.llm.listProviders().some(p => p.id === 'chatgpt-plan'), false); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true });
});

test('DSH prepares configured reasoning choices and records its default before dispatch', async () => {
  const ctx = new Context(); ctx.plugin(LlmRuntime);
  const a = new ChatGPTPlanAdapter({ reasoningEffort: 'high', reasoningEfforts: ['high', 'future-effort'], token: async () => 'mock', fetch: async () => sse([delta, done()]) });
  const llm = await new Promise(resolve => ctx.inject(['llm'], c => { resolve(c.llm); }));
  const dispose = llm.registerAdapter([options.provider], a);
  try {
    const prepared = await ctx.llm.prepareCall({ provider: options.provider, model: options.model });
    assert.equal(prepared.config.reasoningEffort, 'high');
    const explicit = await ctx.llm.prepareCall({ provider: options.provider, model: options.model, reasoningEffort: 'future-effort' });
    assert.equal(explicit.config.reasoningEffort, 'future-effort');
    assert.equal(prepared.retryPolicy.maxRetries, 2); assert.deepEqual(prepared.retryPolicy.retryableCodes, ['SERVER_UNAVAILABLE']);
  } finally { dispose(); await ctx.fiber.dispose(); }
});
test('mid-stream user abort reaches the SDK request and cannot produce success', async () => {
  const controller = new AbortController(); let wireSignal;
  const a = new ChatGPTPlanAdapter({ token: async () => 'mock', fetch: async (_, init) => {
    wireSignal = init.signal;
    return new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode(`event: ${delta.type}\ndata: ${JSON.stringify(delta)}\n\n`));
        init.signal.addEventListener('abort', () => stream.error(init.signal.reason), { once: true });
      }
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  await assert.rejects(async () => { for await (const chunk of a.stream({ ...options, signal: controller.signal })) if (chunk.type === 'text-delta') controller.abort(); });
  assert.equal(wireSignal.aborted, true);
});
test('completed response without content is an explicit error', async () => {
  await assert.rejects(collect(adapter([done([])]).stream(options)), /without content/);
});

test('published Schemastery defaults are plain plugin configuration', async () => {
  const plugin = await import('../dist/index.js');
  const config = plugin.Config({});
  assert.equal(config.account, 'default'); assert.equal(config.serviceTier, ''); assert.deepEqual(config.reasoningEfforts, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});
test('incomplete terminal events report available usage before failure', async () => {
  const chunks = [], incomplete = { ...done(), type: 'response.incomplete' };
  await assert.rejects(async () => { for await (const chunk of adapter([delta, incomplete]).stream(options)) chunks.push(chunk); });
  assert.equal(chunks.find(c => c.type === 'usage').usage.inputTokens, 12);
});

for (const scenario of ['missing-final', 'duplicate-final', 'duplicate-added', 'duplicate-done', 'missing-done', 'late-delta', 'mismatched-final']) test(`tool lifecycle refuses ${scenario} without a successful finish`, async () => {
  const item = { type: 'function_call', id: 'fc', call_id: 'call', namespace: 'dsh', name: 'echo', arguments: '{}', status: 'completed' };
  const added = { type: 'response.output_item.added', item: { ...item, arguments: '' } };
  const args = { type: 'response.function_call_arguments.delta', item_id: 'fc', delta: '{}' };
  const ended = { type: 'response.output_item.done', item };
  const events = [added, args, ended];
  let final = [item];
  if (scenario === 'missing-final') final = [];
  if (scenario === 'duplicate-final') final = [item, item];
  if (scenario === 'duplicate-added') events.splice(1, 0, added);
  if (scenario === 'duplicate-done') events.push(ended);
  if (scenario === 'missing-done') events.pop();
  if (scenario === 'late-delta') events.push(args);
  if (scenario === 'mismatched-final') final = [{ ...item, arguments: '{"changed":true}' }];
  events.push(done(final));
  const chunks = [];
  await assert.rejects(async () => { for await (const chunk of adapter(events).stream({ ...options, tools: [{ name: 'echo', description: '', parameters: {} }] })) chunks.push(chunk); }, error => error.code === 'PROTOCOL');
  assert.equal(chunks.some(c => c.type === 'finish'), false);
});
test('rewritten assistant history never replays stale encrypted content', async () => {
  const chunks = await collect(adapter([delta, done()]).stream(options));
  const body = requestBody({ ...options, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'changed' }], source: { provider: options.provider, model: options.model, replayState: chunks.at(-1).replayState } }] }, {});
  assert.deepEqual(body.input, [{ role: 'assistant', content: 'changed' }]);
});

for (const purpose of ['compaction', 'session-title']) test(`DSH prepared ${purpose} call runs only with explicit uncapped policy, warns, and omits prohibited cap`, async () => {
  const warnings = []; let sent;
  const ctx = new Context(); ctx.plugin(LlmRuntime);
  const llm = await new Promise(resolve => ctx.inject(['llm'], c => { resolve(c.llm); }));
  const a = new ChatGPTPlanAdapter({ allowUncappedAuxiliary: true, onWarning: warning => warnings.push(warning), token: async () => 'mock', fetch: async (_, init) => { sent = JSON.parse(init.body); return sse([delta, done()]); } });
  const dispose = llm.registerAdapter([options.provider], a);
  try {
    const call = await llm.prepareCall({ provider: options.provider, model: options.model, maxTokens: 128 });
    const chunks = await collect(call.stream({ ...call.config, messages: options.messages, purpose }));
    assert.equal(chunks.at(-1).reason.kind, 'stop'); assert.equal(sent.model, options.model);
    assert.equal('max_output_tokens' in sent, false); assert.equal('maxTokens' in sent, false);
    assert.equal(warnings.length, 1); assert.match(warnings[0], /maxTokens=128 is NOT enforced/);
    assert.equal(call.config.maxTokens, 128); // DSH's logged request remains unchanged; no false server-cap claim.
    assert.throws(() => requestBody({ ...options, maxTokens: 128, purpose }, {}), /explicit allowUncappedAuxiliary/);
    assert.throws(() => requestBody({ ...options, maxTokens: 128 }, { allowUncappedAuxiliary: true }), /cannot enforce/);
  } finally { dispose(); await ctx.fiber.dispose(); }
});
test('interrupted reasoning summary can resume as assistant context without fabricated encrypted replay', async () => {
  const { BlockAssembler } = await import('@deepseek-ai/dsh-llm');
  const controller = new AbortController(); const assembler = new BlockAssembler();
  const summary = { type: 'response.reasoning_summary_text.delta', item_id: 'rs', summary_index: 0, output_index: 0, delta: 'Partial visible summary' };
  const a = adapter([summary]);
  await assert.rejects(async () => {
    for await (const chunk of a.stream({ ...options, signal: controller.signal })) {
      assembler.push(chunk); if (chunk.type === 'reasoning-delta') controller.abort();
    }
  });
  const body = requestBody({ ...options, messages: [{ role: 'assistant', content: assembler.interruptedBlocks(), source: { provider: options.provider, model: options.model } }, options.messages[1]] }, {});
  assert.equal(body.input[0].role, 'assistant'); assert.match(body.input[0].content, /Partial visible summary/);
  assert.equal(JSON.stringify(body.input).includes('encrypted_content'), false);
});
test('foreign-provider text and reasoning history preserve visible context as assistant messages', () => {
  const body = requestBody({ ...options, messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'Prior summary' }, { type: 'text', text: 'Prior answer' }], source: { provider: 'other', model: 'other' } }] }, {});
  assert.deepEqual(body.input.map(item => item.role), ['assistant', 'assistant']);
  assert.match(body.input[0].content, /Prior summary/); assert.equal(body.input[1].content, 'Prior answer');
});

test('published package, lockfile, plugin identifier and CLI share the requested name', async () => {
  const fs = await import('node:fs/promises');
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await fs.readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const plugin = await import('../dist/index.js');
  assert.equal(pkg.name, 'dsh-cleangpt-plugin'); assert.equal(lock.name, pkg.name); assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(plugin.name, pkg.name); assert.deepEqual(Object.keys(pkg.bin), [pkg.name]);
  assert.equal(basename(plugin.Config({}).authDir), 'dsh-cleangpt-plugin');
});
