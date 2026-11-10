import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import authorityManifest from "../../worker/shared-pool/authority-manifest.json";
import { sharedAuthorityManifestSchema,verifySharedAuthorityCatalog,type SharedAuthorityManifest } from "../../worker/shared-pool/authority";
import { createSharedWorkerFixture,type SharedWorkerFixture,type SharedFixtureSlot } from "../database/shared-worker-fixture";
import { SHARED_CORE_RPC_PROOFS } from "../../worker/shared-pool/proofs";

/** Actual restricted SQL catalogs in disposable PGlite, not a qualified hosted
 * client. Source expectations are extracted from reviewed SQL, never learned
 * from the potentially altered server in the verification path. */
describe("source-owned authority catalog guard before proof RPCs",()=>{
 let f:SharedWorkerFixture,slot:SharedFixtureSlot,manifest:SharedAuthorityManifest,definition:string;
 beforeAll(async()=>{
  f=await createSharedWorkerFixture({probe:false});slot=await f.seedSlot();
  const path="supabase/candidates/shared_worker_pool.sql",sql=await readFile(new URL("../../supabase/candidates/shared_worker_pool.sql",import.meta.url),"utf8");
  const found=/create function fluid_private\.shared_worker_role_safe\([^$]+?as \$\$([\s\S]*?)\$\$;/u.exec(sql);if(!found)throw Error("Missing source helper");definition=found[0];
  manifest={version:1,packets:[{path,sha256:createHash("sha256").update(sql).digest("hex")}],functions:[
   {schema:"fluid_private",name:"shared_worker_role_safe",argumentTypes:"name, oid",sha256:createHash("sha256").update(found[1]!).digest("hex"),language:"sql",volatility:"s",securityDefiner:true,leakproof:false,owner:"postgres",searchPath:['search_path=""'],broadExecute:false,lanes:["strategy"]},
   {schema:"public",name:"shared_worker_pool_configuration",argumentTypes:"",...SHARED_CORE_RPC_PROOFS.capacity,securityDefiner:true,leakproof:false,owner:"postgres",searchPath:['search_path=""'],broadExecute:false,lanes:["strategy"]},
  ]};
 },60_000);
 afterAll(async()=>{await f?.close();});
 async function verify(){return f.asSlot(slot,async()=>{
  await f.db.exec("BEGIN READ ONLY; SET LOCAL search_path=''");
  expect((await f.db.query<{allowed:boolean}>("select has_schema_privilege(session_user,'fluid_private','USAGE') allowed")).rows[0]!.allowed).toBe(false);
  const queries:string[]=[];const database={async query(sql:string,args:unknown[]=[]){queries.push(sql);return f.db.query<Record<string,unknown>>(sql,args);}};
  const result=await verifySharedAuthorityCatalog(database,"strategy",manifest);
  expect(queries).toHaveLength(1);expect(queries[0]).toContain("pg_catalog.oidvectortypes");expect(queries[0]).not.toContain("to_regprocedure");
  return result;
 });}
 it("checks private source metadata without granting private schema access or calling the proof",async()=>{
  const result=await verify();expect(result.required).toHaveLength(2);expect(result.lookup("fluid_private","shared_worker_role_safe","name, oid")?.callable).toBe(false);
 });
 it("rejects a hostile private helper body before that helper can bless an unsafe role",async()=>{
  await f.db.exec("create or replace function fluid_private.shared_worker_role_safe(p_name name,p_oid oid) returns boolean language sql stable security definer set search_path='' as $$ select true $$");
  try{await expect(verify()).rejects.toThrow("manifest");}finally{await f.db.exec(definition.replace("create function","create or replace function"));}
 });
 it("rejects accidentally exposing a source-owned private helper to PUBLIC",async()=>{
  await f.db.exec("grant execute on function fluid_private.shared_worker_role_safe(name,oid) to PUBLIC");
  try{await expect(verify()).rejects.toThrow("manifest");}finally{await f.db.exec("revoke execute on function fluid_private.shared_worker_role_safe(name,oid) from PUBLIC");}
 });
});

// Use the actual source-owned manifest, including the additive future Naming
// packet, rather than a hand-built smaller roster that misses startup parsing.
describe("reviewed authority packet roster",()=>{
 it("parses the complete current source manifest before database qualification",()=>{
  expect(sharedAuthorityManifestSchema.parse(authorityManifest)).toEqual(authorityManifest);
 });
 it("pins the additive repair and exact two function bodies without changing the frozen original packet",async()=>{
  for(const packet of authorityManifest.packets){
   const source=await readFile(new URL("../../"+packet.path,import.meta.url),"utf8");
   expect(createHash("sha256").update(source).digest("hex")).toBe(packet.sha256);
  }
  const original=await readFile(new URL("../../supabase/candidates/shared_naming_brainstorm.sql",import.meta.url),"utf8");
  const repair=await readFile(new URL("../../supabase/candidates/shared_naming_brainstorm_event_capacity.sql",import.meta.url),"utf8");
  const originalBody=/create or replace function public\.shared_naming_worker_action\([\s\S]*?as \$\$([\s\S]*?)end \$\$;/u.exec(original)?.[1];
  expect(originalBody).toBeDefined();
  const body=originalBody+"end ";
  expect(createHash("sha256").update(body).digest("hex")).toBe("e8bae9ed6a46f0b87e8c78474d5d059dd608b27442421e730d2f0c9f4e599ea4");
  const fixed=body.replace("select 1 from fluid_private.naming_brainstorm_events where call_id=c.call_id and payload=p_args","select 1 from fluid_private.naming_brainstorm_events replay_event where replay_event.call_id=c.call_id and replay_event.payload=p_args");
  const recovery=await readFile(new URL("../../supabase/candidates/shared_naming_brainstorm_delivery_recovery.sql",import.meta.url),"utf8");
  const gatewayNeedle=/needle:=\$needle\$([\s\S]*?)\$needle\$;/u.exec(recovery)?.[1];
  const gatewayReplacement=/replacement:=\$replacement\$([\s\S]*?)\$replacement\$;/u.exec(recovery)?.[1];
  expect(gatewayNeedle).toBeDefined();expect(gatewayReplacement).toBeDefined();
  const current=fixed.replace(gatewayNeedle!,gatewayReplacement!);
  expect(current).not.toBe(fixed);
  // Lease expiry inserts one slot-level branch at the delivery-recovery line.
  const expiry=await readFile(new URL("../../supabase/candidates/shared_naming_lease_expiry.sql",import.meta.url),"utf8");
  const expiryNeedle=/needle:=\$needle\$([\s\S]*?)\$needle\$;/u.exec(expiry)?.[1];
  const expiryReplacement=/replacement:=\$replacement\$([\s\S]*?)\$replacement\$;/u.exec(expiry)?.[1];
  expect(expiryNeedle).toBeDefined();expect(expiryReplacement).toBeDefined();
  expect(current.split(expiryNeedle!)).toHaveLength(2);
  const latest=current.replace(expiryNeedle!,expiryReplacement!);
  expect(latest).not.toBe(current);
  // Since November 2026 the Naming generation packet replaces the gateway in place.
  const generation=await readFile(new URL("../../supabase/candidates/shared_naming_generation.sql",import.meta.url),"utf8");
  const generationBody=/create or replace function public\.shared_naming_worker_action\([\s\S]*?as \$\$([\s\S]*?)\$\$;/u.exec(generation)?.[1];
  expect(generationBody).toBeDefined();
  expect(authorityManifest.functions.find(f=>f.schema==="public"&&f.name==="shared_naming_worker_action")?.sha256).toBe(createHash("sha256").update(generationBody!).digest("hex"));
  const expiryBody=/create function fluid_private\.expire_shared_naming_leases\([\s\S]*?as \$\$([\s\S]*?)\$\$;/u.exec(expiry)?.[1];
  expect(expiryBody).toBeDefined();
  // The November 2026 cleanup packet removes the retired brainstorm helpers.
  expect(authorityManifest.functions.some(f=>f.name==="expire_shared_naming_leases")).toBe(false);
  const deliveryBody=/create function fluid_private\.recover_naming_brainstorm_delivery\([\s\S]*?as \$\$([\s\S]*?)\$\$;/u.exec(recovery)?.[1];
  expect(deliveryBody).toBeDefined();
  expect(authorityManifest.functions.some(f=>f.name==="recover_naming_brainstorm_delivery")).toBe(false);
  const helper=/AS \$guard_body\$([\s\S]*?)\$guard_body\$/u.exec(repair)?.[1];
  expect(helper).toBeDefined();
  expect(authorityManifest.functions.some(f=>f.name==="naming_brainstorm_event_replay_guard_v1")).toBe(false);
 });
 it("retains the finite twenty-four-packet bound",()=>{
  expect(sharedAuthorityManifestSchema.safeParse({...authorityManifest,packets:Array.from({length:25},()=>authorityManifest.packets[0])}).success).toBe(false);
 });
});
