import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createTestDatabase, type TestDatabase, OWNER_A, OWNER_B } from './local-supabase';
import { materializationCandidates, materializationFixture } from './logo-vector-proposal-materialization-fixture';
import { completionLedger, proposalCompletionFixture } from './logo-vector-proposal-completion-fixture';
import { proposalObservation } from '../server/logo-vector-proposal-fixtures';
let db: TestDatabase;
beforeAll(async () => { db = await createTestDatabase({ additionalMigrations: materializationCandidates }); }, 60_000);
afterAll(async () => { await db?.close(); });
const count = async (table: string) => (await db.query<{ n: number }>(`select count(*)::int n from ${table}`)).rows[0]!.n;
it('appends one review-required candidate, association and exact-body receipt with zero new AI expense', async () => {
  const f = await materializationFixture(db), before = await completionLedger(db, f.j.id), old = await f.rpc('read_logo_vector_proposal', [f.workspace.projectId, f.prepared.id]);
  expect(await f.read()).toMatchObject({ proposal: { state: 'succeeded', materialization: 'unavailable' }, preparedId: f.prepared.id, providerResponseReceiptId: f.prepared.providerResponseReceiptId, eligible: true, materialization: null });
  expect(await f.preflight()).toBeNull();
  const receipt = await f.apply(), vector = (await db.query<{ record: unknown }>('select record from public.logo_vector_revisions where id=$1', [receipt.revision.payload.vectorRevisionId])).rows[0]!.record;
  expect(vector).toMatchObject({ reviewStatus: 'review_required', parentRevisionId: f.source.revision.id, locks: f.source.revision.locks });
  expect(await f.read()).toMatchObject({ eligible: false, materialization: { version: 1, ownerId: OWNER_A, projectId: f.workspace.projectId, proposalId: f.prepared.id, requestKey: f.command.body.requestKey, vectorRevisionId: receipt.revision.payload.vectorRevisionId, revisionId: receipt.revision.id } });
  expect(await f.rpc('read_logo_vector_proposal', [f.workspace.projectId, f.prepared.id])).toEqual(old);
  expect(await completionLedger(db, f.j.id)).toEqual(before);
  expect(await count('public.logo_approvals')).toBe(0); expect(await count('public.logo_vector_revisions')).toBe(2); expect(await count('public.asset_versions')).toBe(7);
  expect((await db.query('select method,input from public.logo_workspace_requests where request_key=$1', [f.command.body.requestKey])).rows).toEqual([{ method: 'applyLogoVectorProposal', input: f.command }]);
});
it('returns exact original receipt before producer evidence and after newer heads without rewriting history', async () => {
  const f = await materializationFixture(db), receipt = await f.apply();
  await f.rpc('apply_logo_workspace_command', [f.workspace.projectId, { method: 'saveLogoBrief', body: { requestKey: randomUUID(), expected: (await f.rpc('get_logo_workspace', [f.workspace.projectId]) as { heads: unknown }).heads, brief: { name: 'Newer', activity: 'Studio', audience: '', personality: '', logoTypes: ['combination'] } } }]);
  const current = await f.rpc('get_logo_workspace', [f.workspace.projectId]);
  expect(await f.preflight()).toEqual(receipt); expect(await f.apply(f.command, {})).toEqual(receipt);
  expect(await f.rpc('get_logo_workspace', [f.workspace.projectId])).toEqual(current); expect(await count('public.logo_vector_revisions')).toBe(2);
  await expect(f.preflight({ ...f.command, body: { ...f.command.body, proposalId: randomUUID() } })).rejects.toMatchObject({ code: 'PT409', message: 'logo_request_conflict' });
});
it('conflicts a second key before producer work and retains a separately readable association', async () => {
  const f = await materializationFixture(db); await f.apply(); const changed = { ...f.command, body: { ...f.command.body, requestKey: randomUUID() } };
  await expect(f.preflight(changed)).rejects.toMatchObject({ code: 'PT409', message: 'logo_proposal_already_materialized' });
  await expect(f.apply(changed)).rejects.toMatchObject({ code: 'PT409', message: 'logo_proposal_already_materialized' });
  expect(await f.read()).toMatchObject({ eligible: false, materialization: { requestKey: f.command.body.requestKey } });
});
it.each([{ finish: false }, { cancel: true }])('rejects provisional or late-cancelled success: %j', async options => {
  const f = await materializationFixture(db, options);
  expect(await f.rpc('read_logo_vector_proposal', [f.workspace.projectId, f.prepared.id])).toMatchObject({ state: 'succeeded' });
  expect(await f.read()).toMatchObject({ eligible: false });
  await expect(f.preflight()).rejects.toMatchObject({ code: 'PT409', message: 'logo_proposal_not_materializable' });
  await expect(f.apply()).rejects.toMatchObject({ code: 'PT409', message: 'logo_proposal_not_materializable' });
  expect(await count('public.logo_vector_revisions')).toBe(1); expect(await count('public.asset_versions')).toBe(5);
});
it('rejects unknown provider billing and reconciliation-only retained intent', async () => {
  const f = await proposalCompletionFixture(db, { observation: { ...proposalObservation(), usage: null, billing: { status: 'unknown', confirmedMicrousd: null } } }), p = await f.stage();
  await f.complete('ambiguous', 0, { error: 'provider_billing_unknown', result: { version: 1, kind: 'logo_vector_proposal', preparedId: p.id, providerResponseReceiptId: p.providerResponseReceiptId } });
  expect(await f.rpc('read_logo_vector_proposal_application', [f.workspace.projectId, p.id])).toMatchObject({ eligible: false, materialization: null });
});
it.each(['reservation', 'captured', 'account', 'step', 'dispatch'])('fails closed when authoritative %s accounting/binding differs', async anomaly => {
  const f = await materializationFixture(db);
  if (anomaly === 'reservation') await db.query("update public.usage_reservations set state='active' where job_id=$1", [f.j.id]);
  if (anomaly === 'captured') await db.query('update public.usage_reservations set captured_microusd=33 where job_id=$1', [f.j.id]);
  if (anomaly === 'account') await db.query('update public.usage_accounts set provider_actual_microusd=0 where owner_id=$1', [OWNER_A]);
  if (anomaly === 'step') await db.query("update public.job_steps set output=jsonb_set(output,'{preparedId}',to_jsonb($2::text)) where job_id=$1", [f.j.id, randomUUID()]);
  if (anomaly === 'dispatch') await db.query("update public.jobs set worker_id='different-worker' where id=$1", [f.j.id]);
  expect(await f.read()).toMatchObject({ eligible: false }); await expect(f.apply()).rejects.toMatchObject({ code: 'PT409', message: 'logo_proposal_not_materializable' });
});
it('rechecks exact expected heads and source basis after staged writes', async () => {
  const f = await materializationFixture(db);
  await f.rpc('apply_logo_workspace_command', [f.workspace.projectId, { method: 'saveLogoBrief', body: { requestKey: randomUUID(), expected: f.workspace.heads, brief: { name: 'Newer', activity: 'Studio', audience: '', personality: '', logoTypes: ['combination'] } } }]);
  await expect(f.apply()).rejects.toMatchObject({ code: 'PT409' }); expect(await count('public.asset_versions')).toBe(5);
  const changed = { ...f.command, body: { ...f.command.body, expected: (await f.rpc('get_logo_workspace', [f.workspace.projectId]) as { heads: unknown }).heads } };
  await expect(f.apply(changed)).rejects.toMatchObject({ code: 'PT409' });
});
it.each(['proposalId','preparedId','providerResponseReceiptId','baseVectorRevisionId','contextHash','baseRevision','brief','fonts','locks'])('rejects substituted %s evidence atomically', async field => {
  const f = await materializationFixture(db), e = structuredClone(f.evidence) as Record<string, unknown>;
  e[field] = field === 'fonts' || field === 'locks' ? [{}] : field === 'baseRevision' || field === 'brief' ? {} : field === 'contextHash' ? 'a'.repeat(64) : randomUUID();
  await expect(f.apply(f.command, e)).rejects.toBeDefined(); expect(await count('public.asset_versions')).toBe(5); expect(await count('public.logo_vector_revisions')).toBe(1);
});
it('rechecks current font rights records and exact immutable source bindings', async () => {
  const f = await materializationFixture(db);
  await db.exec('alter table public.logo_font_records disable trigger logo_font_records_immutable');
  await db.query("update public.logo_font_records set record=jsonb_set(record,'{rights,permissions,outline}','\"denied\"') where record_id=$1", [f.source.fonts[0]!.id]);
  await db.exec('alter table public.logo_font_records enable trigger logo_font_records_immutable');
  await expect(f.apply()).rejects.toMatchObject({ code: 'PT409', message: 'logo_proposal_source_changed' });
  expect(await count('public.asset_versions')).toBe(5);
});
it.each(['reserved', 'wrong-key', 'same-member', 'foreign-member'])('rejects %s publication receipts without partial commit', async anomaly => {
  const f = await materializationFixture(db), e = { ...f.evidence };
  if (anomaly === 'reserved') await db.query("update public.logo_asset_publications set state='reserved',verification=null where id=$1", [e.svgPublicationId]);
  if (anomaly === 'wrong-key') e.svgPublicationId = await f.publication('svg', randomUUID());
  if (anomaly === 'same-member') e.svgPublicationId = e.documentPublicationId;
  if (anomaly === 'foreign-member') e.svgPublicationId = randomUUID();
  await expect(f.apply(f.command, e)).rejects.toMatchObject({ code: '55000', message: 'invalid_logo_vector_members' });
  expect(await count('public.asset_versions')).toBe(5); expect(await count('public.logo_vector_revisions')).toBe(1);
});
it.each([false,true])('cancels exact proposal command before or after staged writes (%s), with unchanged history and durable recovery', async staged => {
  const f = await materializationFixture(db, { stage: staged });
  expect(await f.preflight()).toBeNull();
  const expected = { status: 'cancelled', ownerId: OWNER_A, projectId: f.workspace.projectId, requestKey: f.command.body.requestKey, command: f.command };
  expect(await f.rpc('cancel_logo_vector_edit', [f.workspace.projectId, f.command])).toEqual(expected);
  if (!staged) await f.stage();
  expect(await f.rpc('read_logo_vector_edit_request', [f.workspace.projectId, f.command.body.requestKey])).toEqual(expected);
  await expect(f.preflight()).rejects.toMatchObject({ code: 'PT409', message: 'logo_edit_cancelled' });
  await expect(f.apply()).rejects.toMatchObject({ code: 'PT409', message: 'logo_edit_cancelled' });
  expect(await count('public.asset_versions')).toBe(5); expect(await f.rpc('get_logo_workspace', [f.workspace.projectId])).toEqual(f.workspace);
});
it('after committed acknowledgment loss cancellation returns the original receipt, never a tombstone', async () => {
  const f = await materializationFixture(db), receipt = await f.apply();
  expect(await f.rpc('cancel_logo_vector_edit', [f.workspace.projectId, f.command])).toEqual({ status: 'succeeded', ownerId: OWNER_A, projectId: f.workspace.projectId, requestKey: f.command.body.requestKey, command: f.command, receipt });
  expect(await count('public.logo_vector_edit_cancellations')).toBe(0);
});
it('isolates owner reads and keeps retained proposal and association immutable', async () => {
  const f = await materializationFixture(db); await f.apply();
  await expect(f.rpc('read_logo_vector_proposal_application', [f.workspace.projectId, f.prepared.id], OWNER_B)).rejects.toMatchObject({ code: 'P0002' });
  for (const table of ['fluid_private.logo_vector_proposal_materializations','fluid_private.logo_vector_proposals']) {
    await expect(db.exec(`update ${table} set owner_id=owner_id`)).rejects.toMatchObject({ code: '55000' });
    await expect(db.exec(`delete from ${table}`)).rejects.toMatchObject({ code: '55000' });
  }
});

