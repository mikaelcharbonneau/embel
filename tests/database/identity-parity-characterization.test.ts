import { afterAll,beforeAll,beforeEach,describe,expect,it } from "vitest";
import { asRole,createTestDatabase,HASH,OWNER_A,resetFixture,seedProject,type TestDatabase } from "./local-supabase";
import { seedIdentityRoot } from "./identity-system-database";

// Historical pre-gate RED is retained separately. Public bypass now fails closed;
// shared WHATWG/parser behavior is exercised by identity-transaction.test.ts.
describe("Identity direct RPC bypass remains unavailable",()=>{
 let db:TestDatabase,project:string;
 beforeAll(async()=>{db=await createTestDatabase();},30_000);afterAll(async()=>{await db?.close();});beforeEach(async()=>{await resetFixture(db);project=(await seedProject(db)).id;});
 it("blocks invalid URL publication through the guarded public RPC",async()=>{
  const f=await seedIdentityRoot(db,project),context={...structuredClone(f.input.context),competitors:[{id:OWNER_A,name:"Peer",relevance:"Retained",origin:"user",selected:true,url:"https://[broken",sources:[]}]};
  await asRole(db,"authenticated",OWNER_A,()=>db.query("select public.append_project_revision($1,$2,$3::jsonb,$4)",[project,f.input.projectRevision,JSON.stringify(context),HASH]));
  const mutation=asRole(db,"authenticated",OWNER_A,()=>db.query("select public.select_identity_system($1,$2::jsonb) value",[project,JSON.stringify({systemVersionId:f.system.id,expectedProjectRevision:f.input.projectRevision+1,expectedReferenceRevision:f.input.referenceSnapshot.referenceRevision,expectedPreferencesRevision:0,expectedIdentityRevision:0,acceptEarlierBasis:true})]));
  await expect(mutation.then(()=>"committed invalid URL receipt")).rejects.toMatchObject({code:"55000"});
  expect((await db.query("select count(*)::int count from public.identity_selections")).rows[0]).toEqual({count:0});
 });
});
