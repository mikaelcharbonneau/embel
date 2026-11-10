import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { getIdentitySystem,getProjectIdentity,selectIdentitySystem,refineIdentityComponent } from "../../src/server/data/identity";
import { asRole,createTestDatabase,OWNER_A,resetFixture,seedProject,type TestDatabase } from "./local-supabase";
import { identityDalAuth,seedIdentityRoot } from "./identity-system-database";

describe("Identity mutation fail-closed boundary pending trusted transaction",()=>{
 let db:TestDatabase,project:string,f:Awaited<ReturnType<typeof seedIdentityRoot>>;
 beforeAll(async()=>{db=await createTestDatabase();},30_000);afterAll(async()=>{await db?.close();});
 beforeEach(async()=>{await resetFixture(db);project=(await seedProject(db)).id;f=await seedIdentityRoot(db,project);});
 const fences=()=>({expectedProjectRevision:f.input.projectRevision,expectedReferenceRevision:f.input.referenceSnapshot.referenceRevision,expectedPreferencesRevision:0,expectedIdentityRevision:0,acceptEarlierBasis:false});
 const select=()=>({...fences(),systemVersionId:f.system.id});
 const refine=()=>({...fences(),baseSystemVersionId:f.system.id,component:"colors",input:{swatches:[{key:"primary",name:"New",hex:"#ABCDEF"}],usageNotes:""},idempotencyKey:"unavailable-refinement-0001"});
 async function unchanged(){for(const table of ["identity_sessions","identity_selections","identity_component_changes","asset_usages"])expect((await db.query(`select count(*)::int count from public.${table}`)).rows[0]).toEqual({count:0});expect((await db.query("select count(*)::int count from public.identity_system_versions")).rows[0]).toEqual({count:1});}
 it("returns unavailable through DAL while preserving owned history",async()=>{
  const auth=identityDalAuth(db);
  expect((await getIdentitySystem(auth,project,f.system.id)).system).toEqual(f.system);const overview=await getProjectIdentity(auth,project);expect(overview.systems.items).toHaveLength(1);expect(overview.saveAvailability).toEqual({status:"unavailable",reason:"trusted_transaction_unavailable"});
  await expect(selectIdentitySystem(auth,project,select())).rejects.toMatchObject({code:"integration_unavailable"});
  await expect(refineIdentityComponent(auth,project,refine())).rejects.toMatchObject({code:"integration_unavailable"});await unchanged();
 });
 it("denies authenticated raw context/head writes at actual database permissions",async()=>{
  await expect(asRole(db,"authenticated",OWNER_A,()=>db.query("update public.project_revisions set context='{}' where project_id=$1",[project]))).rejects.toMatchObject({code:"42501"});
  await expect(asRole(db,"authenticated",OWNER_A,()=>db.query("update public.projects set current_revision=1 where id=$1",[project]))).rejects.toMatchObject({code:"42501"});
  const rights=await db.query<{role:string;table_name:string;can_insert:boolean;can_update:boolean;can_delete:boolean}>("select r.role,t.table_name,has_table_privilege(r.role,t.table_name,'INSERT') can_insert,has_table_privilege(r.role,t.table_name,'UPDATE') can_update,has_table_privilege(r.role,t.table_name,'DELETE') can_delete from (values ('authenticated'),('anon'),('fixture_subscription_worker_a')) r(role) cross join (values ('public.projects'),('public.project_revisions'),('public.identity_sessions'),('public.identity_system_versions'),('public.identity_selections')) t(table_name)");
  for(const row of rights.rows)expect({insert:row.can_insert,update:row.can_update,delete:row.can_delete}).toEqual({insert:false,update:false,delete:false});
 });

});
