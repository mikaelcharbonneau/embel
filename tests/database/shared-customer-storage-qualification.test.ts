import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { createSharedAccountFixture,sharedHttpRoles,type SharedAccountFixture } from "./shared-account-fixture";
import { qualifySharedHttpConnection } from "../../src/server/shared-account/qualification";
import { qualifySharedStoragePolicies } from "../../src/server/runtime/shared-storage-policy-qualification";

describe("web qualification requires actual enforced customer Storage authority",()=>{
 let f:SharedAccountFixture;
 beforeAll(async()=>{f=await createSharedAccountFixture({selectedLogoBoards:true});},90_000);
 afterAll(async()=>{await f?.db.close();});
 beforeEach(async()=>{await f.db.exec("begin");});
 afterEach(async()=>{await f.db.exec("rollback");});
 async function qualify(lane:"home"|"identity"="home"){
  const role=sharedHttpRoles[lane],oid=Number((await f.db.query<{oid:number}>("select oid::int oid from pg_roles where rolname=$1",[role])).rows[0]!.oid);
  const calls:string[]=[];
  const run=f.asSession(role,()=>qualifySharedHttpConnection({query(sql,args){calls.push(sql);return f.db.query(sql,[...(args??[])]);},release(){},discard(){}},lane,
   {roleName:role,roleOid:oid,host:"inert",port:5432,tls:true,user:role,password:"inert"},"https://fricsfwqibyhemknqgyf.supabase.co"));
  return {run,calls};
 }
 it("qualifies both actual fixed web roles under the reviewed policy",async()=>{
  for(const lane of ["home","identity"] as const)await (await qualify(lane)).run;
 });
 it.each([
  "drop policy embel_shared_customer_storage_live on storage.objects",
  "alter policy embel_shared_customer_storage_live on storage.objects using(true) with check(true)",
  "alter policy embel_shared_customer_storage_live on storage.objects to authenticated,service_role",
  "alter table storage.objects disable row level security",
 ])("rejects a missing or weakened policy before executing the role proof: %s",async sql=>{
  await f.db.exec(sql);const probe=await qualify();await expect(probe.run).rejects.toMatchObject({code:"integration_unavailable"});
  expect(probe.calls.some(call=>call.includes("SELECT public.shared_account_http_principal()"))).toBe(false);
 });
 it("rejects altered helper code before proving the fixed login",async()=>{
  await f.db.exec("create or replace function fluid_private.shared_http_customer_storage_live() returns boolean language plpgsql security definer set search_path='' as $$begin return true;end$$");
  const probe=await qualify();await expect(probe.run).rejects.toMatchObject({code:"integration_unavailable"});
  expect(probe.calls.some(call=>call.includes("SELECT public.shared_account_http_principal()"))).toBe(false);
 });
 it.each([
  "drop policy embel_shared_legacy_storage_registry_fence on storage.objects",
  "alter policy embel_shared_legacy_storage_registry_fence on storage.objects using(true) with check(true)",
  "alter policy embel_shared_legacy_storage_registry_fence on storage.objects with check(true)",
  "alter policy embel_shared_legacy_storage_registry_fence on storage.objects to authenticated,service_role",
  "drop policy embel_shared_legacy_storage_registry_fence on storage.objects;create policy embel_shared_legacy_storage_registry_fence on storage.objects as restrictive for all to authenticated with check((bucket_id <> 'fluid-assets'::text) OR (SELECT fluid_private.shared_storage_legacy_registry_present()))",
  "alter function fluid_private.shared_storage_legacy_registry_present() security invoker",
  "grant execute on function fluid_private.shared_storage_legacy_registry_present() to public",
  "revoke execute on function fluid_private.shared_storage_legacy_registry_present() from authenticated",
  "create or replace function fluid_private.shared_storage_legacy_registry_present() returns boolean language sql stable security definer set search_path='' as $$select true$$",
 ])("rejects a missing/weakened permanent legacy fence before any proof RPC: %s",async sql=>{
  await f.db.exec(sql);const probe=await qualify();await expect(probe.run).rejects.toMatchObject({code:"integration_unavailable"});
  expect(probe.calls.some(call=>call.includes("SELECT public.shared_account_http_principal()"))).toBe(false);
 });
 it("rejects NULL helper configuration metadata before the fixed-role proof",async()=>{
  await f.db.exec("alter function fluid_private.shared_storage_legacy_registry_present() reset all");
  await expect(f.asSession(sharedHttpRoles.home,()=>qualifySharedStoragePolicies(f.db))).rejects.toThrow("shared_storage_policy_unavailable");
  const probe=await qualify();await expect(probe.run).rejects.toBeDefined();
  expect(probe.calls.some(call=>call.includes("SELECT public.shared_account_http_principal()"))).toBe(false);
 });
});
