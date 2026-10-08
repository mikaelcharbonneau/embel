import { expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createLogoVectorProposalHandler } from '../../worker/handlers/logo-vector-proposals';
import { createLogoVectorProposalProvider } from '@/features/logo-vector/server/proposal-provider';
import { providerFixture } from '../server/logo-vector-proposal-provider-fixtures';
import { runOneJob, type JobStore } from '../../worker/runner';
const setup = () => {
 const f = providerFixture(), controller = new AbortController();
 const provider = createLogoVectorProposalProvider({ configuration: f.configuration, transport: f.transport })!;
 const handler = createLogoVectorProposalHandler({ ...f.ports, provider });
 const step = handler.steps(f.job)[0]!;
 return { ...f, provider, handler, controller, step, run: () => step.execute({ job: f.job, signal: controller.signal }) };
};
it('makes exactly one bounded step with no asset, font, image or materialization dependency', async () => {
 const f = setup(); expect(f.handler.steps(f.job).map(({ key, maximumCostMicrousd, timeoutMs }) => ({ key, maximumCostMicrousd, timeoutMs }))).toEqual([{ key: 'propose-vector-edit', maximumCostMicrousd: 122880, timeoutMs: 240000 }]);
 const result = await f.run(); expect(result).toMatchObject({ status: 'succeeded', costMicrousd: 68, result: { kind: 'logo_vector_proposal', preparedId: expect.any(String), providerResponseReceiptId: expect.any(String) } });
 expect(f.ports.recordResponse).toHaveBeenCalledTimes(1); expect(f.ports.stageProposal).toHaveBeenCalledTimes(1); expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
 expect(await f.run()).toEqual(result); expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
});
it('fails before inference when exact input, owner, lease or readiness no longer agrees', async () => {
 for (const change of ['input', 'owner', 'lease', 'ready']) {
  const f = setup();
  if (change === 'ready') vi.mocked(f.ports.assertReady).mockRejectedValue(new Error('not ready'));
  else if (change === 'input') { const other = structuredClone(f.resolved); other.input.instruction = 'Different intent'; vi.mocked(f.ports.loadInput).mockResolvedValue(other); }
  else if (change === 'owner') f.job.ownerId = '76100000-0000-4000-8000-000000000099';
  else f.job.leaseToken = '76100000-0000-4000-8000-000000000099';
  expect(await f.run()).toMatchObject({ status: 'failed', code: 'not_dispatched', costMicrousd: 0 }); expect(f.transport.createResponse).not.toHaveBeenCalled(); expect(f.ports.recordResponse).not.toHaveBeenCalled();
 }
});
it('continues observation and staging after cancellation and loss of work admission', async () => {
 const f = setup(); f.transport.createResponse.mockImplementation(async () => { f.controller.abort(); vi.mocked(f.ports.assertReady).mockRejectedValue(new Error('stopped')); return f.response(); });
 expect(await f.run()).toMatchObject({ status: 'succeeded', costMicrousd: 68 });
 expect(vi.mocked(f.ports.recordResponse).mock.calls[0]).toHaveLength(2); expect(vi.mocked(f.ports.stageProposal).mock.calls[0]).toHaveLength(3);
});
it.each(['record', 'stage'])('retains bounded output, observation and known costs on lost %s acknowledgement', async operation => {
 const f = setup();
 if (operation === 'record') vi.mocked(f.ports.recordResponse).mockRejectedValue(new Error('ack lost'));
 else vi.mocked(f.ports.stageProposal).mockRejectedValue(new Error('ack lost'));
 const result = await f.run(); expect(result).toMatchObject({ status: 'needs_reconciliation', costMicrousd: 68, result: { kind: 'logo_vector_proposal_unpublished', observation: { billing: { confirmedMicrousd: 68 } }, result: { status: 'valid', retainedOutput: { truncated: false } } } });
 expect(await f.run()).toEqual(result); expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
});
it.each(['record', 'stage'])('rejects substituted %s acknowledgement bindings', async operation => {
 const f = setup();
 if (operation === 'record') { const real = vi.mocked(f.ports.recordResponse).getMockImplementation()!; vi.mocked(f.ports.recordResponse).mockImplementation(async (...args) => ({ ...await real(...args), jobId: '76100000-0000-4000-8000-000000000099' })); }
 else { const receipt = await f.ports.recordResponse(f.job, { } as never); const realStage = await f.ports.stageProposal(f.job, {} as never, receipt); vi.mocked(f.ports.stageProposal).mockResolvedValue({ ...realStage, contextHash: 'f'.repeat(64) }); }
 expect(await f.run()).toMatchObject({ status: 'needs_reconciliation', costMicrousd: 68 });
});
it('persists charged invalid output instead of erasing the evidence', async () => {
 const f = setup(), response = f.response(); response.body.output[0]!.content[0]!.text = '{invalid'; f.transport.createResponse.mockResolvedValue(response);
 expect(await f.run()).toMatchObject({ status: 'failed', code: 'invalid_output', costMicrousd: 68, result: { kind: 'logo_vector_proposal' } });
 expect(vi.mocked(f.ports.stageProposal).mock.calls[0]![1]).toMatchObject({ status: 'invalid', payload: null, retainedOutput: { data: Buffer.from('{invalid').toString('base64') } });
});
it('completes an explicit unsupported answer with charge and no candidate', async () => {
 const f = setup(), response = f.response(); response.body.output[0]!.content[0]!.text = JSON.stringify({ version: 1, status: 'unsupported', code: 'multiple_changes', explanation: 'Split the request explicitly.' }); f.transport.createResponse.mockResolvedValue(response);
 expect(await f.run()).toMatchObject({ status: 'succeeded', costMicrousd: 68 });
 expect(vi.mocked(f.ports.stageProposal).mock.calls[0]![1]).toMatchObject({ status: 'valid', payload: { status: 'unsupported' } });
});
it('keeps missing usage and over-limit observed usage pending reconciliation', async () => {
 for (const over of [false, true]) {
  const f = setup(), response = f.response();
  if (over) { response.body.usage.output_tokens = 5000; response.body.usage.total_tokens = 5010; }
  else delete (response.body as Record<string, unknown>).usage;
  f.transport.createResponse.mockResolvedValue(response);
  expect(await f.run()).toMatchObject({ status: 'needs_reconciliation', costMicrousd: over ? 50018 : 0 }); expect(f.ports.stageProposal).toHaveBeenCalledTimes(1);
 }
});
it('retains unknown provider exceptions without retrying', async () => {
 const f = setup(); const provider = { propose: vi.fn(async () => { throw new Error('unknown'); }) };
 const step = createLogoVectorProposalHandler({ ...f.ports, provider }).steps(f.job)[0]!;
 expect(await step.execute({ job: f.job, signal: f.controller.signal })).toMatchObject({ status: 'needs_reconciliation', costMicrousd: 0 }); expect(provider.propose).toHaveBeenCalledTimes(1); expect(f.ports.recordResponse).toHaveBeenCalledTimes(1);
});
it('retains a late paid response after the runner loses its lease without second inference', async () => {
 const f = setup(); let resolve!: (value: ReturnType<typeof f.response>) => void;
 f.transport.createResponse.mockImplementation(() => new Promise(done => { resolve = done; }));
 let heartbeats = 0;
 const store: JobStore = { claim: vi.fn(async () => f.job), registerPlan: vi.fn(async () => {}), heartbeat: vi.fn(async () => { if (++heartbeats > 1) throw new Error('lost lease'); return { cancelled: false }; }), beginStep: vi.fn<JobStore['beginStep']>(async () => 'started'), completeStep: vi.fn(async () => {}), finish: vi.fn(async () => {}) };
 const running = runOneJob({ store, handlers: new Map([[f.job.operation, f.handler]]), workerId: 'synthetic', heartbeatMs: 5, abortGraceMs: 5 });
 await vi.waitFor(() => expect(f.transport.createResponse).toHaveBeenCalledTimes(1));
 await expect(running).resolves.toBe('lease_lost');
 resolve(f.response()); await vi.waitFor(() => expect(f.ports.stageProposal).toHaveBeenCalledTimes(1));
 expect(store.completeStep).not.toHaveBeenCalled(); expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
});
it('keeps input above the admitted token bound pending even when standard rates and total cost remain known', async () => {
 const f = setup(), response = f.response(); response.body.usage.input_tokens = 50000; response.body.usage.total_tokens = 50005; f.transport.createResponse.mockResolvedValue(response);
 expect(await f.run()).toMatchObject({ status: 'needs_reconciliation', costMicrousd: 100048 });
 expect(vi.mocked(f.ports.stageProposal).mock.calls[0]![2].observation).toMatchObject({ usage: { inputTokens: 50000 }, billing: { status: 'recorded', confirmedMicrousd: 100048 } });
});
