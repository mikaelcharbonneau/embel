import { beforeAll, afterAll, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createTestDatabase, type TestDatabase } from './local-supabase';
import { integratedCandidates, vectorFeatureFixture } from './logo-vector-feature-integration-fixture';
import { completionLedger } from './logo-vector-proposal-completion-fixture';
import { LogoUncertainCommitError } from '@/server/data/logo-transaction';
let db: TestDatabase;
beforeAll(async () => { db = await createTestDatabase({ additionalMigrations: integratedCandidates }); }, 60_000);
afterAll(async () => { await db?.close(); });

it.each([false, true])('quotes actual owned bytes, runs actual host/provider/SQL, shapes and commits with lost-COMMIT=%s', async loseCommitAck => {
  const f = await vectorFeatureFixture(db, { loseCommitAck });
  expect(f.inferenceCalls()).toBe(0);
  expect(await f.rpc('admit_logo_operation', [f.projectId, f.intent])).toEqual(f.admission);
  expect(await f.runHost()).toMatchObject([{ operation: 'identity.logo_vector_propose' }]);
  const proposal = await f.retained(), command = await f.command();
  expect(proposal).toMatchObject({ state: 'succeeded', actualCostMicrousd: 68, payload: { status: 'proposed', edit: { kind: 'spacing', letterSpacing: 2 } } });
  expect((await f.application(proposal.id)).eligible).toBe(true);
  const paid = await completionLedger(db, f.jobId);
  expect(paid).toMatchObject({ account: { provider_actual_microusd: 68, spent_microusd: 68, reserved_microusd: 0 }, reservation: { state: 'settled' } });
  const apply = () => f.services.workspace.applyLogoVectorProposal(f.auth, f.projectId, command.body);
  if (loseCommitAck) await expect(apply()).rejects.toBeInstanceOf(LogoUncertainCommitError);
  const beforeRecovery = f.counts(), receipt = await apply();
  if (loseCommitAck) expect(f.counts()).toEqual(beforeRecovery);
  if (receipt.revision.stage !== 'refinements' || !receipt.revision.payload.vectorRevisionId) throw Error('Missing actual candidate');
  const vector = await f.services.workspace.readLogoVectorDetail(f.auth, f.projectId, receipt.revision.payload.vectorRevisionId);
  expect(vector.document.components[0]).toEqual(f.source.document.components[0]);
  const text = vector.document.components[1]!; expect(text.editingKind).toBe('editable_text');
  if (text.editingKind !== 'editable_text') throw Error('No actual shaped lettering');
  expect(text.textSource).toMatchObject({ text: 'A\u0301ster', letterSpacing: 2, font: f.font.asset, rightsEvidenceId: f.font.rights.id });
  expect(text.paths).not.toEqual(f.source.document.components[1]!.paths);
  expect(vector.revision).toMatchObject({ parentRevisionId: f.source.revision.id, reviewStatus: 'review_required', locks: f.source.revision.locks });
  expect(receipt.workspace.approvedLogo).toEqual(f.workspace.approvedLogo);
  const current = await f.services.workspace.readLogoCurrentVectorRevisionId(f.auth, f.projectId); expect(current).toBe(vector.revision.id);
  const beforeReplay = f.counts(); expect(await apply()).toEqual(receipt); expect(f.counts()).toEqual(beforeReplay);
  expect(await f.application(proposal.id)).toMatchObject({ eligible: false, materialization: { vectorRevisionId: vector.revision.id } });
  expect((await db.query('select id from public.logo_vector_revisions')).rows).toHaveLength(2);
  expect(await completionLedger(db, f.jobId)).toEqual(paid);
  expect(f.inferenceCalls()).toBe(1);
  expect(f.counts().commits).toBe(1);
}, 60_000);

it('retains and bills a late paid response after owner cancellation without materialization or reinference', async () => {
  const f = await vectorFeatureFixture(db, { holdResponse: true }), startup = await f.start();
  if (startup.status !== 'ready') throw Error('Expected real runtime');
  const tick = startup.runtime.tick(); await f.entered.promise;
  await f.rpc('request_job_cancel', [f.jobId]); f.releaseResponse.resolve();
  try {
    // Cancellation between heartbeats conservatively rejects finish(succeeded).
    // Advance only disposable lease time; the next real tick owns settlement.
    expect(await tick).toBe('lease_lost');
    expect((await completionLedger(db, f.jobId)).job).toMatchObject({ state: 'cancel_requested' });
    await f.serial(() => db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [f.jobId]));
    expect(await startup.runtime.tick()).toBe('idle');
    expect((await completionLedger(db, f.jobId)).job).toMatchObject({ state: 'cancelled' });
  } finally { await startup.close(); }
  const proposal = await f.retained(); expect(proposal.payload?.status).toBe('proposed');
  expect((await f.application(proposal.id)).eligible).toBe(false);
  const command = await f.command(); await expect(f.services.workspace.applyLogoVectorProposal(f.auth, f.projectId, command.body)).rejects.toMatchObject({ code: 'conflict' });
  expect((await completionLedger(db, f.jobId)).account).toMatchObject({ provider_actual_microusd: 68, spent_microusd: 68, reserved_microusd: 0 });
  expect((await db.query('select id from public.logo_vector_revisions')).rows).toHaveLength(1);
  expect(f.inferenceCalls()).toBe(1);
}, 60_000);

it('preserves one exact bill and retained output after a real committed observation loses acknowledgement', async () => {
  const f = await vectorFeatureFixture(db, { loseObservationAck: true }), startup = await f.start();
  if (startup.status !== 'ready') throw Error('Expected real runtime');
  try { expect(await startup.runtime.tick()).toBe('needs_reconciliation'); expect(await startup.runtime.tick()).toBe('idle'); } finally { await startup.close(); }
  const proposal = await f.retained(); expect(proposal).toMatchObject({ state: 'needs_reconciliation', actualCostMicrousd: 68, payload: { status: 'proposed' } });
  expect((await f.application(proposal.id)).eligible).toBe(false);
  expect(await completionLedger(db, f.jobId)).toMatchObject({ job: { state: 'needs_reconciliation', actual_cost_microusd: 68 }, reservation: { state: 'active', actual_microusd: 68, captured_microusd: 68 }, account: { provider_actual_microusd: 68, spent_microusd: 68, reserved_microusd: 122812 } });
  expect((await db.query('select id from public.logo_provider_responses where job_id=$1', [f.jobId])).rows).toHaveLength(1);
  expect((await db.query('select id from fluid_private.logo_vector_proposal_prepared_results where job_id=$1', [f.jobId])).rows).toHaveLength(1);
  expect(f.inferenceCalls()).toBe(1);
  expect((await db.query('select id from public.logo_vector_revisions')).rows).toHaveLength(1);
}, 60_000);
