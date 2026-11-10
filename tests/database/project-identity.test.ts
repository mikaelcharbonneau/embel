import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createIdentityTransactionService } from "../../src/server/data/identity-transaction";
import { createIdentityTransactionFixture } from "../server/fixtures/identity-transaction";
import { updateIdentityPreferencesResponseSchema } from "../../src/domain/project-identity";
import { asRole,createTestDatabase,HASH,OWNER_A,OWNER_B,resetFixture,seedProject,type TestDatabase } from "./local-supabase";

// Isolated metadata fixtures only. No image generation or live service access.
describe("Identity preference transactions at the authenticated database boundary",()=>{
 let db:TestDatabase;let projectId:string;
 beforeAll(async()=>{db=await createTestDatabase();},30_000);afterAll(async()=>{await db?.close();});
 beforeEach(async()=>{await resetFixture(db);projectId=(await seedProject(db)).id;});
 const preferences={version:1,creativeLocale:"en",notes:"Owned direction",avoidanceNotes:""};
 const save=(input:unknown,owner=OWNER_A,id=projectId)=>asRole(db,"authenticated",owner,async()=>{
  const result=await db.query<{result:unknown}>("select public.set_identity_preferences($1,$2::jsonb) result",[id,JSON.stringify(input)]);
  return updateIdentityPreferencesResponseSchema.parse(result.rows[0]!.result);
 });
 it("reads untouched current inputs without creating session, preference or reference snapshot rows",async()=>{
  const reply=await asRole(db,"authenticated",OWNER_A,()=>db.query<{result:Record<string,unknown>}>("select public.get_project_identity($1,'{}') result",[projectId]));
  expect(reply.rows[0]!.result).toMatchObject({project:{id:projectId,owner_id:OWNER_A,current_revision:1},session:null,preferences:null,referenceSnapshot:{ownerId:OWNER_A,projectId,referenceRevision:0,selectedReferenceCount:0,selected:[]},history:{records:[],nextCursor:null},selection:null});
  for(const table of ["identity_sessions","identity_preferences","identity_reference_snapshots"]){expect((await db.query(`select count(*)::int count from public.${table}`)).rows[0]).toEqual({count:0});}
  await expect(asRole(db,"authenticated",OWNER_B,()=>db.query("select public.get_project_identity($1,'{}')",[projectId]))).rejects.toMatchObject({code:"P0002"});
 });
 it.each([{ownerId:OWNER_A},{limit:51},{limit:"20"},{cursor:{}},{cursor:{projectId:OWNER_B,id:OWNER_A,createdAt:"2026-10-04T00:00:00Z"}}])("rejects invalid or foreign Identity history query %j",async(query)=>{
  await expect(asRole(db,"authenticated",OWNER_A,()=>db.query("select public.get_project_identity($1,$2::jsonb)",[projectId,JSON.stringify(query)]))).rejects.toMatchObject({code:("cursor" in query && query.cursor && "projectId" in query.cursor && query.cursor.projectId===OWNER_B)?"P0002":"22023"});
 });
 it("creates only the explicitly saved preference revision without a selection or project edit",async()=>{
  const before=(await db.query("select to_jsonb(p) row from public.projects p where id=$1",[projectId])).rows;
  const result=await save({expectedPreferencesRevision:0,preferences});
  expect(result.session).toMatchObject({ownerId:OWNER_A,projectId,currentPreferencesRevision:1,identityRevision:0,currentSelectionId:null});
  expect(result.preferences).toMatchObject({ownerId:OWNER_A,projectId,revision:1,preferences});
  expect((await db.query("select to_jsonb(p) row from public.projects p where id=$1",[projectId])).rows).toEqual(before);
 });
 it("independently CAS saves preferences after an unrelated saved project revision",async()=>{
  await asRole(db,"authenticated",OWNER_A,()=>db.query("select public.append_project_revision($1,1,$2::jsonb,$3)",[projectId,JSON.stringify({description:"Later context"}),HASH]));
  const first=await save({expectedPreferencesRevision:0,preferences});
  const second=await save({expectedPreferencesRevision:1,preferences:{...preferences,notes:"A later explicit preference"}});
  expect(second.preferences.revision).toBe(2);expect(first.preferences.revision).toBe(1);
  await expect(save({expectedPreferencesRevision:1,preferences})).rejects.toMatchObject({code:"PT409"});
  expect((await db.query("select count(*)::int count from public.identity_preferences where project_id=$1",[projectId])).rows[0]).toEqual({count:2});
 });
 it("keeps preferences and their session tenant-bound under actual RLS",async()=>{
  await save({expectedPreferencesRevision:0,preferences});
  await expect(save({expectedPreferencesRevision:0,preferences},OWNER_B)).rejects.toMatchObject({code:"P0002"});
  for(const table of ["identity_preferences","identity_sessions"]){
   const rows=await asRole(db,"authenticated",OWNER_B,()=>db.query(`select * from public.${table}`));expect(rows.rows).toEqual([]);
  }
 });
 it("matches actual Zod codepoint bounds and ECMAScript trimming",async()=>{
  const result=await save({expectedPreferencesRevision:0,preferences:{version:1,creativeLocale:"\ufeffen\u2028",notes:"\u00a0"+"😀".repeat(2000)+"\ufeff",avoidanceNotes:" e\u0301 "}});
  expect(result.preferences.preferences).toEqual({version:1,creativeLocale:"en",notes:"😀".repeat(2000),avoidanceNotes:"e\u0301"});
  await expect(save({expectedPreferencesRevision:1,preferences:{...preferences,notes:"😀".repeat(2001)}})).rejects.toMatchObject({code:"22023"});
  await expect(save({expectedPreferencesRevision:1,preferences:{...preferences,notes:"e\u0301".repeat(1001)}})).rejects.toMatchObject({code:"22023"});
 });
 it.each([
  {ownerId:OWNER_A},{provider:"forged"},{expectedProjectRevision:1},{systemVersionId:OWNER_A},
 ])("rejects privileged or unrelated top-level input %j",async(extra)=>{
  await expect(save({expectedPreferencesRevision:0,preferences,...extra})).rejects.toMatchObject({code:"22023"});
 });
 it.each([
  null,[],{version:"1",creativeLocale:"en",notes:"",avoidanceNotes:""},{version:1,creativeLocale:"e",notes:"",avoidanceNotes:""},
  {version:1,creativeLocale:"en",notes:null,avoidanceNotes:""},{version:1,creativeLocale:"en",notes:""},
  {version:1,creativeLocale:"en",notes:"",avoidanceNotes:"",source:"generated"},
 ])("rejects malformed direct-RPC preferences %j",async(value)=>{
  await expect(save({expectedPreferencesRevision:0,preferences:value})).rejects.toMatchObject({code:"22023"});
 });
 it.each([-1,0.5,"0",9007199254740992,null])("rejects invalid preference counters %j",async(expectedPreferencesRevision)=>{
  await expect(save({expectedPreferencesRevision,preferences})).rejects.toMatchObject({code:"22023"});
 });
 it("denies raw writes and keeps preference history immutable even for privileged normal UPDATE",async()=>{
  await save({expectedPreferencesRevision:0,preferences});
  await expect(asRole(db,"authenticated",OWNER_A,()=>db.query("update public.identity_sessions set current_preferences_revision=0 where project_id=$1",[projectId]))).rejects.toMatchObject({code:"42501"});
  await expect(asRole(db,"authenticated",OWNER_A,()=>db.query("insert into public.identity_preferences(project_id,owner_id,revision,preferences) values($1,$2,2,$3::jsonb)",[projectId,OWNER_A,JSON.stringify(preferences)]))).rejects.toMatchObject({code:"42501"});
  await expect(db.query("update public.identity_preferences set preferences='{}' where project_id=$1",[projectId])).rejects.toMatchObject({code:"55000"});
 });
 it("denies anonymous execution and ungranted private helper calls",async()=>{
  await expect(asRole(db,"anon",null,()=>db.query("select public.set_identity_preferences($1,$2::jsonb)",[projectId,JSON.stringify({expectedPreferencesRevision:0,preferences})]))).rejects.toMatchObject({code:"42501"});
  await expect(asRole(db,"authenticated",OWNER_A,()=>db.query("select fluid_private.identity_preferences_value($1::jsonb)",[JSON.stringify(preferences)]))).rejects.toMatchObject({code:"42501"});
 });
});

