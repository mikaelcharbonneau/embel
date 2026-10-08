import { afterEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createLogoVectorProposalRuntimeAdapter } from '../../worker/logo-vector/proposal-runtime-adapter';
import { createLogoVectorProposalHandler } from '../../worker/handlers/logo-vector-proposals';
import { providerFixture } from '../server/logo-vector-proposal-provider-fixtures';
const fixture = () => {
 const f = providerFixture(); const input = { ownerId: f.job.ownerId, policyIdentity: f.resolved.input.policyIdentity, configuration: f.configuration, ports: f.ports, transport: f.transport, acceptingWork: () => true };
 return { ...f, input };
};
afterEach(() => vi.unstubAllGlobals());
it('is passive and null without exact operation config, policy and every port', () => {
 const f = fixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
 for (const raw of [null, {}, { paidCallsApproved: true }, { FLUID_TEXT_MODEL_REFORMULATE: 'gpt-6.1-sol' }, { ...f.input, configuration: null }, { ...f.input, configuration: { ...f.configuration, textPolicy: null } }, { ...f.input, ports: null }, { ...f.input, transport: null }, ...['loadInput', 'assertReady', 'recordResponse', 'stageProposal'].map(key => ({ ...f.input, ports: { ...f.ports, [key]: null } }))]) expect(createLogoVectorProposalRuntimeAdapter(raw as never)).toBeNull();
 const adapter = createLogoVectorProposalRuntimeAdapter(f.input)!;
 expect(adapter).not.toBeNull(); expect(adapter.capability).toEqual({ operation: 'identity.logo_vector_propose', policyIdentity: f.resolved.input.policyIdentity, handlerVersion: 'logo-vector-propose-v1', provider: 'openai', model: 'gpt-6.1-sol', engine: null, maxCostMicrousd: 122880, textPolicy: f.textPolicy });
 expect(Object.keys(adapter)).toEqual(['capability', 'proposals']); expect('assets' in adapter.proposals).toBe(false); expect('storage' in adapter).toBe(false);
 expect(fetcher).not.toHaveBeenCalled(); expect(f.ports.assertReady).not.toHaveBeenCalled(); expect(f.transport.countInputTokens).not.toHaveBeenCalled();
});
it('snapshots exact configuration and independently fences owner and policy mismatches', async () => {
 const f = fixture(), adapter = createLogoVectorProposalRuntimeAdapter(f.input)!;
 f.configuration.textPolicy.model = 'different' as never;
 expect(adapter.capability.textPolicy.model).toBe('gpt-6.1-sol');
 for (const job of [{ ...f.job, ownerId: '76100000-0000-4000-8000-000000000099' }, { ...f.job, input: { ...f.resolved.input, policyIdentity: 'f'.repeat(64) } }]) await expect(adapter.proposals.loadInput(job, new AbortController().signal)).rejects.toThrow();
 expect(f.ports.loadInput).not.toHaveBeenCalled();
});
it('stops at the final injected transport boundary after successful asynchronous readiness', async () => {
 const f = fixture(); let accepting = true; let assertions = 0;
 f.input.acceptingWork = () => accepting;
 vi.mocked(f.ports.assertReady).mockImplementation(async () => { if (++assertions === 3) queueMicrotask(() => { accepting = false; }); });
 const adapter = createLogoVectorProposalRuntimeAdapter(f.input)!;
 const result = await createLogoVectorProposalHandler(adapter.proposals).steps(f.job)[0]!.execute({ job: f.job, signal: new AbortController().signal });
 expect(result).toMatchObject({ status: 'failed', code: 'not_dispatched' }); expect(f.transport.createResponse).not.toHaveBeenCalled();
});
it.each([false, undefined, Promise.resolve(true)])('requires literal true from a synchronous physical guard (%s)', async value => {
 const f = fixture(); f.input.acceptingWork = (() => value) as () => boolean;
 const adapter = createLogoVectorProposalRuntimeAdapter(f.input)!;
 const result = await createLogoVectorProposalHandler(adapter.proposals).steps(f.job)[0]!.execute({ job: f.job, signal: new AbortController().signal });
 expect(result).toMatchObject({ status: 'failed', code: 'not_dispatched' }); expect(f.transport.createResponse).not.toHaveBeenCalled();
});
it('uses a snapshotted default transport and port binding', async () => {
 const f = fixture(); let accepting = true, inferCalls = 0;
 const fetcher = vi.fn(async (url: string) => { if (url.endsWith('/input_tokens')) return new Response(JSON.stringify({ input_tokens: 10 })); inferCalls++; return new Response(JSON.stringify(f.response().body)); }); vi.stubGlobal('fetch', fetcher);
 let reads = 0; f.input.acceptingWork = () => ++reads < 100 && accepting;
 const adapter = createLogoVectorProposalRuntimeAdapter({ ...f.input, transport: undefined, apiKey: 'synthetic-not-a-secret' })!;
 f.ports.assertReady = vi.fn(async () => { accepting = false; });
 // Bound callbacks were snapshotted before the caller reassigned the port.
 const result = await createLogoVectorProposalHandler(adapter.proposals).steps(f.job)[0]!.execute({ job: f.job, signal: new AbortController().signal });
 expect(result.status).toBe('succeeded'); expect(inferCalls).toBe(1);
});
it('retains and stages an already dispatched result when the host stops accepting work', async () => {
 const f = fixture(); let accepting = true; f.input.acceptingWork = () => accepting;
 f.transport.createResponse.mockImplementation(async () => { accepting = false; return f.response(); });
 const adapter = createLogoVectorProposalRuntimeAdapter(f.input)!;
 expect(await createLogoVectorProposalHandler(adapter.proposals).steps(f.job)[0]!.execute({ job: f.job, signal: new AbortController().signal })).toMatchObject({ status: 'succeeded', costMicrousd: 68 });
 expect(f.ports.recordResponse).toHaveBeenCalledTimes(1); expect(f.ports.stageProposal).toHaveBeenCalledTimes(1); expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
});
