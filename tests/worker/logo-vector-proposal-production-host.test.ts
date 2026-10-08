import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const forbidden = vi.hoisted(() => ({ image: vi.fn(), production: vi.fn(), directions: vi.fn(), qualification: vi.fn() }));
vi.mock('../../worker/logo-generative-asset-store', () => ({ createLogoGenerativeAssetStore: forbidden.image }));
vi.mock('../../worker/logo-production-asset-store', () => ({ createLogoProductionAssetStore: forbidden.production }));
vi.mock('../../worker/logo-directions-asset-store', () => ({ createLogoDirectionsAssetStore: forbidden.directions }));
vi.mock('../../worker/logo-production-qualification', () => ({ createLogoProductionRuntimeQualification: forbidden.qualification }));
import { startLogoProductionHost } from '../../worker/logo-production-host';
import { proposalHostFixture, deferred } from './logo-vector-proposal-host-fixture';
function hostFixture() {
 const f = proposalHostFixture(), binding = { ownerId: f.job.ownerId, roleName: 'fluid_logo_worker_proposal_host', roleOid: 1234 };
 const client = Object.assign(new EventEmitter(), { query: vi.fn(async (q: { text: string; values: unknown[] }) => {
  if (q.text.includes('session_user')) return { rows: [{ role_name: binding.roleName, active_role: binding.roleName, role_oid: '1234', owner_id: binding.ownerId }] };
  return f.query(q.text, q.values);
 }), release: vi.fn(), end: vi.fn(async () => {}) });
 const pool = { connect: vi.fn(async () => client) };
 return { ...f, client, pool, options: { enabled: true as const, binding, pool, workerId: 'proposal-host', proposals: f.proposals, pollMs: 10 } };
}
afterEach(() => vi.useRealTimers());
describe('proposal-only production host', () => {
 it('qualifies exact DB identity without constructing an asset adapter or rendering engine', async () => {
  const f = hostFixture(), host = await startLogoProductionHost(f.options);
  expect(host.status).toBe('qualified'); if (host.status !== 'qualified') return;
  expect(host.manifest).toEqual([f.capability]); expect(f.events).toEqual(['select fluid_private.logo_worker_owner()::text as owner_id']);
  for (const fn of Object.values(forbidden)) expect(fn).not.toHaveBeenCalled();
  await host.close(); expect(f.transport.createResponse).not.toHaveBeenCalled();
 });
 it('stops admission but drains an already-dispatched billed response through the checked pool', async () => {
  const f = hostFixture(), dispatched = deferred<void>(), response = deferred<ReturnType<typeof f.response>>();
  f.transport.createResponse.mockImplementation(async () => { dispatched.resolve(); return response.promise; });
  const host = await startLogoProductionHost(f.options); expect(host.status).toBe('qualified'); if (host.status !== 'qualified') return;
  const signal = new AbortController(), running = host.run(signal.signal); await dispatched.promise; signal.abort();
  let drained = false; const closing = host.close().then(() => { drained = true; }); await Promise.resolve(); expect(drained).toBe(false);
  response.resolve(f.response()); await Promise.all([running, closing]);
  expect(f.state.completions[0]).toMatchObject({ 3: 'succeeded', 4: 68 }); expect(drained).toBe(true); expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
  expect(f.events.filter(s => s.includes('claim_logo_job'))).toHaveLength(1);
  for (const fn of Object.values(forbidden)) expect(fn).not.toHaveBeenCalled();
 });
 it('never physically dispatches after close during token counting', async () => {
  const f = hostFixture(), counted = deferred<number>(), entered = deferred<void>(); f.transport.countInputTokens.mockImplementation(async () => { entered.resolve(); return counted.promise; });
  const host = await startLogoProductionHost(f.options); expect(host.status).toBe('qualified'); if (host.status !== 'qualified') return;
  const signal = new AbortController(), running = host.run(signal.signal); await entered.promise; signal.abort(); const closing = host.close(); counted.resolve(10); await Promise.all([running, closing]);
  expect(f.transport.createResponse).not.toHaveBeenCalled(); expect(JSON.parse(f.state.completions[0]![5] as string)).toEqual({ error: 'not_dispatched' });
 });
 it('rejects malformed proposal configuration before acquiring a database connection', async () => {
  const f = hostFixture(), host = await startLogoProductionHost({ ...f.options, proposals: { ...f.proposals, configuration: { ...f.configuration, paidCallsApproved: false } as never } });
  expect(host.status).toBe('unavailable'); expect(f.pool.connect).not.toHaveBeenCalled(); await host.close();
 });
 it('keeps its checked pool usable for late evidence after runner deadline uncertainty and host stop', async () => {
  vi.useFakeTimers(); const f = hostFixture(), dispatched = deferred<void>(), response = deferred<ReturnType<typeof f.response>>(), completed = deferred<void>();
  f.transport.createResponse.mockImplementation(async () => { dispatched.resolve(); return response.promise; });
  const original = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, values) => { const result = await original(sql, values); if (sql.includes('complete_logo_job_step')) completed.resolve(); return result; });
  const host = await startLogoProductionHost(f.options); expect(host.status).toBe('qualified'); if (host.status !== 'qualified') return;
  const signal = new AbortController(), running = host.run(signal.signal); await dispatched.promise;
  await vi.advanceTimersByTimeAsync(f.textPolicy.deadlineMs); await completed.promise;
  expect(f.state.completions[0]).toMatchObject({ 3: 'ambiguous', 4: 0 }); signal.abort();
  let drained = false; const closing = host.close().then(() => { drained = true; }); await Promise.resolve(); expect(drained).toBe(false);
  const acquisitions = f.pool.connect.mock.calls.length; response.resolve(f.response()); await Promise.all([running, closing]);
  expect(f.pool.connect.mock.calls.length).toBeGreaterThan(acquisitions);
  expect(f.events.some(sql => sql.includes('record_logo_provider_response'))).toBe(true); expect(f.events.some(sql => sql.includes('stage_logo_vector_proposal'))).toBe(true);
  expect(f.transport.createResponse).toHaveBeenCalledTimes(1); expect(drained).toBe(true);
 });

});
