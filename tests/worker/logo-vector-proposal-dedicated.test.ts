import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { parseLogoDedicatedConfiguration, getLogoDedicatedConfiguration } from '../../worker/logo-dedicated-config';
import { runLogoDedicatedWorker, type LogoDedicatedDependencies } from '../../worker/logo-dedicated-launcher';
import { proposalHostFixture, deferred } from './logo-vector-proposal-host-fixture';
import { configurationInput, syntheticSecret } from './logo-dedicated-fixture';
import type { LogoProductionHostOptions } from '../../worker/logo-production-host';
const proposalConfiguration = () => {
 const { storage: _s, image: _i, ...base } = configurationInput(); void _s; void _i;
 const f = proposalHostFixture(); return { ...base, vectorProposal: { ...f.configuration, apiKey: syntheticSecret }, operations: { proposals: f.capability } };
};
describe('independent proposal dedicated config', () => {
 it('permits exact explicit proposal-only configuration without storage credentials', () => {
  const raw = proposalConfiguration(), handle = parseLogoDedicatedConfiguration(raw);
  expect(handle.status).toBe('configured'); expect(JSON.stringify(handle)).not.toContain(syntheticSecret);
  const value = getLogoDedicatedConfiguration(handle)!; expect(value.operations.proposals).toEqual(raw.operations.proposals); expect(value.storage).toBeUndefined(); expect(value.image).toBeUndefined();
  expect(Object.isFrozen(value.vectorProposal!.textPolicy)).toBe(true);
 });
 it('preserves the existing four explicit launcher lanes and permits a fifth proposal lane', () => {
  const old = configurationInput(); expect(parseLogoDedicatedConfiguration(old).status).toBe('configured');
  const p = proposalConfiguration(); expect(parseLogoDedicatedConfiguration({ ...old, vectorProposal: p.vectorProposal, operations: { ...old.operations, ...p.operations } }).status).toBe('configured');
 });
 it.each(['missing_policy', 'missing_permission', 'missing_key', 'missing_capability', 'wrong_policy', 'wrong_operation', 'extra_storage', 'extra_image'])('refuses %s without inheriting image/reformulation settings', change => {
  const input: Record<string, unknown> = proposalConfiguration();
  if (change === 'missing_policy') input.vectorProposal = undefined;
  if (change === 'missing_permission') input.vectorProposal = { ...proposalConfiguration().vectorProposal, paidCallsApproved: undefined };
  if (change === 'missing_key') input.vectorProposal = { ...proposalConfiguration().vectorProposal, apiKey: undefined };
  if (change === 'missing_capability') input.operations = {};
  if (change === 'wrong_policy') input.vectorProposal = { ...proposalConfiguration().vectorProposal, textPolicy: { ...proposalConfiguration().vectorProposal.textPolicy, deadlineMs: 1000 } };
  if (change === 'wrong_operation') input.vectorProposal = { ...proposalConfiguration().vectorProposal, operation: 'strategy.reformulate' };
  if (change === 'extra_storage') input.storage = configurationInput().storage;
  if (change === 'extra_image') input.image = configurationInput().image;
  expect(parseLogoDedicatedConfiguration(input).status).toBe('unavailable');
 });
 it('still requires storage for a selected old asset lane', () => {
  const input = proposalConfiguration(); expect(parseLogoDedicatedConfiguration({ ...input, operations: { ...input.operations, vector: configurationInput().operations.vector } }).status).toBe('unavailable');
 });
 it('starts one storage-free host and disposes the pool only after signal drain', async () => {
  const signals = new EventEmitter(), entered = deferred<void>(), stop = deferred<void>(); let received: Extract<LogoProductionHostOptions, { enabled: true }> | undefined;
  const pool = Object.assign(new EventEmitter(), { connect: vi.fn(async (): Promise<never> => { throw Error('Unused pool'); }), end: vi.fn(async () => {}) });
  const dependencies: LogoDedicatedDependencies = { signals, createPool: vi.fn(() => pool), emit() {}, startHost: vi.fn(async options => {
   if (!options.enabled) throw Error('Expected enabled host'); received = options;
   return { status: 'qualified' as const, manifest: [], async run() { entered.resolve(); await stop.promise; }, async close() { stop.resolve(); } };
  }) };
  const pending = runLogoDedicatedWorker(parseLogoDedicatedConfiguration(proposalConfiguration()), dependencies); await entered.promise;
  expect(received!.proposals!.configuration).toEqual(proposalHostFixture().configuration);
  expect(received!.proposals!.apiKey).toBe(syntheticSecret);
  for (const lane of ['concepts', 'refinements', 'vector', 'exports', 'directions']) expect(received).not.toHaveProperty(lane);
  expect(received!.proposals).not.toHaveProperty('assets'); expect(received!.proposals).not.toHaveProperty('authorization');
  expect(dependencies.createPool).toHaveBeenCalledTimes(1); expect(dependencies.startHost).toHaveBeenCalledTimes(1);
  signals.emit('SIGTERM'); expect(await pending).toMatchObject({ status: 'drained', exitCode: 0 }); expect(pool.end).toHaveBeenCalledTimes(1); expect(signals.eventNames()).toEqual([]);
 });
});
