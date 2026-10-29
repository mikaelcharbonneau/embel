import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { createSharedStrategyQueue } from "../../worker/shared-pool/queue";
import { classifySharedQueueFailure, reportSharedQueueFailure } from "../../worker/shared-pool/queue-diagnostics";
const config={region:"iad1" as const,topic:"embel-oidc-fixture",consumerGroup:"embel-oidc-fixture-group",deploymentId:"dpl_synthetic_oidc_fixture",visibilityTimeoutSeconds:60,handlerDeadlineMs:1000,emptyPollMs:100,errorPollMs:100,concurrency:1};
const roots:string[]=[];
const syntheticToken=(generation:number)=>[Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url"),Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000),sub:"synthetic-never-live",generation})).toString("base64url"),"synthetic-inert-signature"].join(".");
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"embel-queue-oidc-"));roots.push(root);const path=join(root,"token");
 vi.stubEnv("NODE_ENV","production");vi.stubEnv("VERCEL_OIDC_TOKEN_FILE",path);vi.stubEnv("VERCEL_OIDC_TOKEN",undefined);
 vi.stubEnv("VERCEL_QUEUE_TOKEN",undefined);vi.stubEnv("VERCEL_QUEUE_BASE_URL",undefined);
 const seen:Array<{token:string|null;deployment:string|null;path:string}>=[];
 vi.stubGlobal("fetch",vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=new URL(input instanceof Request?input.url:input);expect(url.origin).toBe("https://iad1.vercel-queue.com");
  const headers=new Headers(init?.headers);seen.push({token:headers.get("authorization"),deployment:headers.get("Vqs-Deployment-Id"),path:url.pathname});
  return url.pathname.includes("/consumer/")?new Response(null,{status:204}):Response.json({messageId:"msg_inert_fixture"});
 }));
 return{path,seen,queue:createSharedStrategyQueue(config)};
}
afterEach(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();for(const p of roots.splice(0))await rm(p,{recursive:true,force:true});});
describe("actual Queue SDK with per-instance Daemon file tokens (no network)",()=>{
 it("resolves Queue's OIDC import to the pinned root4 package",async()=>{
  const require=createRequire(import.meta.url),queueRequire=createRequire(require.resolve("@vercel/queue"));
  const entry=queueRequire.resolve("@vercel/oidc"),pkg=JSON.parse(await readFile(join(dirname(entry),"../package.json"),"utf8"));
  expect(pkg.version).toBe("4.0.0");expect(entry.includes("@vercel/queue/node_modules/@vercel/oidc")).toBe(false);
 });
 it("uses file tokens without an explicit token and reads atomic rotation for send and receive",async()=>{
  const f=await fixture(),first=syntheticToken(1),second=syntheticToken(2),third=syntheticToken(3);
  await writeFile(f.path,first,{mode:0o600});await f.queue.send(config.topic,{fixture:true});
  await writeFile(f.path+".next",second,{mode:0o600});await rename(f.path+".next",f.path);await f.queue.send(config.topic,{fixture:true});
  await writeFile(f.path+".next",third,{mode:0o600});await rename(f.path+".next",f.path);const handler=vi.fn();
  await f.queue.receive(config.topic,config.consumerGroup,handler,{limit:1});
  expect(f.seen.map((r,i)=>r.token==="Bearer "+[first,second,third][i])).toEqual([true,true,true]);
  expect(f.seen.every(r=>r.deployment===config.deploymentId)).toBe(true);expect(handler).not.toHaveBeenCalled();
 });
 it("prefers a current file over a stale injected environment token",async()=>{
  const f=await fixture();vi.stubEnv("VERCEL_OIDC_TOKEN",syntheticToken(0));const current=syntheticToken(4);await writeFile(f.path,current,{mode:0o600});
  await f.queue.send(config.topic,{fixture:true});expect(f.seen.length).toBe(1);expect(f.seen[0]!.token==="Bearer "+current).toBe(true);
 });
 it.each(["missing","empty"])("fails closed for a %s file instead of falling back or claiming broker success",async mode=>{
  const f=await fixture();vi.stubEnv("VERCEL_OIDC_TOKEN",syntheticToken(0));if(mode==="empty")await writeFile(f.path,"",{mode:0o600});
  await expect(f.queue.send(config.topic,{fixture:true})).rejects.toBeInstanceOf(Error);expect(f.seen).toHaveLength(0);
 });
});
describe("closed Queue failure diagnostics",()=>{
 it("emits only fixed classifications, rate-limited, without raw sentinel content",()=>{
  const spy=vi.spyOn(console,"warn").mockImplementation(()=>{}),error=new Error("Failed to get OIDC token: token-secret-sentinel postgres://private.invalid");
  reportSharedQueueFailure("queue_send",error);reportSharedQueueFailure("queue_send",error);
  expect(spy).toHaveBeenCalledTimes(1);const output=String(spy.mock.calls[0]![0]);
  expect(JSON.parse(output)).toEqual({event:"shared_strategy_delivery_unavailable",phase:"queue_send",reason:"oidc_unavailable"});
  expect(output.includes("sentinel")||output.includes("postgres://")).toBe(false);
 });
 it("does not emit unknown SDK/SQL fields or arbitrary messages",()=>{
  expect(classifySharedQueueFailure(new Error("secret-sentinel"))).toBe("unclassified");
  expect(classifySharedQueueFailure(Object.assign(new Error("secret-sentinel"),{code:"42501",detail:"secret"}))).toBe("database_guard_refused");
  class ForbiddenError extends Error{};expect(classifySharedQueueFailure(new ForbiddenError("secret-sentinel"))).toBe("queue_forbidden");
  expect(classifySharedQueueFailure({token:"secret-sentinel"})).toBe("unclassified");
 });
});
