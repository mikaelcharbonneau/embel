import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createTestDatabase, resetFixture, OWNER_A, type TestDatabase } from './local-supabase';
import { installDirectionsStorageFixture, directionsStorageFixture, workerId } from './logo-directions-storage-fixture';
import { createLogoDirectionsStorageAuthorization } from '../../worker/logo-directions-storage-authorization';
import { createLogoDirectionsAssetStore } from '../../worker/logo-directions-asset-store';
import { createLogoDirectionsRuntimeAdapter } from '../../worker/logo-directions/runtime-adapter';
import { createLogoWorkerRuntime } from '../../worker/logo-runtime';
import type { LogoWorkerConnection } from '../../src/server/data/logo-jobs';
import type { ChatGPTTransport } from '../../src/server/ai/chatgpt-transport';

type Failure = 'none' | 'font_corrupt' | 'font_missing' | 'record_ack' | 'stage_ack' | 'complete_ack' | 'wrong_account' | 'wrong_response' | 'cancel' | 'new_head';
/** All Auth/Storage/Responses transport is local synthetic evidence. Actual SQL
 * admission/lease/read/publication/complete and installed pinned fonts are used. */
describe('actual directions handler through private Storage and durable completion', () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); await installDirectionsStorageFixture(db); }, 60_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); }, 60_000);
  async function fixture(failure: Failure = 'none', withFont = true) {
    const f = await directionsStorageFixture(db); await f.enable();
    const prepared = await f.prepareDirections({ claim: false, withFont }), jobId = prepared.admission.jobIds[0]!;
    const events: string[] = [], manifests: unknown[] = []; let count = 0, stagedBeforeComplete = false; const providerErrors: string[] = [];
    const connection: LogoWorkerConnection = { async query<Row>(sql: string, args?: unknown[]) {
      events.push(sql);
      if (sql.includes('report_logo_worker_ready')) manifests.push(JSON.parse(String(args?.[1])));
      if (sql.includes('complete_logo_job_step') && args?.[0] === jobId && args[3] === 'succeeded') {
        expect((await db.query('select id from public.logo_direction_records where project_id=$1', [prepared.workspace.projectId])).rows).toHaveLength(0);
        const publication = (await db.query<{ committed_at: unknown }>('select committed_at from public.logo_direction_publications where job_id=$1', [jobId])).rows[0];
        expect(publication?.committed_at).toBeNull(); stagedBeforeComplete = true;
      }
      const result = await f.connection.query<Row>(sql, args);
      const lost = failure === 'record_ack' && sql.includes('record_logo_provider_response') || failure === 'stage_ack' && sql.includes('stage_logo_directions') || failure === 'complete_ack' && sql.includes('complete_logo_job_step');
      if (lost && args?.[0] === jobId) throw Error('Synthetic acknowledgement lost after commit');
      return result;
    } };
    const authorization = createLogoDirectionsStorageAuthorization(f.authConfiguration(), { fetch: f.transport() })!;
    const assets = createLogoDirectionsAssetStore({ connection, authorization })!;
    const transport: ChatGPTTransport = { listModels: vi.fn(), async streamResponse(_request, options) {
      await options.beforeDispatch?.(); count++;
      if (failure === 'font_corrupt') { const p = prepared.fontReservation!.storagePath, b = f.blobs.get(p)!; f.blobs.set(p, { ...b, bytes: new Uint8Array(b.bytes.length) }); }
      if (failure === 'font_missing') f.blobs.delete(prepared.fontReservation!.storagePath);
      if (failure === 'cancel') await f.rpc('request_job_cancel', [jobId]);
      if (failure === 'new_head') { try { await f.rpc('apply_logo_workspace_command', [prepared.workspace.projectId, { method: 'saveLogoBrief', body: { requestKey: crypto.randomUUID(), expected: prepared.workspace.heads, brief: { name: 'Later brief', activity: 'Local fixture', audience: 'Teams', personality: 'Calm', logoTypes: ['wordmark'] } } }]); } catch (error) { providerErrors.push(String(error)); throw error; } }
      return { status: 'completed', response: { id: failure === 'wrong_response' ? 'resp_different' : 'resp_local_directions', status: 'completed', model: f.policy.model,
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(prepared.candidate) }] }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } },
      partialText: '', requestId: null, responseId: 'resp_local_directions', accountId: failure === 'wrong_account' ? 'other-account' : f.policy.registrationId };
    } };
    const adapter = createLogoDirectionsRuntimeAdapter({ ownerId: OWNER_A, policyIdentity: f.policyIdentity, policy: f.policy, expectedAccountId: f.policy.registrationId, transport, connection, assets, assertAvailable: authorization.assertAvailable })!;
    const runtime = createLogoWorkerRuntime({ connection, workerId, manifest: [adapter.capability], composition: { concepts: null, refinements: null, vector: null, exports: null, directions: adapter.dependencies, unavailableReasons: {} } });
    async function close() { authorization.close(); await runtime.close(); }
    return { f, prepared, jobId, runtime, close, events, manifests, providerErrors, count: () => count, stagedBeforeComplete: () => stagedBeforeComplete };
  }
  it('imports real catalog font and canonical approved geometry, stages three directions then commits 12 records with zero writes/API cost', async () => {
    const t = await fixture(); try {
      const before = t.prepared.workspace.approvedLogo, original = t.f.blobs.get(t.prepared.document.storagePath)!.bytes;
      expect(await t.runtime.tick()).toBe('succeeded'); expect(t.count()).toBe(1); expect(t.stagedBeforeComplete()).toBe(true); expect(t.f.http.writes).toBe(0); expect(t.f.http.paths).toEqual([t.prepared.document.storagePath, t.prepared.fontReservation!.storagePath]);
      expect(t.manifests).toHaveLength(1); expect(t.manifests[0]).toEqual([t.f.capability]);
      const records = (await db.query<{ kind: string; record: { approvedLogoId: string } }>('select kind,record from public.logo_direction_records where project_id=$1', [t.prepared.workspace.projectId])).rows;
      expect(records).toHaveLength(12); for (const kind of ['direction', 'palette', 'typography', 'graphics']) expect(records.filter(r => r.kind === kind)).toHaveLength(3); expect(records.every(r => r.record.approvedLogoId === before!.id)).toBe(true);
      const checks = (await db.query<{ record: { styleSupported: boolean; missingCodePoints: number[] } }>('select record from public.logo_direction_font_checks where project_id=$1', [t.prepared.workspace.projectId])).rows;
      expect(checks).toHaveLength(3); expect(checks.every(r => r.record.styleSupported && r.record.missingCodePoints.length === 0)).toBe(true);
      expect((await t.f.workspace(t.prepared.workspace.projectId)).approvedLogo).toEqual(before); expect(t.f.blobs.get(t.prepared.document.storagePath)!.bytes).toEqual(original);
      expect((await db.query('select state,billing_mode,actual_cost_microusd from public.jobs where id=$1', [t.jobId])).rows).toEqual([{ state: 'succeeded', billing_mode: 'chatgpt_subscription', actual_cost_microusd: 0 }]);
      expect(await t.runtime.tick()).toBe('idle'); expect(t.count()).toBe(1);
    } finally { await t.close(); }
  }, 60_000);
  it.each(['missing_receipt', 'revoked_capability', 'empty_fonts'])('prevents provider dispatch for %s metadata denial', async failure => {
    const t = await fixture('none', failure !== 'empty_fonts'); try {
      if (failure === 'missing_receipt') await db.exec("alter table public.logo_input_receipts disable trigger user; delete from public.logo_input_receipts; alter table public.logo_input_receipts enable trigger user;");
      if (failure === 'revoked_capability') await db.exec('update fluid_private.logo_directions_storage_capabilities set enabled=false');
      expect(await t.runtime.tick()).toBe('failed'); expect(t.count()).toBe(0); expect((await db.query('select id from public.logo_provider_responses where job_id=$1', [t.jobId])).rows).toEqual([]); expect(t.f.http.gets).toBe(0);
    } finally { await t.close(); }
  }, 60_000);
  it.each(['font_corrupt', 'font_missing', 'record_ack', 'stage_ack', 'wrong_account', 'wrong_response', 'cancel'] as const)('retains the one completed response under %s without automatic replay or false success', async failure => {
    const t = await fixture(failure); try {
      const result = await t.runtime.tick(); expect(['needs_reconciliation', 'lease_lost']).toContain(result); expect(t.count()).toBe(1);
      expect((await db.query('select id from public.logo_direction_records where project_id=$1', [t.prepared.workspace.projectId])).rows).toEqual([]);
      const rows = (await db.query<{ observation: unknown }>('select observation from public.logo_provider_responses where job_id=$1', [t.jobId])).rows; expect(rows).toHaveLength(1);
      if (failure !== 'cancel') {
        const step = (await db.query<{ output: unknown }>('select output from public.job_steps where job_id=$1', [t.jobId])).rows[0]!;
        expect(step.output).toHaveProperty('result.kind', 'logo_directions_unpublished'); expect(step.output).toHaveProperty('result.payload');
      }
      expect(await t.runtime.tick()).toBe('idle'); expect(t.count()).toBe(1); expect(t.f.http.writes).toBe(0);
    } finally { await t.close(); }
  }, 60_000);
  it('retains committed completion after its acknowledgement is lost, without reporting success or replaying', async () => {
    const t = await fixture('complete_ack'); try {
      expect(await t.runtime.tick()).toBe('lease_lost'); expect(t.count()).toBe(1);
      expect((await db.query('select id from public.logo_direction_records where project_id=$1', [t.prepared.workspace.projectId])).rows).toHaveLength(12);
      expect((await db.query('select committed_at from public.logo_direction_publications where job_id=$1', [t.jobId])).rows[0]).not.toHaveProperty('committed_at', null);
      expect(await t.runtime.tick()).toBe('idle'); expect(t.count()).toBe(1);
    } finally { await t.close(); }
  }, 60_000);
  it('retains frozen result against a changed head and leaves the newer head untouched', async () => {
    const t = await fixture('new_head'); try {
      const outcome = await t.runtime.tick(); expect(outcome, JSON.stringify(t.providerErrors)).toBe('succeeded'); expect(t.count()).toBe(1);
      const w = await t.f.workspace(t.prepared.workspace.projectId); expect(w.stages.brief_references!.id).not.toBe(t.prepared.workspace.stages.brief_references!.id); expect(w.stages.directions).toBeNull();
      const publication = (await db.query<{ input_hash: string; committed_at: unknown; stage_revision: unknown }>('select input_hash,committed_at,stage_revision from public.logo_direction_publications where job_id=$1', [t.jobId])).rows[0]!;
      expect(publication.input_hash).toBe(t.prepared.quote.inputHash); expect(publication.committed_at).not.toBeNull(); expect(publication.stage_revision).toBeNull();
      const frozen = (await db.query<{ source: unknown }>('select source from public.logo_direction_inputs where job_id=$1', [t.jobId])).rows[0]!; expect(frozen.source).toEqual(t.prepared.source);
    } finally { await t.close(); }
  }, 60_000);
});
