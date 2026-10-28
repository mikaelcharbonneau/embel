import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { OWNER_A, type TestDatabase } from './local-supabase';
import { installProductionStorageFixture, productionStorageFixture, workerRole, workerId, authUser, sessionId, vectorCapability, exportCapability } from './logo-production-storage-fixture';
import { SYNTHETIC_CONCEPT_READINESS } from './logo-readiness-fixture';
import { legacyLogoCostQuoteSchema as logoCostQuoteSchema, logoDispatchReceiptSchema, type LogoConceptJobInput, type LogoRefinementJobInput } from '../../src/domain/logo-jobs';
import { logoWorkspaceV2Schema, type LogoWorkspaceV2 } from '../../src/domain/logo-workspace';
import type { ClaimedJob } from '../../src/domain/jobs';
import type { IdentityAssetPublication, IdentityAssetReceipt } from '../../src/domain/logo-deliverables';
import type { IdentityAssetReservation } from '../../src/server/data/identity-asset-store';
import { parseClaimedJob } from '../../worker/postgres-store';
import { digestBytes, syntheticPng } from '../features/logo-vector/raster-fixtures';

export { workerRole, workerId, authUser, sessionId };
export const conceptCapability = SYNTHETIC_CONCEPT_READINESS;
export const refinementCapability = { ...conceptCapability, operation: 'identity.logo_refine', policyIdentity: 'e'.repeat(64) } as const;
const candidate = new URL('../../supabase/candidates/logo_generative_storage.sql', import.meta.url);
const activation = new URL('../../supabase/activation/logo_generative_storage.sql', import.meta.url);
const png = (ordinal: number) => syntheticPng(8, 8, (x, y) => [ordinal * 37 % 255, x * 23, y * 19, 255]);

/** Disposable only: installs existing brokers unchanged, then the new candidate.
 * Omitting the candidate is used solely to demonstrate the missing-function RED. */
export async function installGenerativeStorageFixture(db: TestDatabase, options: { candidate?: boolean; activation?: boolean } = {}) {
  await installProductionStorageFixture(db);
  await db.exec(`grant execute on function fluid_private.prepare_logo_input(uuid,jsonb),fluid_private.commit_logo_input(uuid,jsonb,jsonb,jsonb),public.register_logo_job_plan(uuid,uuid,jsonb),public.heartbeat_logo_job(uuid,uuid,integer),public.expire_logo_job_leases() to ${workerRole}`);
  const defaultsBefore = (await db.query('select * from pg_default_acl order by oid')).rows;
  const policiesBefore = (await db.query("select policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='storage' order by policyname")).rows;
  const brokersBefore = (await db.query("select oid,prosrc,proacl from pg_proc where proname in('authorize_logo_storage_reservation','authorize_logo_production_storage','logo_storage_object_allowed','logo_production_storage_object_allowed') order by oid")).rows;
  if (options.candidate !== false) await db.exec(await readFile(candidate, 'utf8'));
  const policiesAfterCandidate = (await db.query("select policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='storage' order by policyname")).rows;
  if (options.candidate !== false && options.activation !== false) await db.exec(await readFile(activation, 'utf8'));
  return { defaultsBefore, policiesBefore, policiesAfterCandidate, brokersBefore };
}

/** Real upload commit, admission, leasing and completion; bytes and provider
 * observations are synthetic. No live Auth, Storage or image provider call. */
