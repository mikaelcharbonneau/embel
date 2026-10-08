import { reportLogoFixtureReady } from './logo-readiness-fixture';
import { createHash, randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { asRole,createTestDatabase,OWNER_A,OWNER_B,resetFixture,type TestDatabase } from "./local-supabase";
import { logoWorkspaceV2Schema,type LogoMutationReceipt } from "@/domain/logo-workspace";
import { identityDirectionsOverviewSchema } from "@/domain/logo-directions";
import { normalizeDirectionResponse } from "@/features/identity-directions/server/direction-response";
import { inspectTypographySamples } from "@/features/identity-directions/server/font-inspection";
import { buildDirectionSelectionEvidence } from "@/features/identity-directions/server/selection";
import { fontFixture,fontBytes } from "../features/identity-directions/fixtures";
import { separatedLogoDocument } from "../features/logo-vector/fixtures";
import { logoCostQuoteSchema, logoDispatchReceiptSchema } from "@/domain/logo-jobs";
import type { LogoResolvedDirectionInput } from "@/domain/logo-jobs";
const brief={name:"Fluid Test",activity:"Studio",audience:"Teams",personality:"Precise",logoTypes:["wordmark"]};
describe("local post-logo direction persistence",()=>{
 let db:TestDatabase;
 beforeAll(async()=>{db=await createTestDatabase();await db.exec("create role fixture_direction_writer login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;grant usage on schema public,fluid_private to fixture_direction_writer;grant execute on function fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb),public.load_logo_direction_inputs(uuid,uuid),public.stage_logo_directions(uuid,uuid,jsonb,uuid,jsonb),public.read_logo_direction_selection_sources(uuid,jsonb),public.claim_logo_job(text,integer),public.begin_logo_job_step(uuid,uuid,text,text,bigint),public.record_logo_provider_response(uuid,uuid,jsonb),public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text),public.finish_logo_job(uuid,uuid,text) to fixture_direction_writer;create function public.fixture_commit_direction(p_job uuid,p_publication uuid,p_receipt uuid) returns jsonb language plpgsql security definer set search_path='' as $$ declare j public.jobs; begin select * into j from public.jobs where id=p_job; return fluid_private.logo_commit_direction_publication(j,p_publication,p_receipt); end $$; revoke all on function public.fixture_commit_direction(uuid,uuid,uuid) from public;grant execute on function public.fixture_commit_direction(uuid,uuid,uuid) to fixture_direction_writer;");},60_000);
 afterAll(async()=>{await db?.close();});
 beforeEach(async()=>{await resetFixture(db);for(const table of ["logo_asset_web_principals","logo_worker_principals"])await db.query(`insert into fluid_private.${table}(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_direction_writer' on conflict(role_name) do nothing`,[OWNER_A]);});
 const rpc=(name:string,args:unknown[],owner=OWNER_A)=>asRole(db,"authenticated",owner,async()=>(await db.query<{value:unknown}>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(",")}) value`,args)).rows[0]!.value);
 async function writer<T>(run:()=>Promise<T>){await db.exec("set session authorization fixture_direction_writer");try{return await run();}finally{await db.exec("set session authorization postgres");}}
 async function trusted(project:string,command:unknown,evidence:unknown){return writer(async()=>(await db.query<{value:LogoMutationReceipt}>("select fluid_private.apply_logo_trusted_command($1,$2,$3) value",[project,command,evidence])).rows[0]!.value);}
 async function setup(){
  const start=logoWorkspaceV2Schema.parse(await rpc("start_logo_project",[{requestKey:randomUUID(),brief}])),vectorId=randomUUID();
  await db.query("insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4)",[vectorId,OWNER_A,start.projectId,{id:vectorId,ownerId:OWNER_A,projectId:start.projectId,reviewStatus:"review_required",inputRevisions:[start.stages.brief_references],locks:[]}]);
  const approved=await trusted(start.projectId,{method:"acceptLogoVector",body:{requestKey:randomUUID(),expected:start.heads,vectorRevisionId:vectorId,acceptEarlierBasis:false}},{vectorRevisionId:vectorId,currentVectorRevisionId:null,expected:start.heads});
  const w=approved.workspace,original=fontFixture(),font={...original,asset:{...original.asset,ownerId:OWNER_A,projectId:w.projectId}};
  await db.query("insert into public.logo_font_records(record_id,version_id,owner_id,project_id,record) values($1,$2,$3,$4,$5)",[font.id,font.asset.versionId,OWNER_A,w.projectId,font]);
  const source=(await db.query<{value:Record<string,unknown>}>("select fluid_private.logo_prepare_direction_sources($1,$2,$3) value",[OWNER_A,w.projectId,w.approvedLogo!.id])).rows[0]!.value;
  const resolved={...source,logo:separatedLogoDocument()} as unknown as LogoResolvedDirectionInput;delete (resolved as unknown as Record<string,unknown>).logoRevision;
  const candidate={directions:[0,1,2].map(n=>({name:`Local direction ${n+1}`,palette:{swatches:[{key:"ink",name:"Ink",hex:["#191919","#242424","#333333"][n]},{key:"paper",name:"Paper",hex:"#FFFFFF"}],pairings:[{role:"body",foregroundKey:"ink",backgroundKey:"paper"}]},typography:{styles:[{key:"body",role:"body",sampleText:brief.name,fontVersionId:font.id,weight:400,style:"normal",sizePx:16,lineHeight:1.5}]},graphics:{elements:[]}}))};
  const result=normalizeDirectionResponse(candidate,resolved),checks=await inspectTypographySamples({record:font,bytes:fontBytes(),contentHash:font.asset.contentHash,purpose:"render"},result.typography.flatMap(t=>t.styles.map(s=>({typographyVersionId:t.id,styleKey:s.key,role:s.role,text:s.sampleText,weight:s.weight,style:s.style}))));
  const job=randomUUID(),lease=randomUUID(),quote=randomUUID(),provider=randomUUID(),hash="a".repeat(64);
  await db.query("insert into public.logo_cost_quotes(id,owner_id,project_id,operation,record,input_revisions,source_inputs,expires_at) values($1,$2,$3,'identity.logo_directions',$4,$5,$6,clock_timestamp()+interval '5 minutes')",[quote,OWNER_A,w.projectId,{inputHash:hash,expected:w.heads},source.inputRevisions,{direction:source}]);
  const input={version:2,ownerId:OWNER_A,projectId:w.projectId,operation:"identity.logo_directions",requestKey:randomUUID(),quoteId:quote,policyIdentity:hash,handlerVersion:"logo-directions-v1",inputHash:hash,approvedLogoId:w.approvedLogo!.id,briefRevisionId:w.stages.brief_references!.id,referenceSnapshotId:(source.references as {id:string}).id,fontVersionIds:[font.id],targetCount:3};
  await db.query("insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,lease_token,lease_expires_at,reserved_cost_microusd) values($1,$2,$3,'identity.logo_directions',1,$4,$5,$6,'running',$7,clock_timestamp()+interval '5 minutes',100)",[job,OWNER_A,w.projectId,hash,input,randomUUID(),lease]);
  await db.query("select fluid_private.logo_freeze_direction_inputs(j,$2) from public.jobs j where id=$1",[job,source]);
  await db.query("insert into public.logo_provider_responses(id,owner_id,project_id,job_id,lease_token,observation) values($1,$2,$3,$4,$5,$6)",[provider,OWNER_A,w.projectId,job,lease,{provider:"synthetic",model:"test-only",providerRequestId:"fixture-request",responseHash:hash,artifactHash:null,observedAt:"2026-10-07T00:00:00Z",billing:{status:"recorded",confirmedMicrousd:10}}]);
  const stage=()=>writer(async()=>(await db.query<{value:{id:string}}>("select public.stage_logo_directions($1,$2,$3,$4,$5) value",[job,lease,result,provider,checks])).rows[0]!.value);
  const commit=(publication:string)=>writer(async()=>(await db.query<{value:unknown}>("select public.fixture_commit_direction($1,$2,$3) value",[job,publication,provider])).rows[0]!.value);
  return{w,source,result,checks,job,lease,provider,stage,commit};
 }
 it("stages exactly three directions invisibly then commits immutable sources once",async()=>{const f=await setup(),publication=await f.stage();expect(await f.stage()).toEqual(publication);expect((await db.query("select * from public.logo_direction_records")).rows).toHaveLength(0);await f.commit(publication.id);expect((await db.query("select * from public.logo_direction_records")).rows).toHaveLength(12);const overview=identityDirectionsOverviewSchema.parse(await rpc("list_logo_workspace_records",[f.w.projectId,"directions_overview",{}]));expect(overview.directions).toHaveLength(3);expect(overview.fontChecks).toHaveLength(3);expect(overview.selection).toBeNull();expect(overview.currentApprovedLogo).toEqual(f.w.approvedLogo);});
 it("foreign reads and browser publication calls expose no source",async()=>{const f=await setup(),p=await f.stage();await f.commit(p.id);await expect(rpc("list_logo_workspace_records",[f.w.projectId,"directions_overview",{}],OWNER_B)).rejects.toMatchObject({code:"P0002"});await expect(rpc("stage_logo_directions",[f.job,f.lease,f.result,f.provider,f.checks])).rejects.toMatchObject({code:"42501"});expect(await asRole(db,"authenticated",OWNER_B,async()=>(await db.query("select * from public.logo_direction_records")).rows)).toEqual([]);});
 it("rejects changed specimen evidence and expired leases without publishing",async()=>{const f=await setup();const checks=structuredClone(f.checks);checks[0]!.sampleHash="f".repeat(64);await expect(writer(()=>db.query("select public.stage_logo_directions($1,$2,$3,$4,$5)",[f.job,f.lease,f.result,f.provider,checks]))).rejects.toMatchObject({code:"22023"});await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[f.job]);await expect(f.stage()).rejects.toMatchObject({code:"40001"});expect((await db.query("select * from public.logo_direction_records")).rows).toHaveLength(0);});
 it("a changed approved logo retains completed directions without moving the new head",async()=>{const f=await setup(),p=await f.stage();await db.query("select fluid_private.logo_append_stage($1,$2,'vector',$3,'[]')",[OWNER_A,f.w.projectId,{vectorRevisionId:randomUUID(),approvalId:null}]);expect(await f.commit(p.id)).toBeNull();expect((await db.query("select * from public.logo_direction_records")).rows).toHaveLength(12);const w=logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace",[f.w.projectId]));expect(w.stages.directions).toBeNull();expect(w.approvedLogo).toBeNull();});
 it("a cancelled known direction result is retained without advancing the current head",async()=>{const f=await setup(),p=await f.stage();await db.query("update public.jobs set state='cancel_requested' where id=$1",[f.job]);expect(await f.commit(p.id)).toBeNull();expect((await db.query("select * from public.logo_direction_records")).rows).toHaveLength(12);const w=logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace",[f.w.projectId]));expect(w.stages.directions).toBeNull();expect(w.approvedLogo).toEqual(f.w.approvedLogo);});
 it("mix selection and separate approval preserve exact logo and invalidate deliverables",async()=>{const f=await setup(),p=await f.stage();await f.commit(p.id);const ids={paletteVersionId:f.result.palettes[0].id,typographyVersionId:f.result.typography[1].id,graphicsVersionId:f.result.graphics[2].id};const overview=identityDirectionsOverviewSchema.parse(await rpc("read_logo_direction_selection_sources",[f.w.projectId,ids]));const w=logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace",[f.w.projectId])),body={requestKey:randomUUID(),expected:w.heads,approvedLogoId:w.approvedLogo!.id,...ids};const evidence=await buildDirectionSelectionEvidence(overview,body);const selected=await trusted(w.projectId,{method:"selectIdentityDirectionComponents",body},evidence);expect(selected.revision.payload).toMatchObject({approvalId:null});expect(selected.workspace.approvedLogo).toEqual(w.approvedLogo);const current=identityDirectionsOverviewSchema.parse(await rpc("read_logo_direction_selection_sources",[w.projectId,ids]));const approval={requestKey:randomUUID(),expected:selected.workspace.heads,directionSelectionId:current.selection!.id,consistencyHash:current.selection!.consistency.hash};const approved=await trusted(w.projectId,{method:"approveIdentityDirection",body:approval},evidence);expect(approved.revision.payload).toMatchObject({selectionId:current.selection!.id});expect(approved.revision.payload).not.toMatchObject({approvalId:null});expect(await trusted(w.projectId,{method:"approveIdentityDirection",body:approval},evidence)).toEqual(approved);});

 async function seedRetainedGroup(f:Awaited<ReturnType<typeof setup>>){
  const retainedIds=new Map([...f.result.directions,...f.result.palettes,...f.result.typography,...f.result.graphics].map(row=>[row.id,randomUUID()]));
  for(const [kind,rows] of [["palette",f.result.palettes],["typography",f.result.typography],["graphics",f.result.graphics],["direction",f.result.directions]] as const){for(const row of rows){const record={...row,id:retainedIds.get(row.id)!};if("paletteVersionId" in record)Object.assign(record,{name:"Retained history",paletteVersionId:retainedIds.get(record.paletteVersionId),typographyVersionId:retainedIds.get(record.typographyVersionId),graphicsVersionId:retainedIds.get(record.graphicsVersionId)});await db.query("insert into public.logo_direction_records(id,owner_id,project_id,kind,approved_logo_id,record,created_at) values($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 minute')",[record.id,OWNER_A,f.w.projectId,kind,f.w.approvedLogo!.id,record]);}}
  for(const check of f.checks){const record={...check,typographyVersionId:retainedIds.get(check.typographyVersionId)!};await db.query("insert into public.logo_direction_font_checks(typography_id,style_key,owner_id,project_id,record) values($1,$2,$3,$4,$5)",[record.typographyVersionId,record.styleKey,OWNER_A,f.w.projectId,record]);}
  return f.result.directions.map(row=>retainedIds.get(row.id)!);
 }
 it("saving all components from A preserves B and C across reload and later retained history",async()=>{
  const f=await setup(),p=await f.stage();await f.commit(p.id);
  const idsA={paletteVersionId:f.result.palettes[0].id,typographyVersionId:f.result.typography[0].id,graphicsVersionId:f.result.graphics[0].id};
  const exactA=identityDirectionsOverviewSchema.parse(await rpc("read_logo_direction_selection_sources",[f.w.projectId,idsA]));
  const before=logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace",[f.w.projectId]));
  const body={requestKey:randomUUID(),expected:before.heads,approvedLogoId:before.approvedLogo!.id,...idsA};
  const saved=await trusted(f.w.projectId,{method:"selectIdentityDirectionComponents",body},await buildDirectionSelectionEvidence(exactA,body));
  expect(saved.revision.payload).toMatchObject({directionIds:f.result.directions.map(d=>d.id)});
  const reloaded=identityDirectionsOverviewSchema.parse(await rpc("list_logo_workspace_records",[f.w.projectId,"directions_overview",{}]));
  expect(new Set(reloaded.directions.map(d=>d.id))).toEqual(new Set(f.result.directions.map(d=>d.id)));expect(reloaded.selection!.sourceDirectionIds).toEqual([f.result.directions[0].id]);
  // A later retained group that did not advance the head cannot replace its choices.
  await seedRetainedGroup(f);
  const stillCurrent=identityDirectionsOverviewSchema.parse(await rpc("list_logo_workspace_records",[f.w.projectId,"directions_overview",{}]));
  expect(new Set(stillCurrent.directions.map(d=>d.id))).toEqual(new Set(f.result.directions.map(d=>d.id)));
  expect(stillCurrent.nextCursor).toBe("history");const history=identityDirectionsOverviewSchema.parse(await rpc("list_logo_workspace_records",[f.w.projectId,"directions_overview",{cursor:stillCurrent.nextCursor}]));expect(history.directions).toHaveLength(3);expect(history.directions.every(d=>d.name==="Retained history")).toBe(true);
  const mixedBody={...body,requestKey:randomUUID(),expected:saved.workspace.heads,typographyVersionId:f.result.typography[1].id};
  const mixed=await trusted(f.w.projectId,{method:"selectIdentityDirectionComponents",body:mixedBody},await buildDirectionSelectionEvidence(stillCurrent,mixedBody));
  expect(mixed.revision.payload).toMatchObject({directionIds:f.result.directions.map(d=>d.id)});
  const final=identityDirectionsOverviewSchema.parse(await rpc("list_logo_workspace_records",[f.w.projectId,"directions_overview",{}]));expect(final.selection!.typographyVersionId).toBe(f.result.typography[1].id);expect(final.selection!.sourceDirectionIds).toEqual([f.result.directions[0].id,f.result.directions[1].id]);
 });
 it.each([1,2])("public reader traverses all current choices before retained history at limit %s",async(limit)=>{
  const f=await setup(),publication=await f.stage();await f.commit(publication.id);
  const currentIds=f.result.directions.map(row=>row.id),before=await rpc("get_logo_workspace",[f.w.projectId]);
  for(const withHistory of [false,true]){
   const historyIds=withHistory?await seedRetainedGroup(f):[];const seen:string[]=[],cursors=new Set<string>();let cursor:string|undefined;
   do{
    const page=identityDirectionsOverviewSchema.parse(await rpc("list_logo_workspace_records",[f.w.projectId,"directions_overview",{limit,...(cursor?{cursor}:{})}]));
    expect(page.directions.length).toBeGreaterThan(0);expect(page.directions.length).toBeLessThanOrEqual(limit);
    seen.push(...page.directions.map(row=>row.id));
    if(page.nextCursor){expect(cursors.has(page.nextCursor)).toBe(false);cursors.add(page.nextCursor);}
    cursor=page.nextCursor??undefined;
   }while(cursor);
   expect(seen.slice(0,3)).toEqual(currentIds);expect(new Set(seen.slice(3))).toEqual(new Set(historyIds));expect(new Set(seen).size).toBe(seen.length);expect(seen).toHaveLength(currentIds.length+historyIds.length);
  }
  expect(await rpc("get_logo_workspace",[f.w.projectId])).toEqual(before);
 });
 it.each(["recorded","unknown","invalid","unpublished","unrecorded"] as const)("integrates quoted direction completion with %s outcome",async(mode)=>{
  const f=await setup();
  await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled) values($1,'identity.logo_directions',$2,'logo-directions-v1','synthetic','test-only',100,true) on conflict(owner_id,operation) do update set enabled=true",[OWNER_A,"b".repeat(64)]);
  await reportLogoFixtureReady(db,'fixture_direction_writer',['direction-fixture'],[{operation:'identity.logo_directions',policyIdentity:'b'.repeat(64),handlerVersion:'logo-directions-v1',provider:'synthetic',model:'test-only',engine:null,maxCostMicrousd:100}]);
  const quote=logoCostQuoteSchema.parse(await rpc("quote_logo_operation",[f.w.projectId,{operation:"directions",expected:f.w.heads,approvedLogoId:f.w.approvedLogo!.id}]));
  const intent={requestKey:randomUUID(),quoteId:quote.id,acceptedMaxCostMicrousd:100,expected:f.w.heads};
  const admitted=logoDispatchReceiptSchema.parse(await rpc("admit_logo_operation",[f.w.projectId,intent]));expect(admitted.jobIds).toHaveLength(1);expect(await rpc("admit_logo_operation",[f.w.projectId,intent])).toEqual(admitted);
  await writer(async()=>{
   const job=(await db.query<{id:string;lease_token:string;input:{fontVersionIds:string[]};plan_manifest:{key:string}[]}>("select * from public.claim_logo_job('direction-fixture',60)")).rows[0]!;
   expect(job.id).toBe(admitted.jobIds[0]);expect(job.input.fontVersionIds).toEqual([fontFixture().id]);expect(job.plan_manifest[0]!.key).toBe("propose-directions");
   await db.query("select public.begin_logo_job_step($1,$2,'propose-directions',$3,100)",[job.id,job.lease_token,`request-${job.id}`]);
   const response=mode==="unrecorded"?null:(await db.query<{value:{id:string}}>("select public.record_logo_provider_response($1,$2,$3) value",[job.id,job.lease_token,{provider:"synthetic",model:"test-only",providerRequestId:"actual-fixture-request",responseHash:"c".repeat(64),artifactHash:null,observedAt:"2026-10-07T00:00:00Z",billing:mode==="unknown"?{status:"unknown",confirmedMicrousd:null}:{status:"recorded",confirmedMicrousd:10}}])).rows[0]!.value;
   const publication=response?(await db.query<{value:{id:string}}>("select public.stage_logo_directions($1,$2,$3,$4,$5) value",[job.id,job.lease_token,f.result,response.id,f.checks])).rows[0]!.value:null;
   const output={version:2,kind:"logo_directions",publicationId:publication?.id,providerResponseReceiptId:response?.id};
   const raw=JSON.stringify({actual:"partial response\u0000"}),reason=mode==="unrecorded"?"provider_evidence_unconfirmed":"publication_unknown";
   const unpublished={error:reason,result:{version:2,kind:"logo_directions_unpublished",reason,payload:{json:raw,sha256:createHash("sha256").update(raw).digest("hex"),byteLength:Buffer.byteLength(raw),truncated:false}}};
   const payload=mode==="recorded"?output:mode==="unknown"?{error:"billing_unknown",result:output}:mode==="unpublished"||mode==="unrecorded"?unpublished:{error:"direction_payload_invalid",result:{directions:[{partial:true}]}};
   await db.query("select public.complete_logo_job_step($1,$2,'propose-directions',$3,$4,$5,'actual-fixture-request')",[job.id,job.lease_token,mode==="recorded"?"succeeded":"ambiguous",mode==="unknown"?0:10,payload]);
   if(mode==="recorded")await db.query("select public.finish_logo_job($1,$2,'succeeded')",[job.id,job.lease_token]);
  });
  const saved=identityDirectionsOverviewSchema.parse(await rpc("list_logo_workspace_records",[f.w.projectId,"directions_overview",{}]));expect(saved.directions).toHaveLength(mode==="recorded"?3:0);
  if(mode!=="recorded"){expect((await db.query("select state from public.jobs where id=$1",[admitted.jobIds[0]])).rows[0]).toEqual({state:"needs_reconciliation"});expect((await db.query("select committed_at from public.logo_direction_publications where job_id=$1",[admitted.jobIds[0]])).rows[0]).toEqual(mode==="unrecorded"?undefined:{committed_at:null});
   if(mode==="unpublished"||mode==="unrecorded"){const retained=(await db.query<{output:{result:{payload:{json:string}}}}>("select output from public.job_steps where job_id=$1",[admitted.jobIds[0]])).rows[0]!.output;expect(JSON.parse(retained.result.payload.json)).toEqual({actual:"partial response\u0000"});}}
  expect(saved.currentApprovedLogo).toEqual(f.w.approvedLogo);expect(await rpc("admit_logo_operation",[f.w.projectId,intent])).toEqual(admitted);
 });

});

describe("P4 exact-object table ACL hardening",()=>{
 it("removes hostile default grants from new tables and preserves unrelated defaults",async()=>{
  const db=await createTestDatabase();
  try{
   const {readFile}=await import("node:fs/promises");
   const sql=await readFile(new URL("../../supabase/migrations/20261007012000_logo_directions.sql",import.meta.url),"utf8");
   const functions=[...sql.matchAll(/create function ([a-z_]+)\.([a-z_]+)\(/g)].map(match=>({schema:match[1]!,name:match[2]!}));
   for(const fn of functions){const rows=(await db.query<{signature:string}>("select p.oid::regprocedure::text signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname=$2",[fn.schema,fn.name])).rows;for(const row of rows)await db.exec(`drop function ${row.signature} cascade`);}
   await db.exec("drop table public.logo_direction_font_checks,public.logo_direction_records,public.logo_direction_publications,public.logo_direction_inputs cascade;create role fixture_hostile_p4 nologin;create table public.p4_unrelated_acl_sentinel(id integer);grant select on public.p4_unrelated_acl_sentinel to fixture_hostile_p4;alter default privileges grant all on tables to fixture_hostile_p4 with grant option;");
   await db.exec(sql);
   for(const table of ["logo_direction_inputs","logo_direction_publications","logo_direction_records","logo_direction_font_checks"]){for(const privilege of ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER"]){expect((await db.query<{allowed:boolean}>("select has_table_privilege('fixture_hostile_p4',$1,$2) allowed",[`public.${table}`,privilege])).rows[0]!.allowed).toBe(false);}}
   expect((await db.query<{allowed:boolean}>("select has_table_privilege('fixture_hostile_p4','public.p4_unrelated_acl_sentinel','SELECT') allowed")).rows[0]!.allowed).toBe(true);
   await db.exec("create table public.p4_after_defaults_sentinel(id integer)");
   expect((await db.query<{allowed:boolean}>("select has_table_privilege('fixture_hostile_p4','public.p4_after_defaults_sentinel','TRUNCATE') allowed")).rows[0]!.allowed).toBe(true);
  }finally{await db.close();}
 },60_000);
});
