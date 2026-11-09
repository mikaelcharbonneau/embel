import { seedDeliverableDirections } from "./logo-deliverable-direction-fixture";
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { asRole, OWNER_A, type TestDatabase } from './local-supabase';
import { SYNTHETIC_CONCEPT_READINESS } from './logo-readiness-fixture';
import { legacyLogoCostQuoteSchema as logoCostQuoteSchema, logoDispatchReceiptSchema } from '../../src/domain/logo-jobs';
import { logoWorkspaceV2Schema } from '../../src/domain/logo-workspace';
import { approvedDeliverableSnapshotSchema, type ApprovedLogoIdentitySnapshot, type IdentityAssetReceipt, type LogoVariantSet } from '../../src/domain/logo-deliverables';
import { createIdentityAssetStore, createPostgresIdentityAssetBackend, type IdentityAssetReservation } from '../../src/server/data/identity-asset-store';
import type { ClaimedJob } from '../../src/domain/jobs';
import type { LogoWorkerConnection } from '../../src/server/data/logo-jobs';
import { parseClaimedJob } from '../../worker/postgres-store';
import { LOGO_EXPORT_POLICY_IDENTITY } from '../../worker/handlers/logo-exports';
import { QUALIFIED_VTRACER } from '../../worker/logo-vector/engine';
import { vectorMemberRequestKey } from '../../src/features/logo-vector/server/publication';
import { logoExportFileRequestKey } from '../../src/features/identity-deliverables/server/publish';
import { syntheticConversionInput } from '../features/logo-vector/raster-fixtures';
import { deliverableFixture, resolvedFixture, id, at } from '../features/identity-deliverables/fixtures';
import { computeLogoVariantRenderHash } from '../../src/features/identity-deliverables/server/render-policy';
import { ownerQuery, startLogoFixture } from "./logo-project-fixture";