it('retains saved component locks and never infers unlock authority from fresh caller evidence', async () => {
  const f = await materializationFixture(db, { locked: true });
  await expect(f.apply(f.command, { ...f.evidence, locks: [] })).rejects.toMatchObject({ code: 'PT409' });
  const receipt = await f.apply();
  expect((await db.query<{ record: { locks: unknown } }>('select record from public.logo_vector_revisions where id=$1', [receipt.revision.payload.vectorRevisionId])).rows[0]!.record.locks).toEqual(f.source.revision.locks);
});
it('rejects extra caller edits and malformed proposal cancellation without broadening legacy methods', async () => {
  const f = await materializationFixture(db);
  for (const command of [{ ...f.command, body: { ...f.command.body, edit: { kind: 'rotation', degrees: 30 } } }, { ...f.command, body: { ...f.command.body, baseVectorRevisionId: null } }, { ...f.command, method: 'unknown' }]) {
    await expect(f.rpc('cancel_logo_vector_edit', [f.workspace.projectId, command])).rejects.toMatchObject({ code: '22023' });
    await expect(f.apply(command)).rejects.toMatchObject({ code: '22023' });
  }
});

it.each(['sourcePreview','documentAsset','svgAsset','font'])('rejects changed committed original %s publication and returns ineligible', async member => {
  const f = await materializationFixture(db), reference = member === 'font' ? f.source.fonts[0]!.asset : f.source.revision[member as 'sourcePreview' | 'documentAsset' | 'svgAsset'];
  await db.query("update public.logo_asset_publications set state='reserved',verification=null where version_id=$1", [reference.versionId]);
  expect(await f.read()).toMatchObject({ eligible: false });
  await expect(f.apply()).rejects.toMatchObject({ code: 'PT409', message: 'logo_proposal_source_changed' });
  expect(await count('public.asset_versions')).toBe(5);
});
it.each(['unchanged','viewBox','componentCount'])('rejects %s candidate proof at the SQL boundary', async anomaly => {
  const f = await materializationFixture(db), e = structuredClone(f.evidence);
  if (anomaly === 'unchanged') { e.documentHash = f.source.revision.documentHash; e.proof = f.source.revision.proof; }
  if (anomaly === 'viewBox') e.proof.viewBox = [0, 0, 2000, 500];
  if (anomaly === 'componentCount') e.proof.componentCount = 1;
  await expect(f.apply(f.command, e)).rejects.toMatchObject({ code: 'PT409', message: 'logo_proposal_source_changed' });
  expect(await count('public.asset_versions')).toBe(5);
});

it('rejects substituted apply base or original expected heads during preflight before producer I/O', async () => {
  const f = await materializationFixture(db);
  await expect(f.preflight({ ...f.command, body: { ...f.command.body, baseVectorRevisionId: randomUUID() } })).rejects.toMatchObject({ code: 'PT409', message: 'logo_proposal_source_changed' });
  await expect(f.preflight({ ...f.command, body: { ...f.command.body, expected: { ...f.command.body.expected, workspaceRevision: f.command.body.expected.workspaceRevision + 1 } } })).rejects.toMatchObject({ code: 'PT409', message: 'logo_proposal_source_changed' });
});
