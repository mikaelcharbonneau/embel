import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createTestDatabase, type TestDatabase } from './local-supabase';
import { proposalAdmissionFixture, WORKER } from './logo-vector-proposal-admission-fixture';
import { freezeLogoWorkerManifest } from '../../worker/logo-readiness';
import { startLogoProductionWorker } from '../../worker/logo-production-startup';
import { providerFixture } from '../server/logo-vector-proposal-provider-fixtures';
import { logoVectorProposalRecordSchema } from '@/domain/logo-vector-proposal-jobs';
import { completionLedger } from './logo-vector-proposal-completion-fixture';
const candidates = await Promise.all(['logo-vector-proposals.sql', 'logo-vector-proposal-quotes.sql', 'logo-vector-proposal-admission.sql', 'logo-vector-proposal-observations.sql', 'logo-vector-proposal-completion.sql', 'logo-vector-proposal-capabilities.sql'].map(name => readFile(new URL('../../supabase/candidates/' + name, import.meta.url), 'utf8')));
let db: TestDatabase;
beforeAll(async () => { db = await createTestDatabase({ additionalMigrations: candidates }); }, 60_000);
afterAll(async () => { await db?.close(); });
it.each(['proposed', 'unsupported', 'invalid', 'unknown'] as const)('runs %s evidence through real startup, JobStore, restricted SQL and owner reload', async mode => {
 const f = await proposalAdmissionFixture(db), accepted = await f.admitted(), provider = providerFixture(); void accepted;
 await db.exec(`grant execute on function fluid_private.logo_worker_owner(),public.register_logo_job_plan(uuid,uuid,jsonb),fluid_private.stage_logo_vector_proposal(uuid,uuid,jsonb,uuid) to ${WORKER};`);
 provider.transport.createResponse.mockImplementation(async () => {
  const response = provider.response();
  if (mode === 'unsupported') response.body.output[0]!.content[0]!.text = JSON.stringify({ version: 1, status: 'unsupported', code: 'multiple_changes', explanation: 'The synthetic request needs more than one independent change.' });
  if (mode === 'invalid') response.body.output[0]!.content[0]!.text = 'invalid JSON';
  if (mode === 'unknown') return { ...response, body: { ...response.body, usage: undefined } };
  return response;
 });
 await f.worker(async () => {
  const startup = await startLogoProductionWorker({ enabled: true, ownerId: f.workspace.ownerId, workerId: 'proposal-fixture', connection: db,
   proposals: { capability: freezeLogoWorkerManifest([f.descriptor])[0]!, configuration: { operation: 'identity.logo_vector_propose', paidCallsApproved: true, textPolicy: provider.textPolicy }, transport: provider.transport } });
  expect(startup.status).toBe('ready'); if (startup.status !== 'ready') throw Error('Expected restricted runtime');
  try { expect(await startup.runtime.tick()).toBe(mode === 'unknown' ? 'needs_reconciliation' : mode === 'invalid' ? 'failed' : 'succeeded'); expect(await startup.runtime.tick()).toBe('idle'); }
  finally { await startup.close(); }
 });
 expect(provider.transport.createResponse).toHaveBeenCalledTimes(1);
 const row = (await db.query<{ id: string; job_id: string }>('select id,job_id from fluid_private.logo_vector_proposals')).rows[0]!;
 const result = logoVectorProposalRecordSchema.parse(await f.rpc('read_logo_vector_proposal', [f.workspace.projectId, row.id]));
 expect(result).toMatchObject({ state: mode === 'unknown' ? 'needs_reconciliation' : mode === 'invalid' ? 'failed' : 'succeeded', materialization: 'unavailable', actualCostMicrousd: mode === 'unknown' ? 0 : 68 });
 if (mode === 'proposed' || mode === 'unsupported') expect(result.payload?.status).toBe(mode);
 const ledger = await completionLedger(db, row.job_id);
 expect(ledger).toMatchObject({ account: { provider_actual_microusd: mode === 'unknown' ? 0 : 68, spent_microusd: mode === 'unknown' ? 0 : 68, reserved_microusd: mode === 'unknown' ? 122880 : 0 }, reservation: { state: mode === 'unknown' ? 'active' : 'settled' } });
 expect((await db.query('select * from public.logo_asset_publications')).rows).toEqual([]);
 expect((await db.query('select id from public.logo_vector_revisions')).rows).toHaveLength(1);
});
it('recovers an over-cap bill and output after lost observation acknowledgement without capture replay', async () => {
 const f = await proposalAdmissionFixture(db); await f.admitted(); const provider = providerFixture();
 await db.exec(`grant execute on function fluid_private.logo_worker_owner(),public.register_logo_job_plan(uuid,uuid,jsonb),fluid_private.stage_logo_vector_proposal(uuid,uuid,jsonb,uuid) to ${WORKER};`);
 provider.transport.createResponse.mockImplementation(async () => { const response = provider.response(); response.body.usage.input_tokens = 100000; response.body.usage.total_tokens = 100005; return response; });
 let lost = false;
 const connection = { async query<Row>(sql: string, values?: unknown[]) {
  const result = await db.query<Row>(sql, values);
  if (sql.includes('record_logo_provider_response') && !lost) { lost = true; throw Error('Synthetic lost committed observation acknowledgement'); }
  return result;
 } };
 await f.worker(async () => {
  const startup = await startLogoProductionWorker({ enabled: true, ownerId: f.workspace.ownerId, workerId: 'proposal-fixture', connection,
   proposals: { capability: freezeLogoWorkerManifest([f.descriptor])[0]!, configuration: provider.configuration, transport: provider.transport } });
  expect(startup.status).toBe('ready'); if (startup.status !== 'ready') throw Error('Expected restricted startup');
  try { expect(await startup.runtime.tick()).toBe('needs_reconciliation'); expect(await startup.runtime.tick()).toBe('idle'); } finally { await startup.close(); }
 });
 const row = (await db.query<{ id: string; job_id: string }>('select id,job_id from fluid_private.logo_vector_proposals')).rows[0]!;
 const result = logoVectorProposalRecordSchema.parse(await f.rpc('read_logo_vector_proposal', [f.workspace.projectId, row.id]));
 expect(result).toMatchObject({ state: 'needs_reconciliation', actualCostMicrousd: 200048, payload: { status: 'proposed' } });
 expect((await completionLedger(db, row.job_id)).account).toMatchObject({ spent_microusd: 122880, provider_actual_microusd: 200048 });
 expect((await db.query('select * from public.logo_provider_responses')).rows).toHaveLength(1);
 expect((await db.query('select * from fluid_private.logo_vector_proposal_prepared_results')).rows).toHaveLength(1);
 expect(provider.transport.createResponse).toHaveBeenCalledTimes(1);
});