export const workerRole = 'fluid_logo_worker_production_fixture', workerId = 'synthetic-production-storage';
export const authUser = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const policyIdentity = 'b'.repeat(64), engine = { id: 'vtracer', version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm };
export const vectorCapability = { operation: 'identity.logo_vectorize', policyIdentity, handlerVersion: '1', provider: null, model: null, engine, maxCostMicrousd: 0 };
export const exportCapability = { operation: 'identity.logo_export', policyIdentity: LOGO_EXPORT_POLICY_IDENTITY, handlerVersion: 'logo-export-v1', provider: null, model: null, engine: null, maxCostMicrousd: 0 };
/** Disposable DB only. Real admission/lease/RLS, explicitly synthetic sources. */
export async function installProductionStorageFixture(db: TestDatabase) {
  await db.exec(`create role ${workerRole} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role fixture_production_acl_probe nologin;
    alter default privileges grant all on tables to fixture_production_acl_probe;
    alter default privileges grant all on functions to fixture_production_acl_probe;
    alter table auth.users add column is_anonymous boolean not null default false;
    create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,not_after timestamptz);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    grant execute on function auth.jwt() to authenticated;
    grant usage on schema public,fluid_private to ${workerRole};
    grant execute on function public.report_logo_worker_ready(text,jsonb,integer),public.claim_logo_job(text,integer),public.begin_logo_job_step(uuid,uuid,text,text,bigint),
      public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text),public.finish_logo_job(uuid,uuid,text),
      public.record_logo_provider_response(uuid,uuid,jsonb),public.read_leased_logo_record(uuid,uuid,text,jsonb),
      fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid),fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid),
      public.load_logo_export_inputs(uuid,uuid),public.stage_logo_exports(uuid,uuid,jsonb),fluid_private.stage_logo_vector_publication(uuid,uuid,jsonb),fluid_private.read_logo_asset_publication(uuid,jsonb,uuid,uuid),fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb) to ${workerRole};
    create policy fixture_ordinary_read on storage.objects for select to authenticated using(owner_id=auth.uid()::text);`);
  await db.exec(await readFile(new URL('../../supabase/candidates/logo_worker_storage.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../../supabase/candidates/logo_production_storage.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../../supabase/activation/logo_production_storage.sql', import.meta.url), 'utf8'));
}
export async function productionStorageFixture(db: TestDatabase) {
  await db.query('insert into auth.users(id) values($1)', [authUser]); await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [sessionId, authUser]);
  for (const table of ['logo_worker_principals', 'logo_asset_web_principals']) await db.query(`insert into fluid_private.${table}(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname=$2 on conflict(role_name) do nothing`, [OWNER_A, workerRole]);
  await db.query(`insert into fluid_private.logo_storage_principals(auth_user_id,owner_id,role_name,role_oid,worker_id,enabled) select $1,$2,rolname,oid,$3,true from pg_roles where rolname=$4`, [authUser, OWNER_A, workerId, workerRole]);
  await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled) values($1,'identity.logo_concept',$2,'logo-image-v1','openai','gpt-image-2.5-sunburst-2026-09-08',100,true)", [OWNER_A, 'a'.repeat(64)]);
  await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,engine,max_cost_microusd,enabled) values($1,'identity.logo_vectorize',$2,'1',$3,0,true),($1,'identity.logo_export',$4,'logo-export-v1',null,0,true)", [OWNER_A, policyIdentity, engine, LOGO_EXPORT_POLICY_IDENTITY]);
  const writer = async <T>(run: () => Promise<T>): Promise<T> => { await db.exec(`set session authorization ${workerRole}`); try { return await run(); } finally { await db.exec('set session authorization postgres'); } };
  const connection: LogoWorkerConnection = { query: <Row>(sql: string, parameters?: unknown[]) => writer(() => db.query<Row>(sql, parameters)) };
  const ready = await connection.query<{ready: boolean}>('select public.report_logo_worker_ready($1,$2,90) ready', [workerId, [SYNTHETIC_CONCEPT_READINESS, vectorCapability, exportCapability]]);
  if (ready.rows[0]?.ready !== true) throw Error('Fixture readiness report rejected');
  const rpc = (name: string, args: unknown[], owner = OWNER_A) => asRole(db, 'authenticated', owner, async () => (await db.query<{ value: unknown }>(`select public.${name}(${args.map((_, i) => `$${i+1}`).join(',')}) value`, args)).rows[0]!.value);
  const workspace = async (projectId: string) => logoWorkspaceV2Schema.parse(await rpc('get_logo_workspace', [projectId]));
  const blobs = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  const assets = createIdentityAssetStore({ backend: createPostgresIdentityAssetBackend({ owned: null, worker: connection }), storage: {
    async putIfAbsent(path, bytes, mimeType) { if (!blobs.has(path)) blobs.set(path, { bytes: new Uint8Array(bytes), mimeType }); }, async read(path) { return blobs.get(path)!; },
  } });
  async function enable(capability: typeof vectorCapability | typeof exportCapability) {
    await db.query('insert into fluid_private.logo_production_storage_capabilities(auth_user_id,operation,policy_identity,enabled) values($1,$2,$3,true) on conflict(auth_user_id,operation) do update set enabled=true,policy_identity=excluded.policy_identity', [authUser, capability.operation, capability.policyIdentity]);
  }
  async function auth<T>(run: () => Promise<T>, claims: Record<string, unknown> = {}, user = authUser) {
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, session_id: sessionId, role: 'authenticated', aud: 'authenticated', iss: 'https://fricsfwqibyhemknqgyf.supabase.co/auth/v1', exp: Math.floor(Date.now()/1000)+3600, is_anonymous: false, ...claims })]);
    try { return await asRole(db, 'authenticated', user, run); } finally { await db.query("select set_config('request.jwt.claims','',false)"); }
  }
  const authorize = (job: ClaimedJob, r: IdentityAssetReservation | null, mode: string, claims = {}, user = authUser) => auth(async () => (await db.query<{ v: unknown }>('select public.authorize_logo_production_storage($1,$2,$3,$4) v', [job.id, job.leaseToken, r?.id ?? null, mode])).rows[0]!.v, claims, user);
  async function object<T>(operation: string, run: () => Promise<T>, claims = {}, user = authUser) { await db.query("select set_config('storage.operation',$1,false)", [operation]); return auth(run, claims, user); }
  const insert = (r: IdentityAssetReservation) => object('object.upload', () => db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [r.storagePath, authUser]));
  const read = (r: IdentityAssetReservation, operation = 'object.get_authenticated', claims = {}, user = authUser) => object(operation, async () => (await db.query('select name from storage.objects where name=$1', [r.storagePath])).rows, claims, user);
  const reserve = async (job: ClaimedJob, mimeType: string, name?: string, key?: string) => {
    const input = job.input as { sourceSnapshotHash: string }, contentHash = 'd'.repeat(64);
    const requestKey = key ?? (job.operation === 'identity.logo_vectorize' ? vectorMemberRequestKey(job.id, mimeType === 'application/json' ? 'document' : 'svg') : logoExportFileRequestKey(job.id, input.sourceSnapshotHash, { name: name!, contentHash }));
    const inputRevisions = (await connection.query<{ value: unknown }>("select public.read_leased_logo_record($1,$2,'input_revisions',null) value", [job.id, job.leaseToken])).rows[0]!.value;
    const publication = { requestKey, inputRevisions, mimeType, contentHash, byteLength: 3, source: { kind: job.operation === 'identity.logo_vectorize' ? 'vector' : 'export', sourceId: job.id } };
    return (await connection.query<{ value: IdentityAssetReservation }>('select fluid_private.prepare_logo_asset($1,$2,$3,$4) value', [job.projectId, JSON.stringify({ kind: 'stage', publication }), job.id, job.leaseToken])).rows[0]!.value;
  };
  async function prepareVector() {
    const initial = logoWorkspaceV2Schema.parse(await startLogoFixture(ownerQuery(db), { requestKey: randomUUID(), brief: {
      name: "Synthetic vector adapter", activity: "Local test", audience: "Testers", personality: "Calm", logoTypes: ["mascot"],
    } }));
    const reference = (await db.query<{ reference_snapshot_id: string }>("select reference_snapshot_id from public.logo_stage_revisions where id=$1", [initial.stages.brief_references!.id])).rows[0]!;
    const quote = logoCostQuoteSchema.parse(await rpc("quote_logo_operation", [initial.projectId, { operation: "concepts", expected: initial.heads,
      briefRevisionId: initial.stages.brief_references!.id, referenceSnapshotId: reference.reference_snapshot_id }]));
    const admission = logoDispatchReceiptSchema.parse(await rpc("admit_logo_operation", [initial.projectId, { requestKey: randomUUID(), quoteId: quote.id, acceptedMaxCostMicrousd: quote.maxCostMicrousd, expected: initial.heads }]));
    const concept = parseClaimedJob((await connection.query("select * from public.claim_logo_job($1,300)", [workerId])).rows[0]);
    const conceptInput = concept.input as { attemptId: string; slotId: string; batchId: string };
    const stepKey = `logo-preview-v1:${conceptInput.slotId}:${conceptInput.attemptId}`;
    await connection.query("select public.begin_logo_job_step($1,$2,$3,$4,100)", [concept.id, concept.leaseToken, stepKey, `${concept.id}:${stepKey}`]);
    const raster = syntheticConversionInput("mascot"), originalBytes = Uint8Array.from(raster.source.bytes);
    const revisions = (await connection.query<{ value: [] }>("select public.read_leased_logo_record($1,$2,'input_revisions',null) value", [concept.id, concept.leaseToken])).rows[0]!.value;
    const original = await assets.publishLeasedAsset(concept, { requestKey: randomUUID(), inputRevisions: revisions,
      mimeType: "image/png", contentHash: raster.source.reference.contentHash, byteLength: originalBytes.length,
      source: { kind: "concept", sourceId: conceptInput.attemptId } }, originalBytes);
    // This synthetic receipt only seeds a local raster source; no generation is performed.
    const provider = (await connection.query<{ value: { id: string } }>("select public.record_logo_provider_response($1,$2,$3) value", [concept.id, concept.leaseToken, {
      provider: "openai", model: "gpt-image-2.5-sunburst-2026-09-08", providerRequestId: "synthetic-not-a-provider-call",
      responseHash: "c".repeat(64), observedAt: "2026-10-07T00:00:00Z", billing: { status: "recorded", confirmedMicrousd: 1 },
      artifactHash: original.reference.contentHash, normalizedPixelHash: "d".repeat(64),
    }])).rows[0]!.value;
    await connection.query("select public.complete_logo_job_step($1,$2,$3,'succeeded',1,$4,'synthetic-not-a-provider-call')", [concept.id, concept.leaseToken, stepKey, {
      version: 2, kind: "logo_concept", batchId: conceptInput.batchId, slotId: conceptInput.slotId, attemptId: conceptInput.attemptId, publicationId: original.id, providerResponseReceiptId: provider.id,
    }]);
    await connection.query("select public.finish_logo_job($1,$2,'succeeded')", [concept.id, concept.leaseToken]);
    for (const jobId of admission.jobIds.filter(id => id !== concept.id)) await rpc("request_job_cancel", [jobId]);
    const source = { kind: "concept", batchId: conceptInput.batchId, slotId: conceptInput.slotId, attemptId: conceptInput.attemptId };
    await rpc("apply_logo_workspace_command", [initial.projectId, { method: "selectLogoRaster", body: { requestKey: randomUUID(), expected: initial.heads, source } }]);
    const selected = await workspace(initial.projectId);
    const vectorQuote = logoCostQuoteSchema.parse(await rpc("quote_logo_operation", [initial.projectId, { operation: "vectorize", expected: selected.heads, source, settings: raster.settings }]));
    const vector = logoDispatchReceiptSchema.parse(await rpc("admit_logo_operation", [initial.projectId, { requestKey: randomUUID(), quoteId: vectorQuote.id, acceptedMaxCostMicrousd: 0, expected: selected.heads }]));
    const job = parseClaimedJob((await connection.query("select * from public.claim_logo_job($1,300)", [workerId])).rows[0]);
    if (job.id !== vector.jobIds[0]) throw Error('Unexpected fixture job');
    const originalRow = (await connection.query<{value: IdentityAssetReservation}>("select fluid_private.read_logo_asset_publication($1,$2,$3,$4) value", [job.projectId, JSON.stringify(original.reference), job.id, job.leaseToken])).rows[0]!.value;
    await db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [originalRow.storagePath, OWNER_A]);
    return { job, original: originalRow, bytes: originalBytes };
  }
  const brief = { name: "Synthetic export storage", activity: "Studio", audience: "Teams", personality: "Precise", logoTypes: ["wordmark"] };
 async function setupExport() {
  const start=logoWorkspaceV2Schema.parse(await startLogoFixture(ownerQuery(db), {requestKey:randomUUID(),brief}));
  const fixture=JSON.parse(JSON.stringify(deliverableFixture("wordmark")).replaceAll(id(1),OWNER_A).replaceAll(id(2),start.projectId)) as ApprovedLogoIdentitySnapshot;
  const sourceInputs=[{stage:"brief_references",id:start.stages.brief_references!.id,revision:1}];
  await db.query("insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4)",[fixture.logo.id,OWNER_A,start.projectId,{...fixture.logo,inputRevisions:sourceInputs}]);
  const vector=(await db.query<{value:{id:string;revision:number}}>("select fluid_private.logo_append_stage($1,$2,'vector',$3,$4) value",[OWNER_A,start.projectId,{vectorRevisionId:fixture.logo.id,approvalId:fixture.logoApproval.id},sourceInputs])).rows[0]!.value;
  fixture.logoApproval.stageRevisionId=vector.id;
  await db.query("insert into public.logo_approvals(id,owner_id,project_id,vector_revision_id,stage_revision_id,record) values($1,$2,$3,$4,$5,$6)",[fixture.logoApproval.id,OWNER_A,start.projectId,fixture.logo.id,vector.id,fixture.logoApproval]);
  const inputs=[...sourceInputs,{stage:"vector",id:vector.id,revision:vector.revision}];
  const directionIds = await seedDeliverableDirections(db, fixture, inputs);
  for (const [kind,record] of [["palette",fixture.palette],["typography",fixture.typography],["graphics",fixture.graphics],["selection",fixture.directionSelection],["approval",fixture.directionApproval]] as const) await db.query("insert into public.logo_direction_records(id,owner_id,project_id,kind,approved_logo_id,record) values($1,$2,$3,$4,$5,$6)",[record.id,OWNER_A,start.projectId,kind,fixture.logoApproval.id,record]);
  for (const font of fixture.fonts) await db.query("insert into public.logo_font_records(record_id,version_id,owner_id,project_id,record) values($1,$2,$3,$4,$5)",[font.id,font.asset.versionId,OWNER_A,start.projectId,font]);
  await db.query("select fluid_private.logo_append_stage($1,$2,'directions',$3,$4)",[OWNER_A,start.projectId,{directionIds,selectionId:fixture.directionSelection.id,approvalId:fixture.directionApproval.id},inputs]);
  const workspace=logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace",[start.projectId]));
  return {fixture,workspace,projectId:start.projectId};
 }
 async function stageAsset(projectId:string, sourceId:string, inputRevisions:unknown, mimeType:string, contentHash:string, byteLength=100, jobId:string|null=null, lease:string|null=null):Promise<IdentityAssetReceipt> {
  const publication={requestKey:randomUUID(),inputRevisions,mimeType,contentHash,byteLength,source:{kind:jobId?"export":"variant",sourceId}};
  return writer(async () => {
   const row=(await db.query<{value:{id:string}}>("select fluid_private.prepare_logo_asset($1,$2,$3,$4) value",[projectId,{kind:"stage",publication},jobId,lease])).rows[0]!.value;
   return (await db.query<{value:IdentityAssetReceipt}>("select fluid_private.observe_logo_asset($1,$2,$3,$4) value",[row.id,{status:"verified",checkedAt:at,contentHash,mimeType,byteLength},jobId,lease])).rows[0]!.value;
  });
 }
 async function prepareVariants(f:Awaited<ReturnType<typeof setupExport>>) {
  const source=await rpc("read_logo_deliverable_sources",[f.projectId]) as {inputRevisions:unknown};
  const local=resolvedFixture(f.fixture.logoDocument,computeLogoVariantRenderHash);
  const items=JSON.parse(JSON.stringify(local.resolved.set.items).replaceAll(id(1),OWNER_A).replaceAll(id(2),f.projectId)) as LogoVariantSet["items"];
  for (const item of items) {
   const document=await stageAsset(f.projectId,f.fixture.logoApproval.id,source.inputRevisions,"application/json",item.documentAsset!.contentHash);
   const preview=await stageAsset(f.projectId,f.fixture.logoApproval.id,source.inputRevisions,"image/png",item.preview!.reference.contentHash);
   item.documentAsset=document.reference;item.preview=preview;
  }
  for (const role of ["horizontal","stacked","symbol_only"] as const) for(const colorway of ["black","white","color"] as const) items.push({id:randomUUID(),role,colorway,documentAsset:null,renderHash:null,preview:null,clearSpace:0,minimumDigitalSize:null,applicability:{status:"not_applicable",reason:role==="symbol_only"?"no_symbol":"inseparable_artwork"},reviewStatus:"review_required"});
  const variantSet={...local.resolved.set,ownerId:OWNER_A,projectId:f.projectId,items};
  const command={method:"prepareLogoVariants",body:{requestKey:randomUUID(),expected:f.workspace.heads,approvedLogoId:f.fixture.logoApproval.id,directionApprovalId:f.fixture.directionApproval.id}};
  const run=()=>writer(async () => (await db.query<{value:LogoVariantSet}>("select fluid_private.apply_logo_trusted_command($1,$2,$3) value",[f.projectId,command,{source,variantSet}])).rows[0]!.value);
  return {source,variantSet,command,run};
 }
 async function reviewedExport() {
  const f=await setupExport(),prepared=await prepareVariants(f),set=await prepared.run(),before=logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace",[f.projectId]));
  const accepted=set.items.filter(i=>i.applicability.status==="applicable");
  await writer(()=>db.query("select fluid_private.apply_logo_trusted_command($1,$2,$3)",[f.projectId,{method:"reviewLogoVariants",body:{requestKey:randomUUID(),expected:before.heads,approvedLogoId:set.approvedLogoId,directionApprovalId:set.directionApprovalId,variantSetId:set.id,acceptedVariantIds:accepted.map(i=>i.id)}},{variantSet:set,acceptedVariants:accepted.map(i=>({variantId:i.id,renderHash:i.renderHash}))}]));
  const workspace=logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace",[f.projectId]));
  return {...f,set,workspace,intent:{requestKey:randomUUID(),expected:workspace.heads,approvedLogoId:set.approvedLogoId,directionApprovalId:set.directionApprovalId,variantSetId:set.id,pngLongEdge:512,socialSelections:[]}};
 }
  async function prepareExport() {
    const f = await reviewedExport(), receipt = await rpc('request_logo_export', [f.projectId, f.intent]) as {jobIds: string[]};
    const job = parseClaimedJob((await connection.query("select * from public.claim_logo_job($1,300)", [workerId])).rows[0]);
    if (job.id !== receipt.jobIds[0]) throw Error('Unexpected fixture export');
    const source = (await db.query<{source: Record<string, unknown>}>('select source from public.logo_export_inputs where job_id=$1', [job.id])).rows[0]!.source;
    const sources = (await db.query<{value: IdentityAssetReservation}>("select fluid_private.logo_asset_reservation(a) value from public.logo_asset_publications a where a.project_id=$1 and a.state='committed'", [job.projectId])).rows.map(r => r.value);
    for (const r of sources) await db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [r.storagePath, OWNER_A]);
    const expected = (await db.query<{v: {name: string; mimeType: string}[]}>('select fluid_private.logo_export_expected_files($1) v', [source])).rows[0]!.v;
    const geometry = resolvedFixture(f.fixture.logoDocument, computeLogoVariantRenderHash);
    const snapshot = approvedDeliverableSnapshotSchema.parse({ ...source, logoDocument: f.fixture.logoDocument,
      resolvedVariants: { set: f.set, items: f.set.items.map(variant => ({ variant,
        document: variant.applicability.status === 'applicable' ? geometry.resolved.items.find(item => item.variant.id === variant.id)!.document : null })) } });
    return { job, sources, source, expected, snapshot };
  }
  return { connection, writer, rpc, authorize, object, insert, read, reserve, enable, auth, prepareVector, prepareExport, blobs };
}
