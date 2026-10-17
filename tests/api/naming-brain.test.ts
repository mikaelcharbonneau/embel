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
const owner="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",project="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",run="11111111-1111-4111-8111-111111111111";
const emptyFeed={version:1,ownerId:owner,projectId:project,projectRevision:1,preferencesVersion:1,feedbackRevision:0,steeringRevision:0,demandSequence:0,entries:[],nextCursor:null,consumedThrough:null,activeRun:null,preparedSetId:null,paused:false,state:"active",availability:{status:"unavailable",code:"naming_runtime_unavailable"}};
const ctx={params:Promise.resolve({projectId:project,runId:run,jobId:run})};
const request=(body?:unknown,method="POST",headers:Record<string,string>={},query="")=>new Request(`https://embel.example/api/naming${query}`,{method,headers:{origin:"https://embel.example","content-type":"application/json","X-Embel-Account":owner,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
describe("Naming Brain route account and privacy boundaries",()=>{
 beforeEach(()=>{vi.resetAllMocks();vi.stubEnv("APP_ORIGIN","https://embel.example");mock.auth.mockResolvedValue({userId:owner,client:{rpc:mock.rpc,from:mock.from}});mock.rpc.mockResolvedValue({data:emptyFeed,error:null});mock.from.mockImplementation(()=>{const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{owner_id:owner,project_id:project,version:1,preferences:brainPreferences},error:null})};return q;});});afterEach(()=>vi.unstubAllEnvs());
 it("reads without admission and rejects non-owned cursors or unbounded query shape",async()=>{
  const response=await feed(request(undefined,"GET"),ctx);expect(response.status).toBe(200);expect(await response.json()).toEqual({feed:emptyFeed});expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await feed(request(undefined,"GET",{},"?limit=101"),ctx)).status).toBe(422);expect((await feed(request(undefined,"GET",{},"?cursorPosition=1"),ctx)).status).toBe(422);
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
