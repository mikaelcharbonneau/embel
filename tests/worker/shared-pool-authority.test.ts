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
 it("retains the finite eleven-packet bound",()=>{
  expect(sharedAuthorityManifestSchema.safeParse({...authorityManifest,packets:Array.from({length:12},()=>authorityManifest.packets[0])}).success).toBe(false);
 });
});
