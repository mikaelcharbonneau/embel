import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createLogoVectorProposalProvider, createLogoVectorProposalRequest } from '@/features/logo-vector/server/proposal-provider';
import { logoVectorProposalProviderResultSchema } from '@/domain/logo-vector-proposal-evidence';
import { OpenAITransportError } from '@/server/ai/openai-transport';
import { providerFixture, hash } from './logo-vector-proposal-provider-fixtures';
const setup = () => {
 const f = providerFixture(), controller = new AbortController();
 const dispatch = { job: f.job, beforeDispatch: vi.fn(async () => {}) };
 const provider = createLogoVectorProposalProvider({ configuration: f.configuration, transport: f.transport, acceptingWork: () => true, now: () => '2026-10-08T00:00:00Z' })!;
 return { ...f, controller, dispatch, provider, run: () => provider.propose(f.context, f.resolved.input.instruction, f.textPolicy, controller.signal, dispatch) };
};
afterEach(() => vi.unstubAllGlobals());
describe('disconnected vector text provider', () => {
 it('requires its exact explicit paid text configuration and dependencies', () => {
  const f = providerFixture();
  for (const options of [null, {}, { configuration: f.configuration }, { configuration: { paidCallsApproved: true }, transport: f.transport }, { configuration: { ...f.configuration, operation: 'strategy.reformulate' }, transport: f.transport }, { configuration: { ...f.configuration, paidCallsApproved: false }, transport: f.transport }, { configuration: { ...f.configuration, textPolicy: { ...f.textPolicy, maximumCostMicrousd: 0 } }, transport: f.transport }]) expect(createLogoVectorProposalProvider(options as never)).toBeNull();
 });
 it('counts the exact final bounded request once and prices observed usage independently', async () => {
  const f = setup(), result = await f.run();
  expect(result).toMatchObject({ kind: 'observed', result: { status: 'valid', payload: f.payload }, observation: { model: 'gpt-6.1-sol', toolCalls: 0, billing: { status: 'recorded', confirmedMicrousd: 68 } } });
  expect(logoVectorProposalProviderResultSchema.safeParse(result).success).toBe(true);
  expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
  expect(f.transport.countInputTokens.mock.calls[0]![0]).toEqual(f.transport.createResponse.mock.calls[0]![0]);
  const request = f.transport.createResponse.mock.calls[0]![0];
  expect(request).toMatchObject({ model: f.textPolicy.model, text: { format: { type: 'json_object' } }, tools: [], tool_choice: 'none', max_output_tokens: 4096, service_tier: 'default', stream: false, background: false, store: false, truncation: 'disabled' });
  expect(f.dispatch.beforeDispatch).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(request)).not.toMatch(/pathData|storagePath|apiKey|input_image/);
 });
 it('pins JSON mode, full schema and explicit one-command/multi-change instructions in the final request', () => {
  const f = setup(), request = createLogoVectorProposalRequest(f.context, f.resolved.input.instruction, f.textPolicy);
  expect(request.instructions).toMatch(/JSON/);
  expect(request.instructions).toMatch(/multiple_changes/);
  expect(request.instructions).toMatch(/exactly one/);
  expect(request.instructions).toMatch(/schema.*intent/i);
  expect(JSON.stringify(request)).toContain('synthetic-symbol');
 });
 it.each([NaN, -1, 32769, 1.5])('does not infer with invalid counted tokens %s', async count => {
  const f = setup(); f.transport.countInputTokens.mockResolvedValue(count);
  expect(await f.run()).toMatchObject({ kind: 'not_dispatched' }); expect(f.transport.createResponse).not.toHaveBeenCalled();
 });
 it('enforces the whole final prompt byte bound before counting', async () => {
  const f = setup(), policy = { ...f.textPolicy, maxInputBytes: 1024 };
  const provider = createLogoVectorProposalProvider({ configuration: { ...f.configuration, textPolicy: policy }, transport: f.transport })!;
  const job = { ...f.job, input: { ...f.resolved.input, textPolicy: policy } };
  expect(await provider.propose(f.context, f.resolved.input.instruction, policy, f.controller.signal, { ...f.dispatch, job })).toMatchObject({ kind: 'not_dispatched' });
  expect(f.transport.countInputTokens).not.toHaveBeenCalled();
 });
 it.each(['before', 'count', 'after'] as const)('fences cancellation %s counting', async where => {
  const f = setup();
  if (where === 'before') f.controller.abort();
  if (where === 'count') f.transport.countInputTokens.mockImplementation(async () => { f.controller.abort(); return 10; });
  if (where === 'after') f.dispatch.beforeDispatch.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { f.controller.abort(); });
  expect(await f.run()).toMatchObject({ kind: 'not_dispatched' }); expect(f.transport.createResponse).not.toHaveBeenCalled();
 });
 it('refuses a final readiness failure without any inference retry', async () => {
  const f = setup(); f.dispatch.beforeDispatch.mockResolvedValueOnce().mockRejectedValueOnce(new Error('lease lost'));
  expect(await f.run()).toMatchObject({ kind: 'not_dispatched' }); expect(f.transport.createResponse).not.toHaveBeenCalled();
 });
 it('retains a successful late response after cancellation', async () => {
  const f = setup(); f.transport.createResponse.mockImplementation(async () => { f.controller.abort(); return f.response(); });
  expect(await f.run()).toMatchObject({ kind: 'observed', observation: { billing: { confirmedMicrousd: 68 } }, result: { status: 'valid' } });
 });
 it.each(['request_rejected', 'outcome_unknown'] as const)('preserves uncertain acceptance after transport %s', async code => {
  const f = setup(); f.transport.createResponse.mockRejectedValue(new OpenAITransportError(code, 'synthetic_failed'));
  expect(await f.run()).toMatchObject({ kind: 'observed', observation: { providerRequestId: 'synthetic_failed', model: null, usage: null, billing: { status: 'unknown' } }, result: { status: 'incomplete' } });
  expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
 });
 it.each(['model', 'service_tier', 'usage'] as const)('retains observed evidence with missing %s without requested-model substitution', async field => {
  const f = setup(), response = f.response(); delete (response.body as Record<string, unknown>)[field]; f.transport.createResponse.mockResolvedValue(response);
  const result = await f.run(); expect(result).toMatchObject({ kind: 'observed', observation: { billing: { status: 'unknown' } } });
  if (result.kind === 'observed' && field === 'model') expect(result.observation.model).toBeNull();
 });
 it.each([['model', 'unexpected-model', 'model_mismatch'], ['service_tier', 'flex', 'service_tier_mismatch']] as const)('rejects wrong observed %s', async (field, value, reason) => {
  const f = setup(), response = f.response(); (response.body as Record<string, unknown>)[field] = value; f.transport.createResponse.mockResolvedValue(response);
  expect(await f.run()).toMatchObject({ kind: 'observed', observation: { billing: { status: 'unknown' } }, result: { reason } });
 });
 it.each(['failed', 'incomplete', 'in_progress', 'cancelled'])('retains known costs with response status %s', async status => {
  const f = setup(), response = f.response(); response.body.status = status; f.transport.createResponse.mockResolvedValue(response);
  expect(await f.run()).toMatchObject({ kind: 'observed', observation: { responseComplete: false, billing: { confirmedMicrousd: 68 } }, result: { status: 'incomplete' } });
 });
 it('records a charged explicit unsupported multi-change answer without artwork', async () => {
  const f = setup(), response = f.response(), payload = { version: 1, status: 'unsupported', code: 'multiple_changes', explanation: 'Request these controls separately.' };
  response.body.output[0]!.content[0]!.text = JSON.stringify(payload); f.transport.createResponse.mockResolvedValue(response);
  expect(await f.run()).toMatchObject({ kind: 'observed', result: { status: 'valid', payload }, observation: { billing: { confirmedMicrousd: 68 } } });
 });
 it.each(['{broken', JSON.stringify({ version: 1, status: 'proposed', edits: [] }), JSON.stringify({ version: 1, status: 'proposed', edit: { kind: 'text', componentId: 'synthetic-symbol', text: 'Forged' }, explanation: 'Bad' }), JSON.stringify({ version: 1, status: 'proposed', edit: { kind: 'rotation', componentId: 'invented', degrees: 10 }, explanation: 'Bad' }), JSON.stringify({ version: 1, status: 'proposed', edit: { kind: 'rotation', componentId: 'synthetic-symbol', degrees: 0 }, explanation: 'No-op' })])('retains invalid output and its exact known charge', async text => {
  const f = setup(), response = f.response(); response.body.output[0]!.content[0]!.text = text; f.transport.createResponse.mockResolvedValue(response);
  const result = await f.run(); expect(result).toMatchObject({ kind: 'observed', observation: { billing: { confirmedMicrousd: 68 } }, result: { status: 'invalid', retainedOutput: { data: Buffer.from(text).toString('base64'), sha256: hash(text), byteLength: Buffer.byteLength(text), truncated: false } } });
 });
 it('retains a bounded exact prefix/hash for oversized output and real usage', async () => {
  const f = setup(), response = f.response(), text = '🙂'.repeat(20000); response.body.output[0]!.content[0]!.text = text; f.transport.createResponse.mockResolvedValue(response);
  const result = await f.run(); expect(result).toMatchObject({ kind: 'observed', observation: { billing: { confirmedMicrousd: 68 } }, result: { reason: 'output_too_large', retainedOutput: { truncated: true, sha256: hash(text), byteLength: 80000 } } });
  if (result.kind === 'observed') expect(Buffer.from(result.result.retainedOutput.data, 'base64')).toHaveLength(32768);
 });
 it('retains provider refusal text with known usage', async () => {
  const f = setup(), response = f.response(); response.body.output[0]!.content = [{ type: 'refusal', refusal: 'Synthetic refusal.' }] as never; f.transport.createResponse.mockResolvedValue(response);
  expect(await f.run()).toMatchObject({ kind: 'observed', observation: { billing: { confirmedMicrousd: 68 } }, result: { status: 'refused', reason: 'provider_refusal' } });
 });
 it('does not price unknown tool output as a zero-tool response', async () => {
  const f = setup(), response = f.response(); response.body.output.push({ type: 'web_search_call', status: 'completed' } as never); f.transport.createResponse.mockResolvedValue(response);
  expect(await f.run()).toMatchObject({ kind: 'observed', observation: { toolCalls: 1, billing: { status: 'unknown' } }, result: { reason: 'unexpected_tools' } });
 });
 it('uses only fixed Responses URLs with redirects disabled and no retry', async () => {
  const f = providerFixture(), seen: { url: string; request: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, request: RequestInit) => { seen.push({ url, request }); return new Response(JSON.stringify(url.endsWith('/input_tokens') ? { input_tokens: 10 } : f.response().body), { status: 200 }); });
  const provider = createLogoVectorProposalProvider({ configuration: f.configuration, apiKey: 'synthetic-not-a-secret', acceptingWork: () => true })!;
  const result = await provider.propose(f.context, f.resolved.input.instruction, f.textPolicy, new AbortController().signal, { job: f.job, beforeDispatch: async () => {} });
  expect(result.kind).toBe('observed'); expect(seen.map(item => item.url)).toEqual(['https://api.openai.com/v1/responses/input_tokens', 'https://api.openai.com/v1/responses']);
  expect(seen.every(item => item.request.redirect === 'error')).toBe(true);
 });
});
it('stops the injected invocation at its last synchronous fence', async () => {
 const f = providerFixture(); let gates = 0;
 const provider = createLogoVectorProposalProvider({ configuration: f.configuration, transport: f.transport, acceptingWork: () => ++gates < 3 })!;
 expect(await provider.propose(f.context, f.resolved.input.instruction, f.textPolicy, new AbortController().signal, { job: f.job, beforeDispatch: async () => {} })).toMatchObject({ kind: 'not_dispatched' });
 expect(f.transport.countInputTokens).toHaveBeenCalledTimes(1); expect(f.transport.createResponse).not.toHaveBeenCalled(); expect(gates).toBe(3);
});
it('stops the built-in physical inference fetch after provider preflight passes', async () => {
 const f = providerFixture(); let gates = 0;
 const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/input_tokens') ? { input_tokens: 10 } : f.response().body))); vi.stubGlobal('fetch', fetcher);
 const provider = createLogoVectorProposalProvider({ configuration: f.configuration, apiKey: 'synthetic-not-a-secret', acceptingWork: () => ++gates < 4 })!;
 expect(await provider.propose(f.context, f.resolved.input.instruction, f.textPolicy, new AbortController().signal, { job: f.job, beforeDispatch: async () => {} })).toMatchObject({ kind: 'not_dispatched' });
 expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0]![0]).toBe('https://api.openai.com/v1/responses/input_tokens'); expect(gates).toBe(4);
});
it.each(['context', 'policy', 'claim'])('rejects changed %s after counting', async what => {
 const f = setup(); f.transport.countInputTokens.mockImplementation(async () => { if (what === 'context') f.context.brief.name = 'Changed'; else if (what === 'policy') f.textPolicy.maxOutputBytes = 1024; else f.job.leaseToken = '76100000-0000-4000-8000-000000000099'; return 10; });
 expect(await f.run()).toMatchObject({ kind: 'not_dispatched' }); expect(f.transport.createResponse).not.toHaveBeenCalled();
});
it('retains the exact observed response envelope hash', async () => {
 const f = setup(), result = await f.run();
 expect(result).toMatchObject({ kind: 'observed', observation: { responseHash: hash(JSON.stringify(f.response().body)), responseId: 'resp_synthetic', providerRequestId: 'synthetic_request' } });
});
it('retains malformed output framing as bounded raw evidence rather than an empty payload', async () => {
 const f = setup(), response = f.response(); response.body.output = { unexpected: 'output' } as never; f.transport.createResponse.mockResolvedValue(response);
 const result = await f.run(); expect(result).toMatchObject({ kind: 'observed', observation: { usage: { inputTokens: 10 }, billing: { status: 'unknown' } } });
 if (result.kind === 'observed') expect(Buffer.from(result.result.retainedOutput.data, 'base64').toString()).toContain('unexpected');
});
it('honors a tighter output-byte policy even below the global retention ceiling', async () => {
 const f = providerFixture(), policy = { ...f.textPolicy, maxOutputBytes: 1024 }, response = f.response(); response.body.output[0]!.content[0]!.text = 'a'.repeat(1500); f.transport.createResponse.mockResolvedValue(response);
 const provider = createLogoVectorProposalProvider({ configuration: { ...f.configuration, textPolicy: policy }, transport: f.transport })!;
 expect(await provider.propose(f.context, f.resolved.input.instruction, policy, new AbortController().signal, { job: { ...f.job, input: { ...f.resolved.input, textPolicy: policy } }, beforeDispatch: async () => {} })).toMatchObject({ kind: 'observed', result: { reason: 'output_too_large', retainedOutput: { byteLength: 1500, truncated: false } }, observation: { billing: { confirmedMicrousd: 68 } } });
});
it('retains invalid UTF-8 wire bytes and unknown expenses when the default transport cannot parse', async () => {
 const f = providerFixture(), bytes = Uint8Array.from([123, 0xff, 125]);
 vi.stubGlobal('fetch', async (url: string) => new Response(url.endsWith('/input_tokens') ? JSON.stringify({ input_tokens: 10 }) : bytes, { headers: { 'x-request-id': 'synthetic_wire' } }));
 const provider = createLogoVectorProposalProvider({ configuration: f.configuration, apiKey: 'synthetic-not-a-secret' })!;
 expect(await provider.propose(f.context, f.resolved.input.instruction, f.textPolicy, new AbortController().signal, { job: f.job, beforeDispatch: async () => {} })).toMatchObject({ kind: 'observed', observation: { providerRequestId: 'synthetic_wire', billing: { status: 'unknown' } }, result: { status: 'incomplete', retainedOutput: { data: Buffer.from(bytes).toString('base64'), byteLength: 3, truncated: false } } });
});
it('retains an interrupted response prefix, without inventing eventual length or a retry', async () => {
 const f = providerFixture(), prefix = '{"id":"resp_partial","output":'; let inferenceCalls = 0;
 vi.stubGlobal('fetch', async (url: string) => {
  if (url.endsWith('/input_tokens')) return new Response(JSON.stringify({ input_tokens: 10 })); inferenceCalls++;
  let delivered = false;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (!delivered) { delivered = true; controller.enqueue(Buffer.from(prefix)); } else controller.error(new Error('connection interrupted')); } }), { headers: { 'x-request-id': 'partial_request' } });
 });
 const provider = createLogoVectorProposalProvider({ configuration: f.configuration, apiKey: 'synthetic-not-a-secret' })!;
 expect(await provider.propose(f.context, f.resolved.input.instruction, f.textPolicy, new AbortController().signal, { job: f.job, beforeDispatch: async () => {} })).toMatchObject({ kind: 'observed', observation: { model: null, responseComplete: false, responseHash: hash(prefix), billing: { status: 'unknown' } }, result: { retainedOutput: { data: Buffer.from(prefix).toString('base64'), byteLength: Buffer.byteLength(prefix), truncated: false } } });
 expect(inferenceCalls).toBe(1);
});
it('enforces the exact wire-byte policy and retains its observed prefix', async () => {
 const f = providerFixture(), policy = { ...f.textPolicy, maxStreamBytes: 1024 }, body = 'x'.repeat(2000); let requests = 0;
 vi.stubGlobal('fetch', async (url: string) => { requests++; return new Response(url.endsWith('/input_tokens') ? JSON.stringify({ input_tokens: 10 }) : body); });
 const provider = createLogoVectorProposalProvider({ configuration: { ...f.configuration, textPolicy: policy }, apiKey: 'synthetic-not-a-secret' })!;
 expect(await provider.propose(f.context, f.resolved.input.instruction, policy, new AbortController().signal, { job: { ...f.job, input: { ...f.resolved.input, textPolicy: policy } }, beforeDispatch: async () => {} })).toMatchObject({ kind: 'observed', observation: { billing: { status: 'unknown' } }, result: { retainedOutput: { byteLength: 2000, truncated: false, sha256: hash(body) } } });
 expect(requests).toBe(2);
});
it('retains only 32768 bytes of an oversized wire chunk and hashes all observed bytes', async () => {
 const f = providerFixture(), policy = { ...f.textPolicy, maxStreamBytes: 1024 }, body = 'x'.repeat(40000);
 vi.stubGlobal('fetch', async (url: string) => new Response(url.endsWith('/input_tokens') ? JSON.stringify({ input_tokens: 10 }) : body));
 const provider = createLogoVectorProposalProvider({ configuration: { ...f.configuration, textPolicy: policy }, apiKey: 'synthetic-not-a-secret' })!;
 const result = await provider.propose(f.context, f.resolved.input.instruction, policy, new AbortController().signal, { job: { ...f.job, input: { ...f.resolved.input, textPolicy: policy } }, beforeDispatch: async () => {} });
 expect(result).toMatchObject({ kind: 'observed', result: { retainedOutput: { byteLength: 40000, truncated: true, sha256: hash(body) } } });
 if (result.kind === 'observed') expect(Buffer.from(result.result.retainedOutput.data, 'base64')).toHaveLength(32768);
 expect(JSON.stringify(result)).not.toContain('synthetic-not-a-secret'); expect(JSON.stringify(result)).not.toContain(f.resolved.input.instruction);
});
it('retains the observed wire prefix on cancellation after physical dispatch', async () => {
 const f = providerFixture(), abort = new AbortController(), prefix = '{"id":"resp_cancelled",'; let inferenceCalls = 0;
 vi.stubGlobal('fetch', async (url: string) => {
  if (url.endsWith('/input_tokens')) return new Response(JSON.stringify({ input_tokens: 10 })); inferenceCalls++;
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(prefix)); setTimeout(() => { abort.abort(); controller.error(new DOMException('Aborted', 'AbortError')); }, 0); } }));
 });
 const provider = createLogoVectorProposalProvider({ configuration: f.configuration, apiKey: 'synthetic-not-a-secret' })!;
 const result = await provider.propose(f.context, f.resolved.input.instruction, f.textPolicy, abort.signal, { job: f.job, beforeDispatch: async () => {} });
 expect(result).toMatchObject({ kind: 'observed', observation: { responseComplete: false, billing: { status: 'unknown' } }, result: { retainedOutput: { data: Buffer.from(prefix).toString('base64'), byteLength: Buffer.byteLength(prefix), truncated: false } } });
 expect(inferenceCalls).toBe(1); expect(JSON.stringify(result)).not.toContain('synthetic-not-a-secret');
});
it.each([272000, 272001])('retains known standard rates only through the qualified threshold (%s)', async inputTokens => {
 const f = setup(), response = f.response(); response.body.usage.input_tokens = inputTokens; response.body.usage.total_tokens = inputTokens + 5; f.transport.createResponse.mockResolvedValue(response);
 expect(await f.run()).toMatchObject({ kind: 'observed', observation: { usage: { inputTokens }, billing: inputTokens === 272000 ? { status: 'recorded', confirmedMicrousd: 544048 } : { status: 'unknown', confirmedMicrousd: null } } });
});
it('does not accept a completed label paired with an error or incomplete marker', async () => {
 for (const contradiction of [{ error: { code: 'synthetic_error' } }, { incomplete_details: { reason: 'max_output_tokens' } }]) {
  const f = setup(), response = f.response(); Object.assign(response.body, contradiction); f.transport.createResponse.mockResolvedValue(response);
  expect(await f.run()).toMatchObject({ kind: 'observed', observation: { responseComplete: false, billing: { confirmedMicrousd: 68 } }, result: { status: 'incomplete' } });
 }
});
