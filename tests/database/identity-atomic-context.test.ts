import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
import { asRole,createTestDatabase,HASH,OWNER_A,resetFixture,seedProject,type TestDatabase } from "./local-supabase";
import { seedReference } from "./identity-reference-database";
import { seedIdentityRoot } from "./identity-system-database";
vi.mock("server-only",()=>({}));
import { createIdentityTransactionService } from "../../src/server/data/identity-transaction";
import { createIdentityTransactionFixture } from "../server/fixtures/identity-transaction";

describe("Identity shared transaction rejects invalid authoritative context atomically",()=>{
 let db:TestDatabase,project:string;
 beforeAll(async()=>{db=await createTestDatabase();},30_000);afterAll(async()=>{await db?.close();});
 beforeEach(async()=>{await resetFixture(db);project=(await seedProject(db)).id;});
 it.each(["intake extra","intake step","intake example","intake date","conversation extra","conversation widget order","conversation duplicate id","competitor extra","source extra","source date"])("rejects %s before selection or refinement publication",async(kind)=>{
  const f=await seedIdentityRoot(db,project),context=structuredClone(f.input.context) as unknown as Record<string,unknown>;
  const intake=context.intake as Record<string,unknown>;
  if(kind==="intake extra")intake.extra=true;
  if(kind==="intake step")intake.step="invented";
  if(kind==="intake example")intake.example="true";
  if(kind==="intake date")intake.audienceReviewedAt="bad";
  if(kind==="conversation extra")intake.conversation=[{id:"1",kind:"saved_context",text:"Original",extra:true}];
  if(kind==="conversation widget order")intake.conversation=[{id:"1",kind:"widget",widget:"audience"}];
  if(kind==="conversation duplicate id")intake.conversation=[{id:"1",kind:"user_message",text:"First",createdAt:f.system.createdAt},{id:"1",kind:"widget",widget:"competitors"}];
  if(kind.startsWith("competitor")||kind.startsWith("source")){
   const source:Record<string,unknown>={url:"https://example.com",title:"Evidence",retrievedAt:f.system.createdAt};
   if(kind==="source extra")source.extra=true;
   if(kind==="source date")source.retrievedAt="bad";
   context.competitors=[{id:OWNER_A,name:"Peer",relevance:"Retained",origin:"user",selected:true,sources:[source],...(kind==="competitor extra"?{extra:true}:{})}];
  }
  await asRole(db,"authenticated",OWNER_A,()=>db.query("select public.append_project_revision($1,$2,$3::jsonb,$4)",[project,f.input.projectRevision,JSON.stringify(context),HASH]));
  const fences={expectedProjectRevision:f.input.projectRevision+1,expectedReferenceRevision:f.input.referenceSnapshot.referenceRevision,expectedPreferencesRevision:0,expectedIdentityRevision:0,acceptEarlierBasis:true};
  const service=createIdentityTransactionService(createIdentityTransactionFixture(db,OWNER_A).factory),auth={userId:OWNER_A};
  await expect(service.select(auth,project,{...fences,systemVersionId:f.system.id})).rejects.toMatchObject({code:"integration_unavailable"});
  await expect(service.refine(auth,project,{...fences,baseSystemVersionId:f.system.id,component:"colors",input:{swatches:[{key:"primary",name:"New",hex:"#ABCDEF"}],usageNotes:""},idempotencyKey:"atomic-context-test-0001"})).rejects.toMatchObject({code:"integration_unavailable"});
  for(const table of ["identity_selections","identity_component_changes","asset_usages","identity_sessions"])expect((await db.query(`select count(*)::int count from public.${table}`)).rows[0]).toEqual({count:0});
  expect((await db.query("select count(*)::int count from public.identity_system_versions")).rows[0]).toEqual({count:1});
 });
 it("rejects malformed reference attribution at insertion and before prepared-state publication",async()=>{
  const f=await seedIdentityRoot(db,project);
  await db.exec("BEGIN");
  try { await expect(seedReference(db,project,{attribution:{label:"\u00a0",creator:null,sourceUrl:null,rightsNote:null}})).rejects.toMatchObject({code:"23514"}); }
  finally { await db.exec("ROLLBACK"); }
  const reference=await seedReference(db,project);
  await asRole(db,"authenticated",OWNER_A,()=>db.query("select public.set_identity_reference_reaction($1,$2,$3::jsonb)",[project,reference.reference,JSON.stringify({expectedRevision:0,ensemble:true,elements:[]})]));
  const fixture=createIdentityTransactionFixture(db,OWNER_A);
  fixture.hooks.prepare=value=>{
   const snapshot=value.referenceSnapshot as {selected:Array<{reference:{id:string;attribution:{label:string}}}>};
   snapshot.selected.find(item=>item.reference.id===reference.reference)!.reference.attribution.label="\u00a0";
  };
  await expect(createIdentityTransactionService(fixture.factory).select({userId:OWNER_A},project,{systemVersionId:f.system.id,expectedProjectRevision:f.input.projectRevision,expectedReferenceRevision:2,expectedPreferencesRevision:0,expectedIdentityRevision:0,acceptEarlierBasis:true})).rejects.toMatchObject({code:"integration_unavailable"});
  expect(fixture.events).not.toContain("commit_helper");
  for(const table of ["identity_sessions","identity_selections","asset_usages"])expect((await db.query(`select count(*)::int count from public.${table}`)).rows[0]).toEqual({count:0});
  expect((await db.query("select count(*)::int count from public.identity_reference_snapshots")).rows[0]).toEqual({count:1});
 });

});
