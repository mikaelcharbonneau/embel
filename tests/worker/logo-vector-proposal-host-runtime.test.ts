import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { freezeLogoWorkerManifest, createLogoReadiness } from '../../worker/logo-readiness';
import { createLogoWorkerRuntime } from '../../worker/logo-runtime';
import { createLogoOperationComposition } from '../../worker/logo-operation-composition';
import { createLogoVectorProposalRuntimeAdapter } from '../../worker/logo-vector/proposal-runtime-adapter';
import { createLogoVectorProposalWorkerPorts } from '@/server/data/logo-vector-proposal-worker';
import { startLogoProductionWorker } from '../../worker/logo-production-startup';
import { proposalHostFixture, deferred } from './logo-vector-proposal-host-fixture';
import { imageCapability, vectorCapability, exportCapability } from './logo-dedicated-fixture';
import { subscriptionFixture } from '../features/identity-directions/subscription-fixtures';
const empty = () => ({ concepts: null, refinements: null, vector: null, directions: null, exports: null, unavailableReasons: {} });
afterEach(() => vi.useRealTimers());
describe('exact sixth logo runtime lane', () => {
 it('accepts all six unique exact descriptors and recursively snapshots text policy', () => {
  const f = proposalHostFixture(), { policy } = subscriptionFixture();
  const all = [imageCapability(), imageCapability('identity.logo_refine'), vectorCapability(), exportCapability(),
   { operation: 'identity.logo_directions', policyIdentity: 'b'.repeat(64), handlerVersion: policy.handlerVersion, provider: 'openai', model: policy.model, engine: null, maxCostMicrousd: 0, billingMode: 'chatgpt_subscription', policy }, f.capability];
  const manifest = freezeLogoWorkerManifest(all);
  expect(manifest).toHaveLength(6); expect(Object.isFrozen(manifest[5]!.textPolicy)).toBe(true);
  f.capability.textPolicy = { ...f.textPolicy, deadlineMs: 1000 };
  expect(manifest[5]!.textPolicy!.deadlineMs).toBe(f.textPolicy.deadlineMs);
  expect(() => freezeLogoWorkerManifest([...all, all[0]])).toThrow();
 });
 it.each([{ textPolicy: undefined }, { policy: {} }, { billingMode: 'chatgpt_subscription' }, { provider: 'other' }, { model: 'other' }, { handlerVersion: 'other' }, { maxCostMicrousd: 1 }, { engine: { id: 'vtracer', version: '1', artifactHash: 'b'.repeat(64) } }])('rejects an incomplete or cross-lane proposal descriptor %#', patch => {
  expect(() => freezeLogoWorkerManifest([{ ...proposalHostFixture().capability, ...patch }])).toThrow();
 });
 it('refuses text policy on every existing operation and requires exact policy on dispatch', async () => {
  const f = proposalHostFixture();
  expect(() => freezeLogoWorkerManifest([{ ...imageCapability(), textPolicy: f.textPolicy }])).toThrow();
  const readiness = createLogoReadiness({ connection: f.connection, workerId: 'fixture', manifest: [f.capability] });
  await readiness.refresh(); await expect(readiness.assertReady(f.job)).resolves.toBeUndefined();
  const calls = f.query.mock.calls.length;
  for (const input of [{ ...f.resolved.input, textPolicy: undefined }, { ...f.resolved.input, textPolicy: { ...f.textPolicy, deadlineMs: 2000 } }, { ...f.resolved.input, policy: {} }, { ...f.resolved.input, billingMode: 'openai_api' }]) await expect(readiness.assertReady({ ...f.job, input })).rejects.toThrow();
  expect(f.query).toHaveBeenCalledTimes(calls); await readiness.close();
 });
 it('keeps composition unavailable without the exact optional proposal dependency', () => {
  const composition = createLogoOperationComposition(empty());
  expect(composition.capabilities['identity.logo_vector_propose'].status).toBe('unavailable'); expect(composition.handlers.size).toBe(0);
 });
 it('does not register a declared proposal without complete ports or a provider', async () => {
  const f = proposalHostFixture(), runtime = createLogoWorkerRuntime({ connection: f.connection, workerId: 'fixture', manifest: [f.capability], composition: { ...empty(), proposals: { ...f.ports, provider: null } as never } });
  expect(runtime.manifest).toEqual([]); expect(await runtime.tick()).toBe('idle'); expect(f.query).not.toHaveBeenCalled(); await runtime.close();
 });
 it('uses one existing runner with the actual four SQL ports and no storage dependency', async () => {
  const f = proposalHostFixture(), startup = await startLogoProductionWorker({ enabled: true, ownerId: f.job.ownerId, workerId: 'fixture', connection: f.connection, proposals: f.proposals });
  expect(startup.status).toBe('ready'); if (startup.status !== 'ready') return;
  expect(f.events).toEqual(['select fluid_private.logo_worker_owner()::text as owner_id']);
  expect(startup.runtime.manifest).toEqual([f.capability]); expect(await startup.runtime.tick()).toBe('succeeded'); await startup.close();
  expect(f.transport.createResponse).toHaveBeenCalledTimes(1); expect(f.state.completions[0]![3]).toBe('succeeded');
  expect(f.events.filter(s => s.includes('claim_logo_job'))).toHaveLength(1);
  expect(f.events.some(s => /asset|storage|font/i.test(s))).toBe(false);
 });
 it('retains known paid invalid output through the real JobStore failed-result path', async () => {
  const f = proposalHostFixture(); f.transport.createResponse.mockImplementation(async () => { const r = f.response(); r.body.output[0]!.content[0]!.text = 'bad JSON'; return r; });
  const startup = await startLogoProductionWorker({ enabled: true, ownerId: f.job.ownerId, workerId: 'fixture', connection: f.connection, proposals: f.proposals });
  expect(startup.status).toBe('ready'); if (startup.status !== 'ready') return;
  expect(await startup.runtime.tick()).toBe('failed'); await startup.close();
  expect(f.state.completions[0]).toEqual(expect.arrayContaining(['failed', 68]));
  expect(JSON.parse(f.state.completions[0]![5] as string)).toMatchObject({ error: 'invalid_output', result: { kind: 'logo_vector_proposal' } });
 });
 it('fences physical dispatch when stop happens during token counting', async () => {
  const f = proposalHostFixture(), counted = deferred<number>(), began = deferred<void>();
  f.transport.countInputTokens.mockImplementation(async () => { began.resolve(); return counted.promise; });
  const startup = await startLogoProductionWorker({ enabled: true, ownerId: f.job.ownerId, workerId: 'fixture', connection: f.connection, proposals: f.proposals });
  expect(startup.status).toBe('ready'); if (startup.status !== 'ready') return;
  const ticking = startup.runtime.tick(); await began.promise; const closing = startup.close(); counted.resolve(10);
  expect(await ticking).toBe('failed'); await closing; expect(f.transport.createResponse).not.toHaveBeenCalled();
  expect(JSON.parse(f.state.completions[0]![5] as string)).toEqual({ error: 'not_dispatched' });
 });
 it('drains observed output and known cost after stop while refusing another tick', async () => {
  const f = proposalHostFixture(), dispatched = deferred<void>(), result = deferred<ReturnType<typeof f.response>>();
  f.transport.createResponse.mockImplementation(async () => { dispatched.resolve(); return result.promise; });
  const startup = await startLogoProductionWorker({ enabled: true, ownerId: f.job.ownerId, workerId: 'fixture', connection: f.connection, proposals: f.proposals });
  expect(startup.status).toBe('ready'); if (startup.status !== 'ready') return;
  const ticking = startup.runtime.tick(); await dispatched.promise; let drained = false; const closing = startup.close().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false); expect(await startup.runtime.tick()).toBe('idle');
  result.resolve(f.response()); expect(await ticking).toBe('succeeded'); await closing;
  expect(f.events.some(s => s.includes('record_logo_provider_response'))).toBe(true); expect(f.events.some(s => s.includes('stage_logo_vector_proposal'))).toBe(true);
  expect(f.state.completions[0]![4]).toBe(68); expect(drained).toBe(true);
 });
 it('rejects mismatched independent configuration rather than enabling from manifest alone', async () => {
  const f = proposalHostFixture();
  for (const proposals of [{ ...f.proposals, configuration: undefined }, { ...f.proposals, configuration: { ...f.configuration, paidCallsApproved: false } }, { ...f.proposals, capability: { ...f.capability, policyIdentity: 'bad' } }]) {
   expect((await startLogoProductionWorker({ enabled: true, ownerId: f.job.ownerId, workerId: 'fixture', connection: f.connection, proposals: proposals as never })).status).toBe('unavailable');
  }
  expect(f.query).not.toHaveBeenCalled(); expect(f.transport.createResponse).not.toHaveBeenCalled();
 });
 it('accepts passive reviewed dependencies without mutating the frozen adapter', () => {
  const f = proposalHostFixture(), adapter = createLogoVectorProposalRuntimeAdapter({ ownerId: f.job.ownerId, policyIdentity: f.capability.policyIdentity, configuration: f.configuration, ports: f.ports, transport: f.transport })!;
  const runtime = createLogoWorkerRuntime({ connection: f.connection, workerId: 'fixture', manifest: [adapter.capability], composition: { ...empty(), proposals: adapter.proposals } });
  expect(runtime.manifest).toEqual([f.capability]); expect(Object.isFrozen(adapter.proposals)).toBe(true); void runtime.close();
 });
 it('keeps late evidence ports alive after the runner cancellation grace ends', async () => {
  const f = proposalHostFixture(), dispatched = deferred<void>(), response = deferred<ReturnType<typeof f.response>>();
  f.transport.createResponse.mockImplementation(async () => { dispatched.resolve(); return response.promise; });
  const adapter = createLogoVectorProposalRuntimeAdapter({ ownerId: f.job.ownerId, policyIdentity: f.capability.policyIdentity, configuration: f.configuration,
   ports: createLogoVectorProposalWorkerPorts(f.connection), transport: f.transport })!;
  const runtime = createLogoWorkerRuntime({ connection: f.connection, workerId: 'fixture', manifest: [adapter.capability], composition: { ...empty(), proposals: adapter.proposals }, runner: { heartbeatMs: 10, abortGraceMs: 1 } });
  const tick = runtime.tick(); await dispatched.promise; f.state.cancellation = true;
  expect(await tick).toBe('needs_reconciliation');
  let drained = false; const closing = runtime.close().then(() => { drained = true; }); await Promise.resolve(); await Promise.resolve(); expect(drained).toBe(false);
  response.resolve(f.response()); await closing;
  expect(f.events.some(sql => sql.includes('record_logo_provider_response'))).toBe(true);
  expect(f.events.some(sql => sql.includes('stage_logo_vector_proposal'))).toBe(true); expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
 });

 it('captures the supplied proposal guard before caller mutation', async () => {
  const f = proposalHostFixture(), adapter = createLogoVectorProposalRuntimeAdapter({ ownerId: f.job.ownerId, policyIdentity: f.capability.policyIdentity, configuration: f.configuration, ports: f.ports, transport: f.transport })!;
  const proposals = { ...adapter.proposals };
  const runtime = createLogoWorkerRuntime({ connection: f.connection, workerId: 'fixture', manifest: [adapter.capability], composition: { ...empty(), proposals } });
  proposals.assertReady = async () => { throw Error('Changed caller guard'); };
  expect(await runtime.tick()).toBe('succeeded'); await runtime.close(); expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
 });

 it('retains over-cap unpublished evidence through the existing runner cost rewrite', async () => {
  const f = proposalHostFixture(); f.ports.recordResponse = async () => { throw Error('Synthetic acknowledgement loss'); };
  f.transport.createResponse.mockImplementation(async () => { const response = f.response(); response.body.usage.input_tokens = 100000; response.body.usage.total_tokens = 100005; return response; });
  const startup = await startLogoProductionWorker({ enabled: true, ownerId: f.job.ownerId, workerId: 'fixture', connection: f.connection, proposals: f.proposals });
  expect(startup.status).toBe('ready'); if (startup.status !== 'ready') return;
  expect(await startup.runtime.tick()).toBe('needs_reconciliation'); await startup.close();
  expect(f.state.completions[0]).toMatchObject({ 3: 'ambiguous', 4: 200048 });
  expect(JSON.parse(f.state.completions[0]![5] as string)).toMatchObject({ error: 'provider_evidence_unconfirmed', result: { reason: 'provider_evidence_unconfirmed', observation: { billing: { confirmedMicrousd: 200048 } }, result: { retainedOutput: { truncated: false } } } });
  expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
 });

});
