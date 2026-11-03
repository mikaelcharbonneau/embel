import { beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
const doubles=await vi.hoisted(async()=>{
 const { EventEmitter:Emitter }=await import("node:events");
 const client=Object.assign(new Emitter(),{query:vi.fn<(sql:string,args?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>>(),release:vi.fn()});
 class Pool{connect=async()=>client;on=()=>{};end=async()=>{};}
 return{client,Pool};
});
vi.mock("pg-pool",()=>({default:doubles.Pool}));
import authority from "../../worker/shared-pool/authority-manifest.json";
import { createSharedSlotPool } from "../../worker/shared-pool/database";
import { sharedConfiguration,sharedSecrets } from "./shared-pool-fixture";
const config=sharedConfiguration(),slot=config.slots[0]!;
/** Driver lifecycle ports are inert. Actual restricted SQL tamper checks and
 * the native packet tests are separate; these rows are not runtime readiness. */
function harness(options:{rollbackFails?:boolean;tamper?:boolean;storageValid?:boolean}={}){
 let proofCalls=0;const calls:string[]=[];
 doubles.client.query.mockImplementation(async(sql,args=[])=>{
  calls.push(sql);
  if(sql==="ROLLBACK"){if(options.rollbackFails)throw Error("inert rollback failure");return{rows:[]};}
  if(sql==="BEGIN READ ONLY"||sql==="SET LOCAL search_path=''")return{rows:[]};
  if(sql.includes("session_user::text role_name"))return{rows:[{role_name:slot.roleName,active_role:slot.roleName,role_oid:slot.roleOid,rolcanlogin:true,rolconnlimit:4,
   rolsuper:false,rolinherit:false,rolcreaterole:false,rolcreatedb:false,rolbypassrls:false,rolreplication:false,unsafe_membership:false,owns_objects:false,schema_create:false,direct_access:false,private_usage:false}]};
  if(sql.includes("WITH shared_storage_required"))return{rows:[{valid:options.storageValid!==false}]};
  if(sql.includes("WITH expected AS")){
   const requested=JSON.parse(String(args[0])) as {schema_name:string;function_name:string;argument_types:string}[];
   return{rows:requested.map((expected,i)=>{const fn=authority.functions.find(f=>f.schema===expected.schema_name&&f.name===expected.function_name&&f.argumentTypes===expected.argument_types)!;
    return{...expected,procedure_oid:10000+i,body_sha256:options.tamper&&fn.schema==="fluid_private"?"f".repeat(64):fn.sha256,language:fn.language,volatility:fn.volatility,
     security_definer:fn.securityDefiner,leakproof:fn.leakproof,owner:fn.owner,search_path:fn.searchPath,broad_execute:fn.broadExecute,callable:fn.schema==="public"};})};
  }
  if(sql.includes("public.shared_worker_pool_configuration()")){proofCalls++;return{rows:[{configuration:{version:1,tenantScope:"per_lane",slotIds:config.slots.map(s=>s.slotId),globalConcurrency:3,maxPerTenantPerLane:1}}]};}
  throw Error("Unexpected inert query");
 });
 const pool=createSharedSlotPool(config,slot,sharedSecrets(config).slots[slot.slotId]!);
 return{pool,calls,get proofCalls(){return proofCalls;}};
}
beforeEach(()=>vi.clearAllMocks());
describe("shared preflight ordering and connection cleanup (inert driver)",()=>{
 it("performs one bounded catalog graph check before the first proof RPC and rolls back the local search path",async()=>{
  const f=harness();await f.pool.qualify();expect(f.proofCalls).toBe(1);expect(f.calls.filter(s=>s.includes("WITH expected AS"))).toHaveLength(1);
  expect(f.calls.indexOf("SET LOCAL search_path=''")).toBeLessThan(f.calls.findIndex(s=>s.includes("WITH expected AS")));
  expect(f.calls.at(-1)).toBe("ROLLBACK");expect(doubles.client.release).toHaveBeenCalledExactlyOnceWith(undefined);await f.pool.close();
 });
 it("never executes the proof RPC when a private source-owned helper changed",async()=>{
  const f=harness({tamper:true});await expect(f.pool.qualify()).rejects.toThrow("database");expect(f.proofCalls).toBe(0);expect(doubles.client.release).toHaveBeenCalledWith(expect.any(Error));await f.pool.close();
 });
 it("rejects missing or weakened Storage gates before any authority proof RPC",async()=>{
  const f=harness({storageValid:false});await expect(f.pool.qualify()).rejects.toThrow("database");expect(f.proofCalls).toBe(0);
  expect(f.calls.some(sql=>sql.includes("WITH expected AS"))).toBe(false);
  expect(f.calls.at(-1)).toBe("ROLLBACK");expect(doubles.client.release).toHaveBeenCalledWith(expect.any(Error));await f.pool.close();
 });
 it("does not report qualification success after rollback cleanup fails",async()=>{
  const f=harness({rollbackFails:true});await expect(f.pool.qualify()).rejects.toThrow("database");expect(doubles.client.release).toHaveBeenCalledWith(expect.any(Error));await f.pool.close();
 });
 it("contains a socket loss on a checked-out qualification client and permits fresh qualification",async()=>{
  const f=harness();let resume!:()=>void;
  doubles.client.query.mockImplementationOnce(()=>new Promise(resolve=>{resume=()=>resolve({rows:[]});}));
  const rejected=expect(f.pool.qualify()).rejects.toThrow("database");
  await vi.waitFor(()=>expect(resume).toBeTypeOf("function"));
  expect(()=>doubles.client.emit("error",Error("synthetic socket disconnect"))).not.toThrow();
  resume();await rejected;
  expect(doubles.client.release).toHaveBeenLastCalledWith(expect.any(Error));
  expect(doubles.client.listenerCount("error")).toBe(0);
  await f.pool.qualify();expect(doubles.client.release).toHaveBeenLastCalledWith(undefined);await f.pool.close();
 });
});
