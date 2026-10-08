import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { setIdentityPreferences,getProjectIdentity,listIdentitySystems,getIdentitySystem,selectIdentitySystem,refineIdentityComponent } from "../../src/server/data/identity";
import { createIdentityTransactionService } from "../../src/server/data/identity-transaction";
import { createIdentityTransactionFixture } from "./fixtures/identity-transaction";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { asRole,createTestDatabase,HASH,OWNER_A,OWNER_B,resetFixture,seedProject,type TestDatabase } from "../database/local-supabase";
import { seedIdentityRoot,identityDalAuth } from "../database/identity-system-database";
describe("Identity preference DAL through actual local SQL",()=>{
 let db:TestDatabase;let projectId:string;let auth:AuthenticatedContext;
 beforeAll(async()=>{db=await createTestDatabase();},30_000);afterAll(async()=>{await db?.close();});
 function context(owner=OWNER_A):AuthenticatedContext{return {userId:owner,client:{rpc:async(name:string,args:Record<string,unknown>)=>{
  try{if(!["set_identity_preferences","get_project_identity","list_identity_systems","get_identity_system"].includes(name))throw Error("Unexpected fixture RPC");
   const result=await asRole(db,"authenticated",owner,()=>db.query<{result:unknown}>(`select public.${name}(${Object.keys(args).map((key,index)=>`${key}=>$${index+1}`).join(",")}) result`,Object.values(args).map(value=>value && typeof value==="object"?JSON.stringify(value):value)));return{data:result.rows[0]!.result,error:null};
  }catch(error){return{data:null,error:{code:(error as {code:string}).code}};}
 }}} as unknown as AuthenticatedContext;}
 beforeEach(async()=>{await resetFixture(db);projectId=(await seedProject(db)).id;auth=context();});
 const preferences={version:1,creativeLocale:"en",notes:"Local direction",avoidanceNotes:""};
 it("reads genuine empty history and unavailable current name without inventing preferences or generation",async()=>{
  const result=await getProjectIdentity(auth,projectId.toUpperCase());expect(result.session).toBeNull();expect(result.preferences).toBeNull();expect(result.systems.items).toEqual([]);expect(result.currentBasis).toEqual({status:"unavailable",reason:"missing_name"});expect(result.readiness.ready).toBe(false);
  expect((await listIdentitySystems(auth,projectId)).items).toEqual([]);
  await expect(getProjectIdentity(context(OWNER_B),projectId)).rejects.toMatchObject({code:"not_found"});
  await expect(getIdentitySystem(auth,projectId,OWNER_A)).rejects.toMatchObject({code:"not_found"});
 });
 it("resolves an explicitly synthetic exact completed root and its real owned files",async()=>{
  const fixture=await seedIdentityRoot(db,projectId);const debug=await db.query<{system:unknown;output:unknown;refs:unknown;input:unknown;basis:unknown}>("select fluid_private.identity_system_json(s) system,j.output output,r.snapshot refs,i.input input,fluid_private.identity_basis(i.owner_id,i.project_id,p.context,r.snapshot,i.input->'preferences') basis from public.identity_system_versions s join public.identity_input_snapshots i on i.id=s.input_id join public.project_revisions p on p.project_id=i.project_id and p.revision=i.project_revision join public.identity_reference_snapshots r on r.project_id=i.project_id and r.reference_revision=i.reference_revision join public.identity_generated_roots g on g.system_id=s.id join public.job_steps j on j.job_id=g.job_id and j.step_key=g.step_key where s.id=$1",[fixture.system.id]);
  const row=debug.rows[0]!;expect(row.system).toEqual(fixture.system);expect(row.refs).toEqual(fixture.input.referenceSnapshot);expect(row.input).toEqual(fixture.input);expect(row.basis).toEqual(fixture.input.basis);
  await asRole(db,"authenticated",OWNER_A,()=>db.query("select public.get_identity_system($1,$2)",[projectId,fixture.system.id]));const actual=await getIdentitySystem(identityDalAuth(db),projectId,fixture.system.id.toUpperCase());
  expect(actual.system).toEqual(fixture.system);expect(actual.freshness).toEqual({status:"current",changed:[]});
  const overview=await getProjectIdentity(identityDalAuth(db),projectId);expect(overview.systems.items).toHaveLength(1);expect(overview.systems.items[0]!.id).toBe(fixture.system.id);
 });
 it("returns the exact canonical owned preference revision without a false UUID casing failure",async()=>{
  const response=await setIdentityPreferences(auth,projectId.toUpperCase(),{expectedPreferencesRevision:0,preferences});
  expect(response.preferences).toMatchObject({ownerId:OWNER_A,projectId,revision:1,preferences});expect(response.session.identityRevision).toBe(0);
 });
 it("rejects invalid input before dispatch and maps expected revision conflicts",async()=>{
  const spy=vi.spyOn(auth.client,"rpc");await expect(setIdentityPreferences(auth,projectId,{expectedPreferencesRevision:0,preferences,ownerId:OWNER_A})).rejects.toMatchObject({code:"invalid_input"});expect(spy).not.toHaveBeenCalled();
  await setIdentityPreferences(auth,projectId,{expectedPreferencesRevision:0,preferences});await expect(setIdentityPreferences(auth,projectId,{expectedPreferencesRevision:0,preferences})).rejects.toMatchObject({code:"conflict"});
 });
 it("fences foreign and mismatched valid mutation receipts",async()=>{
  const response=await setIdentityPreferences(auth,projectId,{expectedPreferencesRevision:0,preferences});
  const foreign=context(OWNER_B);vi.spyOn(foreign.client,"rpc").mockResolvedValueOnce({data:response,error:null} as never);
  await expect(setIdentityPreferences(foreign,projectId,{expectedPreferencesRevision:0,preferences})).rejects.toMatchObject({code:"not_found"});
  vi.spyOn(auth.client,"rpc").mockResolvedValueOnce({data:response,error:null} as never);await expect(setIdentityPreferences(auth,projectId,{expectedPreferencesRevision:0,preferences:{...preferences,notes:"Different request"}})).rejects.toMatchObject({code:"integration_unavailable"});
 });
 function transactions(owner=OWNER_A){return createIdentityTransactionService(createIdentityTransactionFixture(db,owner).factory);}
 function selectRequest(fixture:Awaited<ReturnType<typeof seedIdentityRoot>>,expectedIdentityRevision=0){return{systemVersionId:fixture.system.id,expectedProjectRevision:fixture.input.projectRevision,expectedReferenceRevision:fixture.input.referenceSnapshot.referenceRevision,expectedPreferencesRevision:0,expectedIdentityRevision,acceptEarlierBasis:false};}
 function refineRequest(fixture:Awaited<ReturnType<typeof seedIdentityRoot>>,expectedIdentityRevision=0){const {systemVersionId,...rest}=selectRequest(fixture,expectedIdentityRevision);return{...rest,baseSystemVersionId:systemVersionId,component:"colors" as const,input:{swatches:[{key:"primary",name:" New forest ",hex:"#aabbcc"}],usageNotes:" User choice "},idempotencyKey:"identity-refinement-test-0001"};}
 it("keeps production selection and refinement unavailable while preserving owned history and preference CAS",async()=>{
  const fixture=await seedIdentityRoot(db,projectId),rpc=identityDalAuth(db);
  for(const mutation of [()=>selectIdentitySystem(rpc,projectId,selectRequest(fixture)),()=>refineIdentityComponent(rpc,projectId,refineRequest(fixture))])await expect(mutation()).rejects.toMatchObject({code:"integration_unavailable"});
  for(const mutation of [()=>selectIdentitySystem(identityDalAuth(db,OWNER_B),projectId,selectRequest(fixture)),()=>refineIdentityComponent(identityDalAuth(db,OWNER_B),projectId,refineRequest(fixture))])await expect(mutation()).rejects.toMatchObject({code:"not_found"});
  for(const table of ["identity_sessions","identity_selections","identity_component_changes","asset_usages"])expect((await db.query(`select count(*)::int count from public.${table}`)).rows[0]).toEqual({count:0});
  const overview=await getProjectIdentity(rpc,projectId);expect(overview.saveAvailability).toEqual({status:"unavailable",reason:"trusted_transaction_unavailable"});expect(overview.systems.items.map(system=>system.id)).toEqual([fixture.system.id]);
  await expect(setIdentityPreferences(rpc,projectId,{expectedPreferencesRevision:0,preferences})).resolves.toMatchObject({preferences:{revision:1}});
  expect((await getProjectIdentity(rpc,projectId)).saveAvailability).toEqual({status:"unavailable",reason:"trusted_transaction_unavailable"});
 });
 it("selects exact system through an explicitly synthetic injected capability and files atomically, restoring history without changing asset heads",async()=>{
  const fixture=await seedIdentityRoot(db,projectId),rpc=identityDalAuth(db);const request=selectRequest(fixture);
  const selected=await transactions().select(rpc,projectId.toUpperCase(),{...request,systemVersionId:fixture.system.id.toUpperCase()});
  expect(selected.currentSelection.selection).toMatchObject({identityRevision:1,reason:"selected",acceptedEarlierBasis:false});
  const overview=await getProjectIdentity(rpc,projectId);expect(overview.currentSelection!.system).toEqual(fixture.system);expect(overview.currentSelection!.selection.id).toBe(selected.currentSelection.selection.id);
  const used=(await db.query("select count(*)::int count from public.asset_usages")).rows[0];expect(used).toEqual({count:2});
  const restored=await transactions().select(rpc,projectId,{...request,expectedIdentityRevision:1,acceptEarlierBasis:true});expect(restored.currentSelection.selection).toMatchObject({identityRevision:2,reason:"restored",acceptedEarlierBasis:false,previousSelectionId:selected.currentSelection.selection.id});
  await expect(transactions().select(rpc,projectId,request)).rejects.toMatchObject({code:"conflict"});expect((await db.query("select count(*)::int count from public.identity_selections")).rows[0]).toEqual({count:2});
  const assets=await asRole(db,"authenticated",OWNER_A,()=>db.query<{value:{items:Array<{asset:{usage:{active:boolean};currentSelection:unknown}}>}}>("select public.list_account_assets('{}') value"));expect(assets.rows[0]!.value.items).toHaveLength(2);for(const item of assets.rows[0]!.value.items){expect(item.asset.usage.active).toBe(true);expect(item.asset.currentSelection).toBeNull();}
 });
 it("replays a normalized manual edit against its exact base, removes obsolete files and keeps original input",async()=>{
  const fixture=await seedIdentityRoot(db,projectId),rpc=identityDalAuth(db),request=refineRequest(fixture);
  const result=await transactions().refine(rpc,projectId.toUpperCase(),{...request,baseSystemVersionId:fixture.system.id.toUpperCase()});
  expect(result.system.source).toMatchObject({kind:"manual_edit",baseSystemVersionId:fixture.system.id});expect(result.system.input).toEqual(fixture.input);expect(result.system.board.asset).toEqual(fixture.system.board.asset);expect(result.system.board.staleComponents).toEqual(["colors"]);expect(result.system.productionFiles).toEqual([]);
  expect(result.change.after).toEqual({swatches:[{key:"primary",name:"New forest",hex:"#AABBCC"}],usageNotes:"User choice"});
  expect((await getIdentitySystem(rpc,projectId,result.system.id)).system).toEqual(result.system);
  await transactions().select(rpc,projectId,selectRequest(fixture,1));const replay=await transactions().refine(rpc,projectId,request);expect(replay).toEqual(result);expect((await getProjectIdentity(rpc,projectId)).currentSelection!.system.id).toBe(fixture.system.id);
  await expect(transactions().refine(rpc,projectId,{...request,acceptEarlierBasis:true})).rejects.toMatchObject({code:"conflict"});
 });
 it.each(["expectedProjectRevision","expectedReferenceRevision","expectedPreferencesRevision","expectedIdentityRevision"] as const)("fences %s independently with no partial writes",async(key)=>{
  const fixture=await seedIdentityRoot(db,projectId),rpc=identityDalAuth(db),request=selectRequest(fixture);await expect(transactions().select(rpc,projectId,{...request,[key]:request[key]+1})).rejects.toMatchObject({code:"conflict"});
  expect((await db.query("select count(*)::int count from public.identity_selections")).rows[0]).toEqual({count:0});expect((await db.query("select count(*)::int count from public.asset_usages")).rows[0]).toEqual({count:0});
 });
 it("requires acknowledgment of changed material inputs and records current source revisions",async()=>{
  const fixture=await seedIdentityRoot(db,projectId),rpc=identityDalAuth(db);const context={...fixture.input.context,description:"Different saved strategy"};
  await asRole(db,"authenticated",OWNER_A,()=>db.query("select public.append_project_revision($1,$2,$3::jsonb,$4)",[projectId,fixture.input.projectRevision,JSON.stringify(context),HASH]));
  const request={...selectRequest(fixture),expectedProjectRevision:fixture.input.projectRevision+1};await expect(transactions().select(rpc,projectId,request)).rejects.toMatchObject({code:"conflict"});
  const result=await transactions().select(rpc,projectId,{...request,acceptEarlierBasis:true});expect(result.currentSelection.selection.acceptedEarlierBasis).toBe(true);expect(result.currentSelection.freshness).toEqual({status:"stale",changed:["strategy"]});expect(result.currentSelection.system.input).toEqual(fixture.input);
 });
 it("preserves material freshness through Unicode trim/NFC and unrelated context edits",async()=>{
  const fixture=await seedIdentityRoot(db,projectId),rpc=identityDalAuth(db);const context={...fixture.input.context,description:"\ufeffExplicit synthetic Identity source\u2028",intake:{...fixture.input.context.intake,namingNotes:"Unrelated naming note"}};
  await asRole(db,"authenticated",OWNER_A,()=>db.query("select public.append_project_revision($1,$2,$3::jsonb,$4)",[projectId,fixture.input.projectRevision,JSON.stringify(context),HASH]));
  const result=await transactions().select(rpc,projectId,{...selectRequest(fixture),expectedProjectRevision:fixture.input.projectRevision+1});expect(result.currentSelection.freshness.status).toBe("current");
 });
 it("rejects no-op refinements and cross-owner reads or writes before publication",async()=>{
  const fixture=await seedIdentityRoot(db,projectId),rpc=identityDalAuth(db);await expect(transactions().refine(rpc,projectId,{...refineRequest(fixture),input:fixture.system.components.colors})).rejects.toMatchObject({code:"invalid_input"});
  for(const action of [()=>getIdentitySystem(identityDalAuth(db,OWNER_B),projectId,fixture.system.id),()=>transactions(OWNER_B).select(identityDalAuth(db,OWNER_B),projectId,selectRequest(fixture))])await expect(action()).rejects.toMatchObject({code:"not_found"});
  expect((await db.query("select count(*)::int count from public.identity_component_changes")).rows[0]).toEqual({count:0});
 });

 it("orders full fractional timestamps and returns exact cursor spelling across offset-equivalent instants",async()=>{
  const older=await seedIdentityRoot(db,projectId,{createdAt:"2026-10-04T01:00:00.1234567Z"});
  const newer=await seedIdentityRoot(db,projectId,{createdAt:"2026-10-04T03:00:00.1234568+02:00"});
  const rpc=identityDalAuth(db),first=await listIdentitySystems(rpc,projectId,{limit:1});expect(first.items[0]!.id).toBe(newer.system.id);expect(first.nextCursor!.createdAt).toBe(newer.system.createdAt);
  const cursor={...first.nextCursor!,id:first.nextCursor!.id.toUpperCase(),projectId:projectId.toUpperCase()};
  const second=await listIdentitySystems(rpc,projectId.toUpperCase(),{limit:1,cursor});expect(second.items[0]!.id).toBe(older.system.id);expect(second.nextCursor).toBeNull();
 });
 it("matches schema-valid noncanonical context defaults, material trim and retained optional metadata",async()=>{
  const raw={description:"\ufeffA cafe\u2028",selectedName:"Cafe\u0301",intake:{suppliedName:"Cafe\u0301",identityNotes:" Initial direction ",conversation:[{id:"saved-1",kind:"saved_context",text:" Preserved original wording "}]},competitors:[{id:"CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC",name:" Existing peer ",relevance:" Relevant comparison ",origin:"user"}]};
  const f=await seedIdentityRoot(db,projectId,{rawContext:raw});const result=await getIdentitySystem(identityDalAuth(db),projectId,f.system.id);expect(result.system.input).toEqual(f.input);expect(result.system.input.basis.name).toBe("Café");expect(result.system.input.context.intake.conversation).toEqual(raw.intake.conversation);
  await expect(transactions().select(identityDalAuth(db),projectId,selectRequest(f))).resolves.toBeDefined();
 });
 it("keeps history readable when the current saved name is missing or inconsistent",async()=>{
  const f=await seedIdentityRoot(db,projectId),rpc=identityDalAuth(db);const current={...f.input.context,selectedName:null,intake:{...f.input.context.intake,suppliedName:""}};
  await asRole(db,"authenticated",OWNER_A,()=>db.query("select public.append_project_revision($1,$2,$3::jsonb,$4)",[projectId,f.input.projectRevision,JSON.stringify(current),HASH]));
  const result=await getProjectIdentity(rpc,projectId);expect(result.currentBasis).toEqual({status:"unavailable",reason:"missing_name"});expect(result.systems.items[0]!.freshness).toEqual(result.currentBasis);
  // Administrative corruption models a historical inconsistent snapshot which
  // current generic name writes correctly reject. It must remain readable.
  await db.exec("alter table public.project_revisions disable trigger user");await db.query("update public.project_revisions set context=jsonb_set(context,'{selectedName}','\"Other\"')||jsonb_build_object('intake',context->'intake'||'{\"suppliedName\":\"Cedar\"}'::jsonb) where project_id=$1 and revision=$2",[projectId,f.input.projectRevision+1]);await db.exec("alter table public.project_revisions enable trigger user");
  const inconsistent=await getProjectIdentity(rpc,projectId);expect(inconsistent.currentBasis).toEqual({status:"unavailable",reason:"inconsistent_name"});expect(inconsistent.systems.items).toHaveLength(1);
 });

});
