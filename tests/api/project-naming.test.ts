import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({auth:vi.fn(),rpc:vi.fn(),from:vi.fn()}));
vi.mock("../../src/server/auth/context",()=>({getAuthenticatedContext:mocks.auth}));
import { GET as overview,POST as enqueueAlias } from "../../src/app/api/projects/[projectId]/naming/route";
import { GET as batches,POST as enqueue } from "../../src/app/api/projects/[projectId]/naming/batches/route";
import { GET as detail,DELETE as cancel } from "../../src/app/api/projects/[projectId]/naming/batches/[batchId]/route";
import { PATCH as preferencesRoute } from "../../src/app/api/projects/[projectId]/naming/preferences/route";
import { PATCH as viewRoute } from "../../src/app/api/projects/[projectId]/naming/view/route";
import { PATCH as retention } from "../../src/app/api/projects/[projectId]/naming/retention/route";
import { POST as selection } from "../../src/app/api/projects/[projectId]/naming/selection/route";
import { POST as transform } from "../../src/app/api/projects/[projectId]/naming/transforms/route";
import { POST as importRoute } from "../../src/app/api/projects/[projectId]/naming/imports/route";
import { GET as customNames } from "../../src/app/api/projects/[projectId]/naming/custom/route";
import { POST as promote } from "../../src/app/api/projects/[projectId]/naming/promote/route";
import { GET as library } from "../../src/app/api/names/route";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { getNamingReadiness,namingStrategyBasis } from "../../src/domain/project-naming";
import { ApiError } from "../../src/server/http/errors";
const owner="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",other="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",project="11111111-1111-4111-8111-111111111111",candidate="22222222-2222-4222-8222-222222222222",batch="33333333-3333-4333-8333-333333333333",job="44444444-4444-4444-8444-444444444444";
const at="2026-10-04T12:00:00Z";const context=contextSnapshotSchema.parse({description:"Local API naming fixture"});
const preferences={version:1,creativeLocale:"en",notes:"",minimumGraphemes:null,maximumGraphemes:null};
const viewState={pane:"results",conversationOpen:false,filter:"all",query:"",visibleBatchId:null,scrollCandidateId:null,workshopCandidateId:null};
const session={ownerId:owner,projectId:project,revision:2,currentPreferencesVersion:1,latestBatchSequence:1,currentSelectionId:null,viewRevision:1,viewState,createdAt:at,updatedAt:at};
const enqueueInput={expectedProjectRevision:1,expectedPreferencesVersion:1,expectedBatchSequence:0,idempotencyKey:"fixture-api-naming-intent",billingMode:"chatgpt_subscription",acceptedPolicyIdentity:"a".repeat(64)};
const batchRecord={id:batch,ownerId:owner,projectId:project,contextRevision:1,strategyBasis:namingStrategyBasis(context),preferencesVersion:1,preferences,favoritesSnapshot:[],acceptedPolicyIdentity:"a".repeat(64),targetCount:100,sequence:1,jobId:job,createdAt:at};
const jobRecord={id:job,owner_id:owner,project_id:project,operation:"naming.generate",input_revision:1,state:"queued",progress:0,error_code:null,cancel_requested_at:null,created_at:at,finished_at:null,billingMode:"chatgpt_subscription",policyIdentity:"a".repeat(64),batchId:batch,sequence:1,targetCount:100,results:[]};
const source={id:candidate,value:"Cedar",createdAt:at,origin:"manual",history:[]};
const baseOverview={project:{id:project,owner_id:owner,title:"Local fixture",scope:"complete_brand",current_revision:1,created_at:at,context},readiness:getNamingReadiness(context,"complete_brand"),session:null,preferences:null,currentSelection:null,batches:{ownerId:owner,projectId:project,items:[],nextCursor:null},candidates:{ownerId:owner,projectId:project,items:[],nextCursor:null},availability:{status:"unavailable",operation:"naming.generate",reason:"naming_policy_unavailable"},jobs:[],screening:{domains:{status:"not_checked",reason:"integration_unavailable"},handles:{status:"not_checked",reason:"integration_unavailable"},trademarks:{status:"not_checked",reason:"integration_unavailable"}}};
const params=(projectId=project,batchId=batch)=>({params:Promise.resolve({projectId,batchId})});
function request(body?:unknown,method="POST",headers:Record<string,string>={},query=""){
 return new Request(`https://fluid.example/api/projects/${project}/naming${query}`,{method,headers:{origin:"https://fluid.example","content-type":"application/json",...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
const mutations=[
 ["preferences",preferencesRoute,{expectedPreferencesVersion:0,preferences}],
 ["view",viewRoute,{expectedViewRevision:1,viewState}],
 ["retention",retention,{candidateId:candidate,expectedRevision:0,favorite:true,saved:false}],
 ["selection",selection,{candidateId:candidate,expectedRevision:1,acceptEarlierContext:false}],
 ["transform",transform,{parentCandidateId:candidate,input:{kind:"tweaks",seed:"Cedar",operations:["uppercase"]},idempotencyKey:"fixture-api-transform001"}],
 ["import",importRoute,{expectedProjectRevision:1,source,capturedContext:context,idempotencyKey:"fixture-api-import00001"}],
 ["promotion",promote,{sourceProjectId:project,sourceCandidateId:candidate,expectedSourceProjectRevision:1,title:"Local brand",idempotencyKey:"fixture-api-promote0001"}],
 ["batch",enqueue,enqueueInput],
] as const;

describe("Naming API authentication, owner validation and actual byte bounds",()=>{
 beforeEach(()=>{vi.resetAllMocks();vi.stubEnv("APP_ORIGIN","https://fluid.example");mocks.auth.mockResolvedValue({userId:owner,client:{rpc:mocks.rpc,from:mocks.from}});
  mocks.from.mockImplementation(()=>{const q={select:()=>q,eq:()=>q,order:()=>q,limit:()=>Promise.resolve({data:[],error:null})};return q;});
  mocks.rpc.mockImplementation(async(name:string)=>({error:null,data:name==="get_project_naming"?baseOverview:name==="get_naming_batches"?baseOverview.batches:name==="get_account_names"?{ownerId:owner,items:[],nextCursor:null}:name==="enqueue_subscription_naming_job"?{batch:batchRecord,job:jobRecord,session}:name==="get_naming_batch"?{batch:batchRecord,job:jobRecord,result:null}:null}));});
 afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
 it("reads custom names privately through existing owner-filtered tables and rejects invalid cursors",async()=>{
  const eq=vi.fn();mocks.from.mockImplementation((table:string)=>{const q={select:()=>q,eq:(...args:unknown[])=>{eq(...args);return q;},order:()=>q,maybeSingle:async()=>({data:{id:project,owner_id:owner},error:null}),limit:async()=>({data:[],error:null})};expect(["projects","name_candidates"]).toContain(table);return q;});
  const response=await customNames(request(undefined,"GET"),params());expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ownerId:owner,projectId:project,items:[],nextCursor:null});
  expect(response.headers.get("cache-control")).toBe("private, no-store");expect(response.headers.get("vary")).toBe("Cookie");
  expect(eq).toHaveBeenCalledWith("owner_id",owner);expect(eq).toHaveBeenCalledWith("project_id",project);expect(eq).toHaveBeenCalledWith("origin->>kind","local_import");
  expect((await customNames(request(undefined,"GET",{},"?cursorId=invalid&cursorCreatedAt=bad"),params())).status).toBe(422);
  expect((await customNames(request(undefined,"GET",{},"?filter=all"),params())).status).toBe(422);
  expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it("returns no custom rows for a project outside the verified account",async()=>{
  mocks.from.mockImplementation(()=>{const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:null,error:null})};return q;});
  const response=await customNames(request(undefined,"GET"),params());expect(response.status).toBe(404);expect(mocks.from).toHaveBeenCalledTimes(1);
 });
 it("enqueues one durable intent with exact server-derived arguments and private responses",async()=>{
  const response=await enqueue(request(enqueueInput),params());expect(response.status).toBe(202);expect((await response.json()).batch.id).toBe(batch);
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("enqueue_subscription_naming_job",{p_project_id:project,p_expected_project_revision:1,p_expected_preferences_version:1,p_expected_batch_sequence:0,p_idempotency_key:enqueueInput.idempotencyKey,p_accepted_policy_identity:enqueueInput.acceptedPolicyIdentity});
  expect(response.headers.get("cache-control")).toBe("private, no-store");expect(response.headers.get("vary")).toBe("Cookie");
  expect((await enqueueAlias(request(enqueueInput),params())).status).toBe(202);
 });
 it("reads owner-bound overview, batch pages and account library with bounded queries",async()=>{
  expect((await overview(request(undefined,"GET"),params())).status).toBe(200);expect(mocks.rpc).toHaveBeenCalledWith("get_project_naming",{p_project_id:project,p_query:{}});
  expect((await batches(request(undefined,"GET",{},"?limit=100"),params())).status).toBe(200);
  expect((await library(request(undefined,"GET",{},"?filter=retained&limit=50"))).status).toBe(200);
  expect((await overview(request(undefined,"GET",{},"?limit=101"),params())).status).toBe(422);
  expect((await overview(request(undefined,"GET",{},"?ownerId=forged"),params())).status).toBe(422);
  expect((await overview(request(undefined,"GET",{},"?cursorId="+candidate),params())).status).toBe(422);
  expect((await overview(request(undefined,"GET",{},"?limit=1&limit=2"),params())).status).toBe(422);
 });
 it.each(mutations)("rejects %s owner/model/output injection before persistence",async(_name,handler,body)=>{
  for(const extra of [{ownerId:other},{model:"unapproved"},{output:{value:"forged"}},{origin:{kind:"generated"}}]){
   expect((await handler(request({...body,...extra}),params())).status).toBe(422);
  }expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it.each(mutations)("requires same-origin and verified auth for %s",async(_name,handler,body)=>{
  expect((await handler(request(body,"POST",{origin:"https://foreign.example"}),params())).status).toBe(403);expect(mocks.auth).not.toHaveBeenCalled();
  mocks.auth.mockRejectedValueOnce(new ApiError("unauthenticated"));expect((await handler(request(body),params())).status).toBe(401);expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it.each([["P0002",404],["PT409",409],["23505",409],["40001",409],["22023",422],["P0001",503],["08006",503]] as const)("maps database %s to safe %i",async(code,status)=>{
  mocks.rpc.mockResolvedValue({data:null,error:{code,message:"private-provider-database-information"}});const response=await enqueue(request(enqueueInput),params());expect(response.status).toBe(status);expect(await response.text()).not.toContain("private-provider");
 });
 it("enforces streamed UTF-8 bytes despite a false Content-Length",async()=>{
  const body=new TextEncoder().encode(JSON.stringify({...enqueueInput,extra:"é".repeat(1200)}));
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(body.slice(0,10));controller.enqueue(body.slice(10));controller.close();}});
  const streamed=new Request("https://fluid.example/api/naming",{method:"POST",headers:{origin:"https://fluid.example","content-type":"application/json","content-length":"1"},body:stream,duplex:"half"} as RequestInit&{duplex:"half"});
  expect((await enqueue(streamed,params())).status).toBe(413);expect(mocks.rpc).not.toHaveBeenCalled();
  expect((await preferencesRoute(request({expectedPreferencesVersion:0,preferences:{...preferences,notes:"🚀".repeat(9000)}}),params())).status).toBe(413);
  expect((await enqueue(request(enqueueInput,"POST",{"content-type":"text/plain"}),params())).status).toBe(422);
 });
 it("rejects untrusted generated import and malformed workshop history before RPC",async()=>{
  expect((await importRoute(request({expectedProjectRevision:1,source:{...source,origin:"generated"},capturedContext:context,idempotencyKey:"fixture-api-forgedimport"}),params())).status).toBe(422);
  expect((await importRoute(request({expectedProjectRevision:1,source:{...source,origin:"workshop",history:[{id:candidate,input:{kind:"tweaks",seed:"Cedar",operations:["uppercase"]},output:"Cedar",createdAt:at}]},capturedContext:context,idempotencyKey:"fixture-api-forgedhistory"}),params())).status).toBe(422);expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it("verifies cancellation's project-batch binding before invoking durable cancellation",async()=>{
  expect((await detail(request(undefined,"GET"),params())).status).toBe(200);
  expect((await cancel(request(undefined,"DELETE"),params())).status).toBe(200);expect(mocks.rpc).toHaveBeenCalledWith("request_job_cancel",{p_job_id:job});
  mocks.rpc.mockClear();mocks.rpc.mockResolvedValue({data:{batch:{...batchRecord,projectId:other},job:{...jobRecord,project_id:other},result:null},error:null});
  expect((await cancel(request(undefined,"DELETE"),params())).status).toBe(404);expect(mocks.rpc).not.toHaveBeenCalledWith("request_job_cancel",expect.anything());
  expect((await cancel(request(undefined,"DELETE",{origin:"null"}),params())).status).toBe(403);
 });
 it("rejects foreign nested ownership, mismatched path binding and malformed stored DTOs",async()=>{
  mocks.rpc.mockResolvedValueOnce({data:{...baseOverview,candidates:{...baseOverview.candidates,ownerId:other}},error:null});expect((await overview(request(undefined,"GET"),params())).status).toBe(404);
  mocks.rpc.mockResolvedValueOnce({data:{batch:{...batchRecord,projectId:other},job:{...jobRecord,project_id:other},session:{...session,projectId:other}},error:null});expect((await enqueue(request(enqueueInput),params())).status).toBe(404);
  mocks.rpc.mockResolvedValueOnce({data:{batch:batchRecord,job:{...jobRecord,input_revision:2},session},error:null});expect((await enqueue(request(enqueueInput),params())).status).toBe(503);
  expect((await overview(request(undefined,"GET"),params("not-uuid"))).status).toBe(404);
 });
 it("returns appended preferences and rejects a forged response version",async()=>{
  mocks.rpc.mockResolvedValue({data:{session:{...session,currentPreferencesVersion:1,latestBatchSequence:0},preferences:{ownerId:owner,projectId:project,version:1,preferences,createdAt:at}},error:null});
  expect((await preferencesRoute(request({expectedPreferencesVersion:0,preferences}),params())).status).toBe(200);
  mocks.rpc.mockResolvedValue({data:{session:{...session,currentPreferencesVersion:2,latestBatchSequence:0},preferences:{ownerId:owner,projectId:project,version:2,preferences,createdAt:at}},error:null});
  expect((await preferencesRoute(request({expectedPreferencesVersion:0,preferences}),params())).status).toBe(503);
 });
 it("returns an explicit safe capacity error instead of a generic retry response",async()=>{
  mocks.rpc.mockResolvedValue({data:null,error:{code:"PT409",message:"naming_history_capacity"}});
  const response=await enqueue(request(enqueueInput),params());expect(response.status).toBe(409);expect(await response.json()).toEqual({error:{code:"naming_history_capacity",message:"This project's naming history has reached the generation limit. Your saved names are preserved."}});
 });
 it("accepts bounded durable answer checkpoints beyond the earlier small view-body limit",async()=>{
  const namingChat={version:1,preferencesVersion:1,confirmed:{language:'"en"',length:"[null,null]",fragments:JSON.stringify([Array.from({length:20},(_,i)=>`${i}${"x".repeat(155)}`),[]])}};
  const nextView={...viewState,namingChat};
  mocks.rpc.mockResolvedValue({data:{session:{...session,viewRevision:2,viewState:nextView}},error:null});
  const response=await viewRoute(request({expectedViewRevision:1,viewState:nextView},"PATCH"),params());
  expect(response.status).toBe(200);expect((await response.json()).session.viewState.namingChat).toEqual(namingChat);
  expect(mocks.rpc).toHaveBeenCalledWith("save_naming_view",{p_project_id:project,p_expected_revision:1,p_view:nextView});
  mocks.rpc.mockClear();
  expect((await viewRoute(request({expectedViewRevision:1,viewState:{...nextView,query:"x".repeat(32769)}},"PATCH"),params())).status).toBe(413);
  expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it("accepts preserved checkpoint metadata for an older view body but verifies all requested view fields",async()=>{
  const namingChat={version:1,preferencesVersion:1,confirmed:{language:'"en"'}};
  mocks.rpc.mockResolvedValue({data:{session:{...session,viewRevision:2,viewState:{...viewState,namingChat}}},error:null});
  expect((await viewRoute(request({expectedViewRevision:1,viewState},"PATCH"),params())).status).toBe(200);
  mocks.rpc.mockResolvedValue({data:{session:{...session,viewRevision:2,viewState:{...viewState,namingChat,query:"Unexpected change"}}},error:null});
  expect((await viewRoute(request({expectedViewRevision:1,viewState},"PATCH"),params())).status).toBe(503);
 });

});
