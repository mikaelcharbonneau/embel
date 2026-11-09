import { seedDeliverableDirections } from "./logo-deliverable-direction-fixture";
import { reportLogoFixtureReady } from './logo-readiness-fixture';
import { LOGO_EXPORT_POLICY_IDENTITY } from "../../worker/handlers/logo-exports";
import { randomUUID, createHash } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { logoRequestStateSchema } from "@/domain/logo-jobs";
import { logoWorkspaceV2Schema, type LogoWorkspaceV2 } from "@/domain/logo-workspace";
import { logoDeliverablesOverviewSchema, logoExportManifestSchema, type IdentityAssetReceipt, type ApprovedLogoIdentitySnapshot, type LogoVariantSet } from "@/domain/logo-deliverables";
import { deliverableFixture, resolvedFixture, id, at } from "../features/identity-deliverables/fixtures";
import { computeLogoVariantRenderHash } from "@/features/identity-deliverables/server/render-policy";
import { ownerQuery, startLogoFixture } from "./logo-project-fixture";
const brief = { name: "Synthetic export brand", activity: "Studio", audience: "Teams", personality: "Precise", logoTypes: ["wordmark"] };
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
/** SQL fixture metadata is synthetic. Byte production and private-storage reads are separately tested. */
describe("local immutable logo export persistence", () => {
 let db: TestDatabase;
 beforeAll(async () => { db = await createTestDatabase(); await db.exec("create role fixture_export_writer login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; grant usage on schema public,fluid_private to fixture_export_writer;");
  for (const signature of ["fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb)","fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid)","fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid)","public.stage_logo_exports(uuid,uuid,jsonb)","public.load_logo_export_inputs(uuid,uuid)","public.claim_logo_job(text,integer)","public.begin_logo_job_step(uuid,uuid,text,text,bigint)","public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text)","public.finish_logo_job(uuid,uuid,text)","public.expire_logo_job_leases()"]) {
   if ((await db.query<{id:string|null}>("select to_regprocedure($1)::text id",[signature])).rows[0]!.id) await db.exec(`grant execute on function ${signature} to fixture_export_writer`);
  }
 }, 60_000);
 afterAll(async () => { await db?.close(); });
 beforeEach(async () => { await resetFixture(db); for (const table of ["logo_asset_web_principals","logo_worker_principals"]) await db.query(`insert into fluid_private.${table}(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_export_writer' on conflict(role_name) do nothing`,[OWNER_A]); });
 async function rpc(name:string,args:unknown[],owner=OWNER_A) { return asRole(db,"authenticated",owner,async () => (await db.query<{value:unknown}>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(",")}) value`,args)).rows[0]!.value); }
 async function writer<T>(run:()=>Promise<T>):Promise<T> { await db.exec("set session authorization fixture_export_writer"); try { return await run(); } finally { await db.exec("set session authorization postgres"); } }
 async function setup() {
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
 it("resolves exact owned approvals, current heads, brand spelling and font rights", async () => {
  const f=await setup();
  const value=await rpc("read_logo_deliverable_sources",[f.projectId]);
  expect(value).toMatchObject({ownerId:OWNER_A,projectId:f.projectId,brandName:brief.name,heads:f.workspace.heads,logoApproval:f.fixture.logoApproval,directionApproval:f.fixture.directionApproval,fonts:f.fixture.fonts});
  expect(value).not.toHaveProperty("logoDocument");
  await expect(rpc("read_logo_deliverable_sources",[f.projectId],OWNER_B)).rejects.toMatchObject({code:"P0002"});
 });

 async function stageAsset(projectId:string, sourceId:string, inputRevisions:unknown, mimeType:string, contentHash:string, byteLength=100, jobId:string|null=null, lease:string|null=null):Promise<IdentityAssetReceipt> {
  const publication={requestKey:randomUUID(),inputRevisions,mimeType,contentHash,byteLength,source:{kind:jobId?"export":"variant",sourceId}};
  return writer(async () => {
   const row=(await db.query<{value:{id:string}}>("select fluid_private.prepare_logo_asset($1,$2,$3,$4) value",[projectId,{kind:"stage",publication},jobId,lease])).rows[0]!.value;
   return (await db.query<{value:IdentityAssetReceipt}>("select fluid_private.observe_logo_asset($1,$2,$3,$4) value",[row.id,{status:"verified",checkedAt:at,contentHash,mimeType,byteLength},jobId,lease])).rows[0]!.value;
  });
 }
 async function prepareVariants(f:Awaited<ReturnType<typeof setup>>) {
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
 it("commits actual staged variants and exact visual review without changing approval", async () => {
  const f=await setup(),prepared=await prepareVariants(f),set=await prepared.run();
  expect(set.items.filter(i=>i.preview).every(i=>i.preview!.publicationState==="committed")).toBe(true);
  expect(await prepared.run()).toEqual(set);
  const workspace=logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace",[f.projectId]));
  expect(workspace.approvedLogo).toEqual(f.fixture.logoApproval);
  const body={requestKey:randomUUID(),expected:workspace.heads,approvedLogoId:set.approvedLogoId,directionApprovalId:set.directionApprovalId,variantSetId:set.id,acceptedVariantIds:set.items.filter(i=>i.applicability.status==="applicable").map(i=>i.id)};
  const evidence={variantSet:set,acceptedVariants:set.items.filter(i=>i.applicability.status==="applicable").map(i=>({variantId:i.id,renderHash:i.renderHash}))};
  await writer(()=>db.query("select fluid_private.apply_logo_trusted_command($1,$2,$3)",[f.projectId,{method:"reviewLogoVariants",body},evidence]));
  const reviews=(await db.query<{record:unknown}>("select record from public.logo_variant_reviews where variant_set_id=$1",[set.id])).rows;
  expect(reviews).toHaveLength(1);expect(reviews[0]!.record).toMatchObject({variantSetId:set.id,acceptedVariants:evidence.acceptedVariants});
  await expect(rpc("read_logo_variant_set",[f.projectId,set.id],OWNER_B)).rejects.toMatchObject({code:"P0002"});
 });
 it("rejects changed source, missing bytes and incomplete reviews atomically", async () => {
  const f=await setup(),prepared=await prepareVariants(f);
  const changed=structuredClone(prepared.variantSet);changed.items[0]!.documentAsset!.contentHash="f".repeat(64);
  await expect(writer(()=>db.query("select fluid_private.apply_logo_trusted_command($1,$2,$3)",[f.projectId,prepared.command,{source:prepared.source,variantSet:changed}]))).rejects.toMatchObject({code:"55000"});
  expect((await db.query("select * from public.logo_variant_sets")).rows).toHaveLength(0);
  expect((await db.query("select * from public.asset_versions")).rows).toHaveLength(0);
  const set=await prepared.run(),workspace=logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace",[f.projectId]));
  const body={requestKey:randomUUID(),expected:workspace.heads,approvedLogoId:set.approvedLogoId,directionApprovalId:set.directionApprovalId,variantSetId:set.id,acceptedVariantIds:[set.items[0]!.id]};
  await expect(writer(()=>db.query("select fluid_private.apply_logo_trusted_command($1,$2,$3)",[f.projectId,{method:"reviewLogoVariants",body},{variantSet:set,acceptedVariants:[{variantId:set.items[0]!.id,renderHash:set.items[0]!.renderHash}]}]))).rejects.toMatchObject({code:"22023"});
  expect((await db.query("select * from public.logo_variant_reviews")).rows).toHaveLength(0);
 });
 async function reviewedExport() {
  const f=await setup(),prepared=await prepareVariants(f),set=await prepared.run(),before=logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace",[f.projectId]));
  const accepted=set.items.filter(i=>i.applicability.status==="applicable");
  await writer(()=>db.query("select fluid_private.apply_logo_trusted_command($1,$2,$3)",[f.projectId,{method:"reviewLogoVariants",body:{requestKey:randomUUID(),expected:before.heads,approvedLogoId:set.approvedLogoId,directionApprovalId:set.directionApprovalId,variantSetId:set.id,acceptedVariantIds:accepted.map(i=>i.id)}},{variantSet:set,acceptedVariants:accepted.map(i=>({variantId:i.id,renderHash:i.renderHash}))}]));
  const workspace=logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace",[f.projectId]));
  await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,max_cost_microusd,enabled) values($1,'identity.logo_export',$2,'logo-export-v1',0,true) on conflict(owner_id,operation) do update set enabled=true",[OWNER_A,LOGO_EXPORT_POLICY_IDENTITY]);
  await reportLogoFixtureReady(db,'fixture_export_writer',['synthetic-export-worker'],[{operation:'identity.logo_export',policyIdentity:LOGO_EXPORT_POLICY_IDENTITY,handlerVersion:'logo-export-v1',provider:null,model:null,engine:null,maxCostMicrousd:0}]);
  return {...f,set,workspace,intent:{requestKey:randomUUID(),expected:workspace.heads,approvedLogoId:set.approvedLogoId,directionApprovalId:set.directionApprovalId,variantSetId:set.id,pngLongEdge:512,socialSelections:[]}};
 }
 it("fences a cancelled vector-edit key before export admission can retain any job or reservation", async () => {
  const f=await reviewedExport();
  const command={method:"saveLogoEdit",body:{requestKey:f.intent.requestKey,expected:f.workspace.heads,baseVectorRevisionId:f.fixture.logo.id,edit:{kind:"text",componentId:"lettering",text:"Retained edit"}}};
  const proof=await rpc("cancel_logo_vector_edit",[f.projectId,command]);
  await expect(rpc("request_logo_export",[f.projectId,f.intent])).rejects.toMatchObject({code:"PT409",message:"logo_request_conflict"});
  for(const table of ["jobs","usage_reservations","logo_operation_requests","logo_operation_rejections","logo_export_inputs"])expect((await db.query(`select count(*)::int n from public.${table}`)).rows,table).toEqual([{n:0}]);
  expect((await db.query("select reserved_microusd from public.usage_accounts where owner_id=$1",[OWNER_A])).rows).toEqual([{reserved_microusd:0}]);
  expect(await rpc("get_logo_workspace",[f.projectId])).toEqual(f.workspace);
  expect(await rpc("cancel_logo_vector_edit",[f.projectId,command])).toEqual(proof);
  expect(await rpc("read_logo_vector_edit_request",[f.projectId,f.intent.requestKey])).toEqual(proof);
  const unchanged={...f.intent,requestKey:randomUUID()},receipt=await rpc("request_logo_export",[f.projectId,unchanged]) as {jobIds:string[]};
  expect(receipt.jobIds).toHaveLength(1);expect(await rpc("request_logo_export",[f.projectId,unchanged])).toEqual(receipt);
  const jobs=(await db.query("select * from public.jobs order by id")).rows;
  await expect(rpc("cancel_logo_vector_edit",[f.projectId,{...command,body:{...command.body,requestKey:unchanged.requestKey}}])).rejects.toMatchObject({code:"PT409"});
  expect((await db.query("select * from public.jobs order by id")).rows).toEqual(jobs);
 });
 it("fences export rejection for a cancelled key and preserves unrelated rejection replay",async()=>{
  const f=await reviewedExport(),command={method:"saveLogoEdit",body:{requestKey:f.intent.requestKey,expected:f.workspace.heads,baseVectorRevisionId:f.fixture.logo.id,edit:{kind:"text",componentId:"lettering",text:"Retained edit"}}};
  const proof=await rpc("cancel_logo_vector_edit",[f.projectId,command]);
  const stale={...f.intent,expected:{...f.intent.expected,workspaceRevision:f.intent.expected.workspaceRevision+1}};
  await expect(rpc("request_logo_export",[f.projectId,stale])).rejects.toMatchObject({code:"PT409",message:"logo_request_conflict"});
  for(const table of ["jobs","usage_reservations","logo_operation_requests","logo_operation_rejections","logo_export_inputs"])expect((await db.query(`select count(*)::int n from public.${table}`)).rows,table).toEqual([{n:0}]);
  expect(await rpc("cancel_logo_vector_edit",[f.projectId,command])).toEqual(proof);
  const unchanged={...stale,requestKey:randomUUID()},result=await rpc("request_logo_export",[f.projectId,unchanged]);
  expect(result).toMatchObject({kind:"logo_export_admission_rejected"});expect(await rpc("request_logo_export",[f.projectId,unchanged])).toEqual(result);
 });
 it("records a stale exact-body rejection before any job and fences every delayed replay",async()=>{
  const f=await reviewedExport();
  await db.query("select fluid_private.logo_append_stage($1,$2,'deliverables',$3,'[]')",[OWNER_A,f.projectId,{variantSetId:f.set.id,exportManifestIds:[]}]);
  const result=await rpc("request_logo_export",[f.projectId,f.intent]);
  expect(result).toEqual({kind:"logo_export_admission_rejected",errorCode:"conflict",rejection:{status:"rejected",operation:"identity.logo_export",ownerId:OWNER_A,projectId:f.projectId,requestKey:f.intent.requestKey,input:f.intent}});
  expect((await db.query("select * from public.jobs where operation='identity.logo_export'")).rows).toHaveLength(0);
  expect(await rpc("request_logo_export",[f.projectId,f.intent])).toEqual(result);
  await expect(rpc("request_logo_export",[f.projectId,{...f.intent,pngLongEdge:1024}])).rejects.toMatchObject({code:"PT409"});
  const read=logoRequestStateSchema.parse(await rpc("read_logo_request",[f.projectId,f.intent.requestKey]));
  expect(read).toMatchObject({status:"failed",receipt:null,outputs:[],reason:"admission_rejected",billing:{status:"recorded",confirmedMicrousd:0},rejection:{input:f.intent}});
  await expect(rpc("read_logo_request",[f.projectId,f.intent.requestKey],OWNER_B)).rejects.toMatchObject({code:"P0002"});
  expect((await db.query("select * from public.jobs where operation='identity.logo_export'")).rows).toHaveLength(0);
 });
 it("freezes exact export options once and returns the same admission after head changes", async () => {
  const f=await reviewedExport();
  const receipt=await rpc("request_logo_export",[f.projectId,f.intent]) as {jobIds:string[]};
  expect(receipt.jobIds).toHaveLength(1);expect(await rpc("request_logo_export",[f.projectId,f.intent])).toEqual(receipt);
  const stored=(await db.query<{source:Record<string,unknown>}>("select source from public.logo_export_inputs where job_id=$1",[receipt.jobIds[0]])).rows[0]!.source;
  expect(stored).toMatchObject({brandName:brief.name,pngLongEdge:512,socialSelections:[],variants:f.set,heads:f.workspace.heads});
  expect(stored).not.toHaveProperty("logoDocument");expect(stored).not.toHaveProperty("resolvedVariants");
  await db.query("select fluid_private.logo_append_stage($1,$2,'deliverables',$3,$4)",[OWNER_A,f.projectId,{variantSetId:f.set.id,exportManifestIds:[]},stored.inputRevisions]);
  expect(await rpc("request_logo_export",[f.projectId,f.intent])).toEqual(receipt);
  await expect(rpc("request_logo_export",[f.projectId,{...f.intent,pngLongEdge:1024}])).rejects.toMatchObject({code:"PT409"});
  const overview=logoDeliverablesOverviewSchema.parse(await rpc("get_logo_deliverables",[f.projectId,{}]));
  expect(overview.exports).toHaveLength(0);expect(overview.exportRequests).toHaveLength(1);expect(overview.exportRequests[0]!.input).toEqual(f.intent);expect(overview.exportRequests[0]!.state.status).toBe("admitted");
  await expect(rpc("get_logo_deliverables",[f.projectId,{}],OWNER_B)).rejects.toMatchObject({code:"P0002"});
 });
 it("refuses unreviewed, stale and unsupported options without creating jobs", async () => {
  const f=await reviewedExport();
  for (const change of [{pngLongEdge:999},{socialSelections:[{kind:"avatar",presetId:"not-a-preset"}]}]) await expect(rpc("request_logo_export",[f.projectId,{...f.intent,requestKey:randomUUID(),...change}])).rejects.toMatchObject({code:"22023"});
  for (const change of [{approvedLogoId:randomUUID()},{variantSetId:randomUUID()}]) {const input={...f.intent,requestKey:randomUUID(),...change};expect(await rpc("request_logo_export",[f.projectId,input])).toMatchObject({kind:"logo_export_admission_rejected",rejection:{input}});}
  expect((await db.query("select * from public.jobs where operation='identity.logo_export'")).rows).toHaveLength(0);
 });
 async function stagedExport(partial=false) {
  const f=await reviewedExport(),receipt=await rpc("request_logo_export",[f.projectId,f.intent]) as {jobIds:string[]};
  const job=await writer(async () => (await db.query<{id:string;lease_token:string}>("select * from public.claim_logo_job('synthetic-export-worker',120)")).rows[0]!);
  expect(job.id).toBe(receipt.jobIds[0]);
  const source=await writer(async () => (await db.query<{value:{sourceSnapshotHash:string;inputRevisions:unknown}}>("select public.load_logo_export_inputs($1,$2) value",[job.id,job.lease_token])).rows[0]!.value);
  await writer(()=>db.query("select public.begin_logo_job_step($1,$2,'prepare-export',$3,0)",[job.id,job.lease_token,`export-${job.id}`]));
  const expected=(await db.query<{value:{name:string;role:string;mimeType:string;sourceVariantId:string|null}[]}>("select fluid_private.logo_export_expected_files($1) value",[source])).rows[0]!.value;
  const files=(partial?expected.slice(0,3):expected).map((file,index)=>({...file,contentHash:hash(`synthetic verified file ${index}`),byteLength:100}));
  const receipts:IdentityAssetReceipt[]=[];
  for(const file of files)receipts.push(await stageAsset(f.projectId,job.id,source.inputRevisions,file.mimeType,file.contentHash,file.byteLength,job.id,job.lease_token));
  const group={sourceSnapshotHash:source.sourceSnapshotHash,completeness:partial?"partial":"complete",failure:partial?"file_failed":null,files,assetReceiptIds:receipts.map(r=>r.id)};
  const stage=()=>writer(async () => (await db.query<{value:{id:string}}>("select public.stage_logo_exports($1,$2,$3) value",[job.id,job.lease_token,group])).rows[0]!.value);
  return {...f,job,source,files,receipts,group,stage};
 }
 it.each([false,true])("atomically commits %s partial groups with exact immutable membership", async partial => {
  const f=await stagedExport(partial),publication=await f.stage();expect(await f.stage()).toEqual(publication);
  expect((await db.query("select * from public.logo_export_manifests")).rows).toHaveLength(0);
  const output={version:2,kind:partial?"logo_export_partial":"logo_export",publicationId:publication.id};
  await writer(()=>db.query("select public.complete_logo_job_step($1,$2,'prepare-export',$3,0,$4,null)",[f.job.id,f.job.lease_token,partial?"failed":"succeeded",partial?{error:"export_file_failed",result:output}:output]));
  await writer(()=>db.query("select public.finish_logo_job($1,$2,$3)",[f.job.id,f.job.lease_token,partial?"failed":"succeeded"]));
  const overview=logoDeliverablesOverviewSchema.parse(await rpc("get_logo_deliverables",[f.projectId,{}]));
  expect(overview.exports).toHaveLength(partial?0:1);expect(overview.exportRequests[0]!.state.status).toBe(partial?"partial":"succeeded");expect(overview.exportRequests[0]!.state.outputs).toHaveLength(f.files.length);
  expect(overview.exportRequests[0]!.state.outputs.every(r=>r.publicationState==="committed")).toBe(true);
  if(!partial){const manifest=logoExportManifestSchema.parse(await rpc("get_logo_export",[f.projectId,overview.exports[0]!.manifest.id]));expect(manifest.files.map(file=>file.asset.id)).toEqual(f.receipts.map(r=>r.id));expect(overview.exports[0]!.stale).toBe(false);}
  expect((await rpc("get_logo_workspace",[f.projectId]) as LogoWorkspaceV2).approvedLogo).toEqual(f.fixture.logoApproval);
  await expect(db.query("update public.logo_export_publications set files='[]' where id=$1",[publication.id])).rejects.toMatchObject({code:"55000"});
  expect(await rpc("request_logo_export",[f.projectId,f.intent])).toMatchObject({jobIds:[f.job.id]});
 });
 it("rejects swapped, foreign, incomplete and cancelled-lease groups before committing assets", async () => {
  const f=await stagedExport();
  for(const mutation of ["hash","role","receipt","missing"]){const bad=structuredClone(f.group);if(mutation==="hash")bad.files[0]!.contentHash="f".repeat(64);if(mutation==="role")bad.files[0]!.role="avatar";if(mutation==="receipt")bad.assetReceiptIds[0]=randomUUID();if(mutation==="missing"){bad.files.pop();bad.assetReceiptIds.pop();}await expect(writer(()=>db.query("select public.stage_logo_exports($1,$2,$3)",[f.job.id,f.job.lease_token,bad]))).rejects.toBeTruthy();}
  expect((await db.query("select * from public.logo_export_publications")).rows).toHaveLength(0);
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[f.job.id]);await expect(f.stage()).rejects.toMatchObject({code:"40001"});
 });
 it.each(["head","cancel"])("retains known complete files after a %s change without moving the new stage", async mode => {
  const f=await stagedExport(),publication=await f.stage();
  if(mode==="head")await db.query("select fluid_private.logo_append_stage($1,$2,'vector',$3,'[]')",[OWNER_A,f.projectId,{vectorRevisionId:randomUUID(),approvalId:null}]);else await db.query("update public.jobs set state='cancel_requested' where id=$1",[f.job.id]);
  const before=logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace",[f.projectId]));
  await writer(()=>db.query("select public.complete_logo_job_step($1,$2,'prepare-export','succeeded',0,$3,null)",[f.job.id,f.job.lease_token,{version:2,kind:"logo_export",publicationId:publication.id}]));
  expect((await rpc("get_logo_workspace",[f.projectId]) as LogoWorkspaceV2).heads).toEqual(before.heads);
  const overview=logoDeliverablesOverviewSchema.parse(await rpc("get_logo_deliverables",[f.projectId,{}]));expect(overview.exports).toHaveLength(1);if(mode==="head")expect(overview.exports[0]!.stale).toBe(true);
 });
 it.each(["full-failed","partial-succeeded","complete-partial-kind","wrong-reason","foreign-publication"])("rejects %s outcome with atomic rollback",async mode=>{
  const f=await stagedExport(mode==="partial-succeeded"||mode==="wrong-reason"),publication=await f.stage();
  const before=logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace",[f.projectId]));
  const partialKind=mode!=="full-failed"&&mode!=="foreign-publication";
  const output={version:2,kind:partialKind?"logo_export_partial":"logo_export",publicationId:mode==="foreign-publication"?randomUUID():publication.id};
  const succeeded=mode==="partial-succeeded"||mode==="foreign-publication";
  const payload=succeeded?output:{error:mode==="wrong-reason"?"export_package_too_large":"export_file_failed",result:output};
  await expect(writer(()=>db.query("select public.complete_logo_job_step($1,$2,'prepare-export',$3,0,$4,null)",[f.job.id,f.job.lease_token,succeeded?"succeeded":"failed",payload]))).rejects.toBeTruthy();
  expect((await db.query("select * from public.logo_export_manifests")).rows).toHaveLength(0);
  expect((await db.query("select * from public.logo_asset_publications where job_id=$1 and state='committed'",[f.job.id])).rows).toHaveLength(0);
  expect((await rpc("get_logo_workspace",[f.projectId]) as LogoWorkspaceV2).heads).toEqual(before.heads);
 });

 it("offline export admission recovers exact receipt/rejection before checking liveness",async()=>{
  const f=await reviewedExport(),first=await rpc("request_logo_export",[f.projectId,f.intent]);
  const rejectedInput={...f.intent,requestKey:randomUUID(),expected:{...f.intent.expected,workspaceRevision:999}};
  const rejected=await rpc("request_logo_export",[f.projectId,rejectedInput]);expect(rejected).toMatchObject({kind:"logo_export_admission_rejected"});
  await writer(()=>db.query("select public.report_logo_worker_ready('synthetic-export-worker','[]',60)"));
  expect(await rpc("request_logo_export",[f.projectId,f.intent])).toEqual(first);expect(await rpc("request_logo_export",[f.projectId,rejectedInput])).toEqual(rejected);
  await expect(rpc("request_logo_export",[f.projectId,{...f.intent,requestKey:randomUUID()}])).rejects.toMatchObject({code:"55000",message:"logo_runtime_unavailable"});
  expect((await db.query("select * from public.logo_operation_rejections")).rows).toHaveLength(1);expect((await db.query("select * from public.jobs")).rows).toHaveLength(1);
 });
 it("readiness withdrawal after export work starts retains staged files and final completion",async()=>{
  const f=await stagedExport(false);await writer(()=>db.query("select public.report_logo_worker_ready('synthetic-export-worker','[]',60)"));
  const publication=await f.stage();await writer(()=>db.query("select public.complete_logo_job_step($1,$2,'prepare-export','succeeded',0,$3,null)",[f.job.id,f.job.lease_token,{version:2,kind:"logo_export",publicationId:publication.id}]));
  await writer(()=>db.query("select public.finish_logo_job($1,$2,'succeeded')",[f.job.id,f.job.lease_token]));
  expect((await db.query("select state from public.jobs where id=$1",[f.job.id])).rows).toEqual([{state:"succeeded"}]);expect((await db.query("select * from public.logo_export_manifests")).rows).toHaveLength(1);
 });

 it("a changed export engine cannot admit, claim or start old work even after a fresh exact report",async()=>{
  const f=await reviewedExport(),first=await rpc("request_logo_export",[f.projectId,f.intent]);
  const held=await writer(async()=>(await db.query<{id:string;lease_token:string}>("select * from public.claim_logo_job('synthetic-export-worker',120)")).rows[0]!);
  const queuedIntent={...f.intent,requestKey:randomUUID()},queued=await rpc("request_logo_export",[f.projectId,queuedIntent]) as {jobIds:string[]};
  const before=(await db.query("select id,state,attempts,reserved_cost_microusd from public.jobs where id=any($1)",[queued.jobIds])).rows;
  const reservations=(await db.query("select job_id,reserved_microusd,state from public.usage_reservations order by job_id")).rows;
  const engine={id:"different-export-engine",version:"2",artifactHash:"f".repeat(64)};
  await db.query("update fluid_private.logo_runtime_policies set engine=$1 where owner_id=$2 and operation='identity.logo_export'",[engine,OWNER_A]);
  expect((await db.query("select * from fluid_private.logo_worker_readiness")).rows).toHaveLength(0);
  // The restricted reporter accurately describes the new policy. The frozen
  // export job must still reject its unsupported semantic change independently.
  await reportLogoFixtureReady(db,'fixture_export_writer',['synthetic-export-worker'],[{operation:'identity.logo_export',policyIdentity:LOGO_EXPORT_POLICY_IDENTITY,handlerVersion:'logo-export-v1',provider:null,model:null,engine,maxCostMicrousd:0}]);
  expect((await writer(()=>db.query("select * from public.claim_logo_job('synthetic-export-worker',120)"))).rows).toHaveLength(0);
  await expect(writer(()=>db.query("select public.begin_logo_job_step($1,$2,'prepare-export',$3,0)",[held.id,held.lease_token,`export-${held.id}`]))).rejects.toMatchObject({code:"55000",message:"logo_export_policy_revoked"});
  await expect(rpc("request_logo_export",[f.projectId,{...f.intent,requestKey:randomUUID()}])).rejects.toMatchObject({code:"55000",message:"export_runtime_unavailable"});
  expect(await rpc("request_logo_export",[f.projectId,f.intent])).toEqual(first);expect(await rpc("request_logo_export",[f.projectId,queuedIntent])).toEqual(queued);
  expect((await db.query("select id,state,attempts,reserved_cost_microusd from public.jobs where id=any($1)",[queued.jobIds])).rows).toEqual(before);
  expect((await db.query("select job_id,reserved_microusd,state from public.usage_reservations order by job_id")).rows).toEqual(reservations);
  expect((await db.query("select * from public.job_steps")).rows).toHaveLength(0);expect((await db.query("select * from public.logo_operation_rejections")).rows).toHaveLength(0);
 });
 it("policy revocation before begin blocks even a zero-cost export",async()=>{
  const f=await reviewedExport();await rpc("request_logo_export",[f.projectId,f.intent]);
  const job=await writer(async()=>(await db.query<{id:string;lease_token:string}>("select * from public.claim_logo_job('synthetic-export-worker',120)")).rows[0]!);
  await db.query("update fluid_private.logo_runtime_policies set enabled=false where owner_id=$1 and operation='identity.logo_export'",[OWNER_A]);
  await expect(writer(()=>db.query("select public.begin_logo_job_step($1,$2,'prepare-export',$3,0)",[job.id,job.lease_token,`export-${job.id}`]))).rejects.toBeTruthy();
  expect((await db.query("select * from public.job_steps where job_id=$1",[job.id])).rows).toHaveLength(0);
 });
 it("rejects null partial failure rather than accepting SQL unknown",async()=>{
  const f=await stagedExport(true);
  await expect(writer(()=>db.query("select public.stage_logo_exports($1,$2,$3)",[f.job.id,f.job.lease_token,{...f.group,failure:null}]))).rejects.toMatchObject({code:"22023"});
  expect((await db.query("select * from public.logo_export_publications")).rows).toHaveLength(0);
 });
 it("lost finish acknowledgement preserves committed partial IDs without requeueing",async()=>{
  const f=await stagedExport(true),publication=await f.stage();
  await writer(()=>db.query("select public.complete_logo_job_step($1,$2,'prepare-export','failed',0,$3,null)",[f.job.id,f.job.lease_token,{error:"export_file_failed",result:{version:2,kind:"logo_export_partial",publicationId:publication.id}}]));
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[f.job.id]);
  await writer(()=>db.query("select public.expire_logo_job_leases()"));
  const overview=logoDeliverablesOverviewSchema.parse(await rpc("get_logo_deliverables",[f.projectId,{}]));
  expect(overview.exports).toHaveLength(0);expect(overview.exportRequests[0]!.state.status).toBe("partial");expect(overview.exportRequests[0]!.state.outputs.map(r=>r.id)).toEqual(f.receipts.map(r=>r.id));
  expect((await db.query("select state from public.jobs where id=$1",[f.job.id])).rows[0]).toEqual({state:"failed"});
  expect((await writer(()=>db.query("select * from public.claim_logo_job('synthetic-export-worker',120)"))).rows).toHaveLength(0);
 });
});

describe("P5 exact-object ownership hardening",()=>{
 it("scrubs hostile defaults only on the new tables and exact helper signatures",async()=>{
  const db=await createTestDatabase();
  try {
   const {readFile}=await import("node:fs/promises"),sql=await readFile(new URL("../../supabase/migrations/20261007013000_logo_exports.sql",import.meta.url),"utf8");
   const names=[...sql.matchAll(/create function ((?:public|fluid_private)\.[a-z_]+)\(/g)].map(match=>match[1]!);
   for(const name of names){const [schema,func]=name.split(".");const signatures=(await db.query<{signature:string}>("select p.oid::regprocedure::text signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname=$2",[schema,func])).rows;for(const row of signatures)await db.exec(`drop function ${row.signature} cascade`);}
   await db.exec("drop table public.logo_export_manifests,public.logo_export_publications,public.logo_export_inputs,public.logo_variant_reviews,public.logo_variant_sets cascade; create role fixture_hostile_p5 nologin; create table public.p5_unrelated_sentinel(id integer); grant select on public.p5_unrelated_sentinel to fixture_hostile_p5; create function fluid_private.logo_export_job_outputs(text) returns text language sql as $$ select $1 $$; grant execute on function fluid_private.logo_export_job_outputs(text) to fixture_hostile_p5; alter default privileges grant all on tables to fixture_hostile_p5 with grant option; alter default privileges grant execute on functions to fixture_hostile_p5 with grant option;");
   await db.exec(sql);
   for(const table of ["logo_variant_sets","logo_variant_reviews","logo_export_inputs","logo_export_publications","logo_export_manifests"])for(const privilege of ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER"])expect((await db.query<{allowed:boolean}>("select has_table_privilege('fixture_hostile_p5',$1,$2) allowed",[`public.${table}`,privilege])).rows[0]!.allowed).toBe(false);
   expect((await db.query<{allowed:boolean}>("select has_function_privilege('fixture_hostile_p5','public.stage_logo_exports(uuid,uuid,jsonb)','EXECUTE') allowed")).rows[0]!.allowed).toBe(false);
   expect((await db.query<{allowed:boolean}>("select has_function_privilege('fixture_hostile_p5','fluid_private.logo_export_job_outputs(text)','EXECUTE') allowed")).rows[0]!.allowed).toBe(true);
   expect((await db.query<{allowed:boolean}>("select has_table_privilege('fixture_hostile_p5','public.p5_unrelated_sentinel','SELECT') allowed")).rows[0]!.allowed).toBe(true);
   await db.exec("create table public.p5_later_default_sentinel(id integer)");expect((await db.query<{allowed:boolean}>("select has_table_privilege('fixture_hostile_p5','public.p5_later_default_sentinel','TRUNCATE') allowed")).rows[0]!.allowed).toBe(true);
  } finally {await db.close();}
 },60_000);
});
