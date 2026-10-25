import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
const mock=vi.hoisted(()=>({auth:vi.fn(),rpc:vi.fn(),from:vi.fn()}));
vi.mock("../../src/server/auth/context",()=>({getAuthenticatedContext:mock.auth}));
import { GET as feed } from "../../src/app/api/projects/[projectId]/naming/feed/route";
import { POST as ensure } from "../../src/app/api/projects/[projectId]/naming/feed/ensure/route";
import { POST as steering } from "../../src/app/api/projects/[projectId]/naming/steering/route";
import { POST as stopFeed } from "../../src/app/api/projects/[projectId]/naming/feed/stop/route";
import { DELETE as stop } from "../../src/app/api/projects/[projectId]/naming/runs/[runId]/route";
import { GET as genericJob, DELETE as genericCancel } from "../../src/app/api/jobs/[jobId]/route";
import { brainPreferences, initialIntent } from "../database/naming-brain-fixture";
import { ensureNextNamingRun } from "../../src/server/data/naming-brain";
const owner="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",project="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",run="11111111-1111-4111-8111-111111111111";
const emptyFeed={version:1,ownerId:owner,projectId:project,projectRevision:1,preferencesVersion:1,feedbackRevision:0,steeringRevision:0,demandSequence:0,entries:[],nextCursor:null,consumedThrough:null,activeRun:null,preparedSetId:null,paused:false,state:"active",availability:{status:"unavailable",code:"naming_runtime_unavailable"}};
const partialRun={version:1,ownerId:owner,projectId:project,runId:run,jobId:run,batchId:run,revision:1,resumedFromRunId:null,canResume:true,state:"partial",projectRevision:1,preferencesVersion:1,feedbackRevision:0,steeringRevision:0,demandSequence:0,snapshotHash:"a".repeat(64),acceptedPolicyIdentity:"a".repeat(64),progress:40,preparedSetId:null,fulfillment:{status:"none",targetCount:100,acceptedCount:0,missingCount:100,coverageSatisfied:false,message:"Synthetic retained partial exploration."},accounting:{status:"held_unsettled",heldAllowanceMicrousd:5000000,confirmedActualCostMicrousd:null},createdAt:"2026-10-18T05:00:00Z",updatedAt:"2026-10-18T05:01:00Z"};
const resumableFeed={...emptyFeed,activeRun:partialRun,availability:{status:"available",handlerVersion:"naming-brain-v1",protocol:"openai_agents",acceptedPolicyIdentity:"a".repeat(64)}};
function localRuntime(){for(const key of Object.keys(process.env))if(key==="VERCEL"||key.startsWith("VERCEL_"))vi.stubEnv(key,undefined);vi.stubEnv("NODE_ENV","production");vi.stubEnv("FLUID_RUNTIME","local");vi.stubEnv("FLUID_LOCAL_PROTOTYPE","true");vi.stubEnv("APP_ORIGIN","http://127.0.0.1:3106");}
function hostedRuntime(){vi.stubEnv("NODE_ENV","production");vi.stubEnv("FLUID_RUNTIME",undefined);vi.stubEnv("FLUID_LOCAL_PROTOTYPE",undefined);vi.stubEnv("FLUID_HOSTED_NAMING_ENABLED","true");vi.stubEnv("VERCEL","1");vi.stubEnv("VERCEL_ENV","production");vi.stubEnv("VERCEL_TARGET_ENV","production");vi.stubEnv("VERCEL_PROJECT_ID","prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt");vi.stubEnv("APP_ORIGIN","https://www.embel.xyz");}
const hostedAvailable={status:"available",executionAuthority:"hosted_owner_v1"};
const ctx={params:Promise.resolve({projectId:project,runId:run,jobId:run})};
const request=(body?:unknown,method="POST",headers:Record<string,string>={},query="")=>new Request(`https://embel.example/api/naming${query}`,{method,headers:{origin:"https://embel.example","content-type":"application/json","X-Embel-Account":owner,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
describe("Naming Brain route account and privacy boundaries",()=>{
 beforeEach(()=>{vi.resetAllMocks();vi.stubEnv("APP_ORIGIN","https://embel.example");mock.auth.mockResolvedValue({userId:owner,client:{rpc:mock.rpc,from:mock.from}});mock.rpc.mockResolvedValue({data:emptyFeed,error:null});mock.from.mockImplementation(()=>{const q={select:()=>q,eq:()=>q,in:()=>q,limit:async()=>({data:[],error:null}),maybeSingle:async()=>({data:{owner_id:owner,project_id:project,version:1,preferences:brainPreferences},error:null})};return q;});});afterEach(()=>vi.unstubAllEnvs());
 it("selects only the explicit local admission wrapper under the complete local boundary",async()=>{
  for(const key of Object.keys(process.env))if(key==="VERCEL"||key.startsWith("VERCEL_"))vi.stubEnv(key,undefined);
  vi.stubEnv("NODE_ENV","production");vi.stubEnv("FLUID_RUNTIME","local");vi.stubEnv("FLUID_LOCAL_PROTOTYPE","true");vi.stubEnv("APP_ORIGIN","http://127.0.0.1:3106");
  const blocked={status:"blocked",feed:emptyFeed,code:"naming_runtime_unavailable",message:"Naming is not configured.",action:"configure"};
  mock.rpc.mockResolvedValue({data:blocked,error:null});
  expect(await ensureNextNamingRun(await mock.auth(),project,initialIntent())).toEqual(blocked);
  expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("ensure_local_naming_brain_run",{p_project_id:project,p_intent:initialIntent()});
 });
 it("uses hosted admission and independently verifies the owned runtime capability",async()=>{
  hostedRuntime();const blocked={status:"blocked",feed:emptyFeed,code:"naming_runtime_unavailable",message:"Naming is not configured.",action:"configure"};
  mock.rpc.mockImplementation(async(name:string)=>({data:name==="get_hosted_naming_availability"?hostedAvailable:blocked,error:null}));
  expect(await ensureNextNamingRun(await mock.auth(),project,initialIntent())).toEqual(blocked);
  expect(mock.rpc.mock.calls.map(([name])=>name)).toEqual(["ensure_hosted_naming_brain_run","get_hosted_naming_availability"]);
  expect(mock.rpc).toHaveBeenCalledWith("get_hosted_naming_availability",{p_project_id:project});
 });
 it("accepts the canonical production mutation while retaining account and SQL authority",async()=>{
  hostedRuntime();const blocked={status:"blocked",feed:emptyFeed,code:"naming_runtime_unavailable",message:"Naming is not configured.",action:"configure"};
  mock.rpc.mockImplementation(async(name:string)=>({data:name==="get_hosted_naming_availability"?hostedAvailable:blocked,error:null}));
  const canonicalRequest=()=>new Request(`https://www.embel.xyz/api/projects/${project}/naming/feed/ensure`,{method:"POST",headers:{origin:"https://www.embel.xyz","content-type":"application/json","X-Embel-Account":owner},body:JSON.stringify(initialIntent())});
  const response=await ensure(canonicalRequest(),ctx);expect(response.status).toBe(200);expect(await response.json()).toEqual(blocked);
  expect(mock.rpc).toHaveBeenCalledWith("ensure_hosted_naming_brain_run",{p_project_id:project,p_intent:initialIntent()});
  expect(mock.rpc).toHaveBeenCalledWith("get_hosted_naming_availability",{p_project_id:project});
  mock.rpc.mockClear();const foreignAccount=canonicalRequest();foreignAccount.headers.set("X-Embel-Account",project);
  expect((await ensure(foreignAccount,ctx)).status).toBe(401);expect(mock.rpc).not.toHaveBeenCalled();
 });
 it.each(["https://fluid-platform-preview.vercel.app","https://embel.xyz","https://unrelated.example","https://www.embel.xyz/"])("rejects a noncanonical production mutation origin %s before admission",async origin=>{
  hostedRuntime();expect((await ensure(request(initialIntent(),"POST",{origin}),ctx)).status).toBe(403);
  expect(mock.rpc).not.toHaveBeenCalled();
 });
 it.each(["resume","prefetch"])("grants hosted %s only with a fresh database capability",async mode=>{
  hostedRuntime();const activeRun=mode==="resume"?partialRun:{...partialRun,state:"succeeded",canResume:false,preparedSetId:null,localPipelineVersion:2,progressiveCompletionId:run,fulfillment:{status:"complete",targetCount:100,acceptedCount:100,missingCount:0,coverageSatisfied:true,message:null}};
  mock.rpc.mockImplementation(async(name:string)=>({data:name==="get_hosted_naming_availability"?hostedAvailable:{...resumableFeed,activeRun},error:null}));
  const response=await feed(request(undefined,"GET"),ctx);expect(response.status).toBe(200);
  expect((await response.json()).feed[mode==="resume"?"canResumeOnScroll":"canPrefetchOnScroll"]).toBe(true);
 });
 it.each(["runtime_disabled","worker_unavailable"])("keeps saved results readable and removes hosted controls when %s",async reason=>{
  hostedRuntime();mock.rpc.mockImplementation(async(name:string)=>({data:name==="get_hosted_naming_availability"?{status:"unavailable",executionAuthority:"hosted_owner_v1",reason}:{...resumableFeed,canResumeOnScroll:true,canPrefetchOnScroll:true},error:null}));
  const response=await feed(request(undefined,"GET"),ctx);expect(response.status).toBe(200);const loaded=(await response.json()).feed;
  expect(loaded.availability.status).toBe("unavailable");expect(loaded.activeRun.runId).toBe(run);
  expect(loaded).not.toHaveProperty("canResumeOnScroll");expect(loaded).not.toHaveProperty("canPrefetchOnScroll");
 });
 it("does not grant hosted continuation from malformed capability data or a foreign feed",async()=>{
  hostedRuntime();mock.rpc.mockImplementation(async(name:string)=>({data:name==="get_hosted_naming_availability"?{status:"available"}:{...resumableFeed,canResumeOnScroll:true,canPrefetchOnScroll:true},error:null}));
  const response=await feed(request(undefined,"GET"),ctx);expect(response.status).toBe(200);
  const loaded=(await response.json()).feed;
  expect(loaded.activeRun).toEqual(partialRun);expect(loaded.entries).toEqual(resumableFeed.entries);
  expect(loaded.availability).toEqual({status:"unavailable",code:"naming_runtime_unavailable"});
  expect(loaded).not.toHaveProperty("canResumeOnScroll");expect(loaded).not.toHaveProperty("canPrefetchOnScroll");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mock.rpc.mock.calls.map(([name])=>name)).toEqual(["get_naming_feed","get_hosted_naming_availability"]);
  mock.rpc.mockClear();mock.rpc.mockResolvedValue({data:{...resumableFeed,ownerId:project},error:null});
  const foreign=await feed(request(undefined,"GET"),ctx);expect(foreign.status).toBe(404);
  expect(await foreign.json()).not.toHaveProperty("feed");
  expect(mock.rpc.mock.calls.map(([name])=>name)).toEqual(["get_naming_feed"]);
 });
 it("reads without admission and rejects non-owned cursors or unbounded query shape",async()=>{
  const response=await feed(request(undefined,"GET"),ctx);expect(response.status).toBe(200);expect(await response.json()).toEqual({feed:emptyFeed});expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await feed(request(undefined,"GET",{},"?limit=101"),ctx)).status).toBe(422);expect((await feed(request(undefined,"GET",{},"?cursorPosition=1"),ctx)).status).toBe(422);
 });
 it.each(["partial","failed"])("derives local scroll Resume only for acknowledged resumable %s work",async state=>{
  localRuntime();mock.rpc.mockResolvedValue({data:{...resumableFeed,activeRun:{...partialRun,state}},error:null});
  const response=await feed(request(undefined,"GET"),ctx);expect(response.status).toBe(200);expect((await response.json()).feed.canResumeOnScroll).toBe(true);
  const incomplete={status:"incomplete",feed:resumableFeed,run:partialRun,fulfillment:partialRun.fulfillment,message:"Synthetic retained partial exploration.",canResume:true};
  mock.rpc.mockResolvedValue({data:incomplete,error:null});
  expect((await ensureNextNamingRun(await mock.auth(),project,initialIntent())).feed.canResumeOnScroll).toBe(true);
 });
 it.each([false,true])("derives prefetch only from the genuine current complete membership (progressive=%s)",async progressive=>{
  localRuntime();
  const complete={...partialRun,state:"succeeded",canResume:false,preparedSetId:progressive?null:run,...(progressive?{localPipelineVersion:2,progressiveCompletionId:run}:{}),fulfillment:{status:"complete",targetCount:100,acceptedCount:100,missingCount:0,coverageSatisfied:true,message:null}};
  mock.rpc.mockResolvedValue({data:{...resumableFeed,activeRun:complete},error:null});
  const response=await feed(request(undefined,"GET"),ctx);expect(response.status).toBe(200);expect((await response.json()).feed.canPrefetchOnScroll).toBe(true);
 });
 it.each(["hosted","paused","stale","unknown","stopped100"])("strips an asserted prefetch capability for %s",async label=>{
  if(label!=="hosted")localRuntime();
  const complete={...partialRun,state:label==="unknown"?"needs_reconciliation":label==="stopped100"?"partial":"succeeded",canResume:label==="stopped100",preparedSetId:null,localPipelineVersion:2,...(label==="stopped100"?{}:{progressiveCompletionId:run}),fulfillment:{status:"complete",targetCount:100,acceptedCount:100,missingCount:0,coverageSatisfied:true,message:null}};
  mock.rpc.mockResolvedValue({data:{...resumableFeed,...(label==="paused"?{paused:true,state:"paused"}:{}),...(label==="stale"?{projectRevision:2}:{}),activeRun:complete,canPrefetchOnScroll:true,canResumeOnScroll:true},error:null});
  const response=await feed(request(undefined,"GET"),ctx);expect(response.status).toBe(200);const loaded=(await response.json()).feed;
  expect(loaded).not.toHaveProperty("canPrefetchOnScroll");expect(loaded).not.toHaveProperty("canResumeOnScroll");
 });
 it.each([
  ["hosted",{}], ["paused",{paused:true,state:"paused"}], ["blocked",{state:"blocked"}],
  ["unavailable",{availability:emptyFeed.availability}], ["cancelled",{activeRun:{...partialRun,state:"cancelled"}}],
  ["unknown",{activeRun:{...partialRun,state:"needs_reconciliation",canResume:false}}], ["not_resumable",{activeRun:{...partialRun,canResume:false}}],
  ["stale_context",{projectRevision:2}], ["stale_preferences",{preferencesVersion:2}], ["stale_steering",{steeringRevision:1}],
 ])("strips a supplied scroll capability for %s instead of trusting stored JSON",async(label,patch)=>{
  if(label!=="hosted")localRuntime();
  mock.rpc.mockResolvedValue({data:{...resumableFeed,...patch,canResumeOnScroll:true},error:null});
  const response=await feed(request(undefined,"GET"),ctx);expect(response.status).toBe(200);expect((await response.json()).feed).not.toHaveProperty("canResumeOnScroll");
 });
 it("requires the captured account and origin on every new mutation",async()=>{
  for(const handler of [ensure,steering,stop,stopFeed]){
   expect((await handler(request(initialIntent(),"POST",{"X-Embel-Account":project}),ctx)).status).toBe(401);
   expect((await handler(request(initialIntent(),"POST",{origin:"https://foreign.example"}),ctx)).status).toBe(403);
  }expect(mock.rpc).not.toHaveBeenCalled();
 });
 it("does not permit provider/owner/allowance injection and preserves a blocked response",async()=>{
  for(const extra of [{ownerId:owner},{policy:{}},{output:{}},{maximumCostMicrousd:0}])expect((await ensure(request({...initialIntent(),...extra}),ctx)).status).toBe(422);
  mock.rpc.mockResolvedValue({data:{status:"blocked",feed:emptyFeed,code:"naming_runtime_unavailable",message:"Naming is not configured.",action:"configure"},error:null});
  const result=await ensure(request(initialIntent()),ctx);expect(result.status).toBe(200);expect((await result.json()).status).toBe("blocked");
 });
 it("returns actionable bad-draft readiness without calling paid admission",async()=>{
  mock.from.mockImplementation(()=>{const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{owner_id:owner,project_id:project,version:1,preferences:{...brainPreferences,requiredText:["cedar"],excludedText:["cedar"]}},error:null})};return q;});
  const response=await ensure(request(initialIntent()),ctx);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({status:"blocked",code:"preferences_incomplete",action:"review_preferences"});
  expect(mock.rpc.mock.calls.some(([name])=>name==="ensure_naming_brain_run")).toBe(false);
 });
 it("passes the exact durable Stop intent and rejects a missing pending-ensure binding field",async()=>{
  const intent={version:1,expectedDemandSequence:0,pendingEnsureIdempotencyKey:"fixture-lost-ensure-ack",idempotencyKey:"fixture-durable-stop-key"};
  mock.rpc.mockResolvedValue({data:{feed:{...emptyFeed,state:"paused",paused:true,demandSequence:1}},error:null});
  expect((await stopFeed(request(intent),ctx)).status).toBe(200);
  expect(mock.rpc).toHaveBeenCalledWith("stop_naming_feed",{p_project_id:project,p_intent:intent});
  const missing={...intent};delete (missing as Partial<typeof intent>).pendingEnsureIdempotencyKey;
  expect((await stopFeed(request(missing),ctx)).status).toBe(422);
 });
 it("fails closed if managed cancellation lacks its accounting projection",async()=>{
  mock.rpc.mockImplementation(async(name:string)=>name==="request_job_cancel"?{data:{id:run,operation:"naming.generate",billing_mode:"openai_api",version:2,actual_cost_microusd:0},error:null}:{data:null,error:null});
  const response=await genericCancel(request(undefined,"DELETE"),ctx);expect(response.status).toBe(503);expect(await response.json()).not.toHaveProperty("job");
 });
 it("replaces the generic managed numeric subtotal with nullable confirmed accounting",async()=>{
  const row={id:run,project_id:project,operation:"naming.generate",billing_mode:"openai_api",input_revision:1,state:"succeeded",progress:100,reserved_cost_microusd:5000000,actual_cost_microusd:0,error_code:null,created_at:"2026-10-16T12:00:00Z",finished_at:"2026-10-16T12:01:00Z"};
  mock.from.mockImplementation(()=>{const q={select:()=>q,eq:()=>q,single:async()=>({data:row,error:null})};return q;});
  mock.rpc.mockResolvedValue({data:{status:"held_unsettled",heldAllowanceMicrousd:5000000,confirmedActualCostMicrousd:null},error:null});
  const response=await genericJob(request(undefined,"GET"),ctx);expect(response.status).toBe(200);const body=await response.json();expect(body.job).not.toHaveProperty("actual_cost_microusd");expect(body.job.accounting.confirmedActualCostMicrousd).toBeNull();
 });
});