export async function generativeStorageFixture(db: TestDatabase) {
  const f = await productionStorageFixture(db);
  await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled) values($1,$2,$3,$4,$5,$6,$7,true)",
    [OWNER_A, refinementCapability.operation, refinementCapability.policyIdentity, refinementCapability.handlerVersion, refinementCapability.provider, refinementCapability.model, refinementCapability.maxCostMicrousd]);
  const ready = await f.connection.query<{ready: boolean}>('select public.report_logo_worker_ready($1,$2,90) ready', [workerId, [conceptCapability, refinementCapability, vectorCapability, exportCapability]]);
  if (!ready.rows[0]?.ready) throw Error('Synthetic generative readiness rejected');
  const workspace = async (projectId: string) => logoWorkspaceV2Schema.parse(await f.rpc('get_logo_workspace', [projectId]));
  const enable = async (capability: typeof conceptCapability | typeof refinementCapability = conceptCapability) => {
    await db.query('insert into fluid_private.logo_generative_storage_capabilities(auth_user_id,operation,policy_identity,enabled) values($1,$2,$3,true) on conflict(auth_user_id,operation) do update set enabled=true,policy_identity=excluded.policy_identity', [authUser, capability.operation, capability.policyIdentity]);
  };
  const authorize = (job: ClaimedJob, reservation: IdentityAssetReservation | null, mode: string, claims = {}, user = authUser) => f.auth(async () =>
    (await db.query<{v: unknown}>('select public.authorize_logo_generative_storage($1,$2,$3,$4) v', [job.id, job.leaseToken, reservation?.id ?? null, mode])).rows[0]!.v, claims, user);
  const getReservation = async (id: string) => (await db.query<{v: IdentityAssetReservation}>('select fluid_private.logo_asset_reservation(r) v from public.logo_asset_publications r where id=$1', [id])).rows[0]!.v;
  async function uploadReference(w: LogoWorkspaceV2, ordinal = 1) {
    const bytes = png(ordinal), contentHash = digestBytes(bytes), requestKey = randomUUID();
    const input = { requestKey, expected: w.heads, aspects: ['shape'], rightsDeclaration: 'I own this synthetic image and permit its display and processing for my logo.' };
    const request = { kind: 'reference_upload', input, file: { contentHash, mimeType: 'image/png', byteLength: bytes.length } };
    await f.connection.query('select fluid_private.prepare_logo_input($1,$2)', [w.projectId, request]);
    const reservation = (await f.connection.query<{v: IdentityAssetReservation}>('select fluid_private.prepare_logo_asset($1,$2,null,null) v', [w.projectId, {
      kind: 'upload', intent: { requestKey, usage: 'logo_reference', contentHash, mimeType: 'image/png', rightsDeclaration: input.rightsDeclaration }, byteLength: bytes.length,
    }])).rows[0]!.v;
    const receipt = (await f.connection.query<{v: IdentityAssetReceipt}>('select fluid_private.observe_logo_asset($1,$2,null,null) v', [reservation.id, { status: 'verified', checkedAt: new Date().toISOString(), contentHash, mimeType: 'image/png', byteLength: bytes.length }])).rows[0]!.v;
    const result = (await f.connection.query<{v: {result: {referenceId: string; asset: IdentityAssetReservation['reference']}}}>('select fluid_private.commit_logo_input($1,$2,$3,$4) v', [w.projectId, request, receipt, 'null'])).rows[0]!.v.result;
    await db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [reservation.storagePath, OWNER_A]);
    f.blobs.set(reservation.storagePath, { bytes, mimeType: 'image/png' });
    return { reference: result, reservation: await getReservation(reservation.id), bytes, request };
  }
  async function admit(w: LogoWorkspaceV2, request: Record<string, unknown>) {
    const quote = logoCostQuoteSchema.parse(await f.rpc('quote_logo_operation', [w.projectId, { ...request, expected: w.heads }]));
    const receipt = logoDispatchReceiptSchema.parse(await f.rpc('admit_logo_operation', [w.projectId, { requestKey: randomUUID(), quoteId: quote.id, acceptedMaxCostMicrousd: quote.maxCostMicrousd, expected: w.heads }]));
    const job = parseClaimedJob((await f.connection.query('select * from public.claim_logo_job($1,300)', [workerId])).rows[0]);
    if (!receipt.jobIds.includes(job.id)) throw Error('Unexpected synthetic generative job');
    for (const id of receipt.jobIds.filter(id => id !== job.id)) await f.rpc('request_job_cancel', [id]);
    return job;
  }
  async function prepareConcept(referenceCount = 1) {
    let w = logoWorkspaceV2Schema.parse(await f.rpc('start_logo_project', [{ requestKey: randomUUID(), brief: { name: 'Synthetic generative fixture', activity: 'Local tests', audience: 'Testers', personality: 'Calm', logoTypes: ['wordmark'] } }]));
    const uploaded = [];
    for (let ordinal = 1; ordinal <= referenceCount; ordinal++) uploaded.push(await uploadReference(w, ordinal));
    if (uploaded.length) {
      await f.rpc('apply_logo_workspace_command', [w.projectId, { method: 'saveLogoReferences', body: { requestKey: randomUUID(), expected: w.heads, selections: uploaded.map(item => ({ referenceId: item.reference.referenceId, aspects: ['shape'] })) } }]);
      w = await workspace(w.projectId);
    }
    const snapshot = (await db.query<{id: string}>('select reference_snapshot_id id from public.logo_stage_revisions where id=$1', [w.stages.brief_references!.id])).rows[0]!.id;
    const job = await admit(w, { operation: 'concepts', briefRevisionId: w.stages.brief_references!.id, referenceSnapshotId: snapshot });
    return { job, references: uploaded.map(item => item.reference), reservations: uploaded.map(item => item.reservation), bytes: uploaded.map(item => item.bytes), uploaded, workspace: w };
  }
  async function reserve(job: ClaimedJob, overrides: Partial<IdentityAssetPublication> = {}) {
    const input = job.input as LogoConceptJobInput | LogoRefinementJobInput;
    const sourceId = input.operation === 'identity.logo_concept' ? input.attemptId : input.rasterRevisionId;
    const bytes = png(input.operation === 'identity.logo_concept' ? 5 : 6);
    const inputRevisions = (await f.connection.query<{v: IdentityAssetPublication['inputRevisions']}>("select public.read_leased_logo_record($1,$2,'input_revisions',null) v", [job.id, job.leaseToken])).rows[0]!.v;
    const publication: IdentityAssetPublication = { requestKey: sourceId, source: { kind: 'concept', sourceId }, inputRevisions, mimeType: 'image/png', contentHash: digestBytes(bytes), byteLength: bytes.length, ...overrides };
    const reservation = (await f.connection.query<{v: IdentityAssetReservation}>('select fluid_private.prepare_logo_asset($1,$2,$3,$4) v', [job.projectId, { kind: 'stage', publication }, job.id, job.leaseToken])).rows[0]!.v;
    return { reservation, publication, bytes };
  }
  async function completeSynthetic(job: ClaimedJob) {
    const input = job.input as LogoConceptJobInput | LogoRefinementJobInput;
    const stepKey = input.operation === 'identity.logo_concept' ? `logo-preview-v1:${input.slotId}:${input.attemptId}` : 'generate-refinement';
    await f.connection.query('select public.begin_logo_job_step($1,$2,$3,$4,100)', [job.id, job.leaseToken, stepKey, `${job.id}:${stepKey}`]);
    const { reservation, publication, bytes } = await reserve(job);
    // Direct fixture seed: subsequent reads still traverse real Storage RLS.
    await db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [reservation.storagePath, OWNER_A]);
    f.blobs.set(reservation.storagePath, { bytes, mimeType: 'image/png' });
    await f.connection.query('select fluid_private.observe_logo_asset($1,$2,$3,$4)', [reservation.id, { status: 'verified', checkedAt: new Date().toISOString(), contentHash: publication.contentHash, mimeType: 'image/png', byteLength: bytes.length }, job.id, job.leaseToken]);
    const providerRequestId = `synthetic-${job.id}`;
    const provider = (await f.connection.query<{v: {id: string}}>('select public.record_logo_provider_response($1,$2,$3) v', [job.id, job.leaseToken, {
      provider: conceptCapability.provider, model: conceptCapability.model, providerRequestId, responseHash: 'c'.repeat(64), observedAt: new Date().toISOString(), billing: { status: 'recorded', confirmedMicrousd: 1 }, artifactHash: publication.contentHash, normalizedPixelHash: 'd'.repeat(64),
    }])).rows[0]!.v;
    const output = input.operation === 'identity.logo_concept'
      ? { version: 2, kind: 'logo_concept', batchId: input.batchId, slotId: input.slotId, attemptId: input.attemptId, publicationId: reservation.id, providerResponseReceiptId: provider.id }
      : { version: 2, kind: 'logo_refinement_raster', rasterRevisionId: input.rasterRevisionId, publicationId: reservation.id, providerResponseReceiptId: provider.id };
    await f.connection.query("select public.complete_logo_job_step($1,$2,$3,'succeeded',1,$4,$5)", [job.id, job.leaseToken, stepKey, output, providerRequestId]);
    await f.connection.query("select public.finish_logo_job($1,$2,'succeeded')", [job.id, job.leaseToken]);
    return { reservation: await getReservation(reservation.id), bytes };
  }
  async function prepareRefinement(options: { priorRefinement?: boolean; referenceCount?: number } = {}) {
    const concept = await prepareConcept(options.referenceCount ?? 1), input = concept.job.input as LogoConceptJobInput;
    let base = await completeSynthetic(concept.job);
    let source: Record<string, unknown> = { kind: 'concept', batchId: input.batchId, slotId: input.slotId, attemptId: input.attemptId };
    let w = await workspace(concept.job.projectId);
    let job = await admit(w, { operation: 'refine_preview', source, instruction: 'Refine the synthetic silhouette.' });
    if (options.priorRefinement) {
      base = await completeSynthetic(job);
      source = { kind: 'refinement', rasterRevisionId: (job.input as LogoRefinementJobInput).rasterRevisionId };
      w = await workspace(job.projectId);
      job = await admit(w, { operation: 'refine_preview', source, instruction: 'Refine the earlier synthetic refinement.' });
    }
    return { ...concept, job, base: base.reservation, baseBytes: base.bytes, workspace: w };
  }
  return { ...f, enable, authorize, workspace, getReservation, uploadReference, prepareConcept, prepareRefinement, reserve, completeSynthetic };
}