import { seedIdentityRoot } from "./identity-system-database";
describe("Identity guarded public SQL and injected trusted source transactions",()=>{
 let db:TestDatabase;let projectId:string;
 beforeAll(async()=>{db=await createTestDatabase();},30_000);afterAll(async()=>{await db?.close();});beforeEach(async()=>{await resetFixture(db);projectId=(await seedProject(db)).id;});
 async function rpc(name:string,input:unknown,owner=OWNER_A,id=projectId){
  const service=createIdentityTransactionService(createIdentityTransactionFixture(db,owner).factory);
  const result=name==="select_identity_system" ? await service.select({userId:owner},id,input) : await service.refine({userId:owner},id,input);
  return {rows:[{result}]};
 }
 const request=(f:Awaited<ReturnType<typeof seedIdentityRoot>>)=>({systemVersionId:f.system.id,expectedProjectRevision:f.input.projectRevision,expectedReferenceRevision:f.input.referenceSnapshot.referenceRevision,expectedPreferencesRevision:0,expectedIdentityRevision:0,acceptEarlierBasis:false});
 it.each(["identity_sessions","identity_preferences","identity_input_snapshots","identity_system_versions","identity_batches","identity_generated_roots","identity_system_files","identity_selections","identity_component_changes","asset_usages"])("denies direct owner and anonymous %s writes",async(table)=>{
  for(const role of ["authenticated","anon"] as const)await expect(asRole(db,role,role==="authenticated"?OWNER_A:null,()=>db.query(`delete from public.${table}`))).rejects.toMatchObject({code:"42501"});
 });
 it("keeps every populated immutable source table owner-scoped under actual RLS",async()=>{
  const f=await seedIdentityRoot(db,projectId);await rpc("select_identity_system",request(f));
  const {systemVersionId,...fences}=request(f);
  await rpc("refine_identity_component",{...fences,baseSystemVersionId:systemVersionId,expectedIdentityRevision:1,component:"colors",input:{swatches:[{key:"x",name:"Edited",hex:"#ABCDEF"}],usageNotes:""},idempotencyKey:"local-source-rls-0001"});
  for(const table of ["identity_sessions","identity_input_snapshots","identity_system_versions","identity_batches","identity_generated_roots","identity_system_files","identity_selections","identity_component_changes","asset_usages"]){
   expect((await db.query<{count:number}>(`select count(*)::int count from public.${table}`)).rows[0]!.count).toBeGreaterThan(0);
   expect((await asRole(db,"authenticated",OWNER_B,()=>db.query(`select * from public.${table}`))).rows).toEqual([]);
  }
 });
 it.each(["state","operation","manifest","index","input","board"])("rejects corrupted administrative %s evidence before a trusted commit",async(kind)=>{
  const f=await seedIdentityRoot(db,projectId);
  if(kind==="state")await db.query("update public.job_steps set state='failed' where job_id=$1",[f.jobId]);
  if(kind==="operation")await db.query("update public.jobs set operation='naming.generate' where id=$1",[f.jobId]);
  if(kind==="manifest")await db.query("update public.job_steps set output=jsonb_set(output,'{identity,systems,0,components,logo,direction}','\"forged change\"') where job_id=$1",[f.jobId]);
  if(kind==="input")await db.query("update public.job_steps set output=jsonb_set(output,'{identity,input,scope}','\"naming_only\"') where job_id=$1",[f.jobId]);
  if(kind==="index"||kind==="board"){
   await db.exec("alter table public.identity_generated_roots disable trigger user");
   if(kind==="index")await db.query("update public.identity_generated_roots set output_index=2 where system_id=$1",[f.system.id]);
   else await db.query("update public.identity_generated_roots set board=jsonb_set(board,'{contentHash}',to_jsonb($2::text)) where system_id=$1",[f.system.id,HASH]);
   await db.exec("alter table public.identity_generated_roots enable trigger user");
  }
  await expect(rpc("select_identity_system",request(f))).rejects.toMatchObject({code:"integration_unavailable"});
  expect((await db.query("select count(*)::int count from public.identity_selections")).rows[0]).toEqual({count:0});expect((await db.query("select count(*)::int count from public.asset_usages")).rows[0]).toEqual({count:0});
 });
 it("does not infer a root from generic success or a generated-shaped manifest",async()=>{
  const f=await seedIdentityRoot(db,projectId);await db.exec("alter table public.identity_generated_roots disable trigger user");await db.query("delete from public.identity_generated_roots where system_id=$1",[f.system.id]);await db.exec("alter table public.identity_generated_roots enable trigger user");
  await expect(rpc("select_identity_system",request(f))).rejects.toMatchObject({code:"integration_unavailable"});
 });
 it("retains actual completed output when the overall job is later cancelled",async()=>{
  const f=await seedIdentityRoot(db,projectId);await db.query("update public.jobs set state='cancelled' where id=$1",[f.jobId]);await expect(rpc("select_identity_system",request(f))).resolves.toBeDefined();
 });
 it.each([{ownerId:OWNER_B},{source:{kind:"generated"}},{currentBasis:{}},{acceptEarlierBasis:"false"},{expectedReferenceRevision:"1"},{expectedIdentityRevision:0.1}])("rejects caller-supplied metadata or malformed counters %j before acquisition",async(extra)=>{
  const f=await seedIdentityRoot(db,projectId);await expect(rpc("select_identity_system",{...request(f),...extra})).rejects.toMatchObject({code:"invalid_input"});
 });
 it("does not authorize foreign or same-owner cross-project source selection",async()=>{
  const f=await seedIdentityRoot(db,projectId);const other=(await seedProject(db)).id;const otherRoot=await seedIdentityRoot(db,other);
  await expect(rpc("select_identity_system",{...request(f),expectedProjectRevision:otherRoot.input.projectRevision,expectedReferenceRevision:otherRoot.input.referenceSnapshot.referenceRevision},OWNER_A,other)).rejects.toMatchObject({code:"not_found"});
  await expect(rpc("select_identity_system",request(f),OWNER_B)).rejects.toMatchObject({code:"not_found"});
 });
 it("denies execution of every private Identity helper and keeps the worker unchanged",async()=>{
  const rows=await db.query<{signature:string;auth:boolean;anon:boolean;worker:boolean}>("select p.oid::regprocedure::text signature,has_function_privilege('authenticated',p.oid,'execute') auth,has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('fixture_subscription_worker_a',p.oid,'execute') worker from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='fluid_private' and p.proname like 'identity_%'");
  expect(rows.rows.length).toBeGreaterThan(10);for(const row of rows.rows)expect({auth:row.auth,anon:row.anon,worker:row.worker}).toEqual({auth:false,anon:false,worker:false});
 });
});
