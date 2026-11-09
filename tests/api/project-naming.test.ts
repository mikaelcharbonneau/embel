import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({auth:vi.fn(),rpc:vi.fn(),from:vi.fn()}));
vi.mock("../../src/server/auth/context",()=>({getAuthenticatedContext:mocks.auth}));
import { GET as overview } from "../../src/app/api/projects/[projectId]/naming/route";
import { PATCH as preferencesRoute } from "../../src/app/api/projects/[projectId]/naming/preferences/route";
import { PATCH as viewRoute } from "../../src/app/api/projects/[projectId]/naming/view/route";
import { PATCH as retention } from "../../src/app/api/projects/[projectId]/naming/retention/route";
import { POST as selection } from "../../src/app/api/projects/[projectId]/naming/selection/route";
import { POST as importRoute } from "../../src/app/api/projects/[projectId]/naming/imports/route";
import { GET as customNames } from "../../src/app/api/projects/[projectId]/naming/custom/route";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { getNamingReadiness } from "../../src/domain/project-naming";
import { ApiError } from "../../src/server/http/errors";
const owner="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",other="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",project="11111111-1111-4111-8111-111111111111",candidate="22222222-2222-4222-8222-222222222222",batch="33333333-3333-4333-8333-333333333333";
const at="2026-10-04T12:00:00Z";const context=contextSnapshotSchema.parse({description:"Local API naming fixture"});
const preferences={version:1,creativeLocale:"en",notes:"",minimumGraphemes:null,maximumGraphemes:null};
const viewState={pane:"results",conversationOpen:false,filter:"all",query:"",visibleBatchId:null,scrollCandidateId:null,workshopCandidateId:null};
const session={ownerId:owner,projectId:project,revision:2,currentPreferencesVersion:1,latestBatchSequence:1,currentSelectionId:null,viewRevision:1,viewState,createdAt:at,updatedAt:at};
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
 ["import",importRoute,{expectedProjectRevision:1,source,capturedContext:context,idempotencyKey:"fixture-api-import00001"}],
] as const;

describe("Naming API authentication, owner validation and actual byte bounds",()=>{
 beforeEach(()=>{vi.resetAllMocks();vi.stubEnv("APP_ORIGIN","https://fluid.example");mocks.auth.mockResolvedValue({userId:owner,client:{rpc:mocks.rpc,from:mocks.from}});
  mocks.from.mockImplementation(()=>{const q={select:()=>q,eq:()=>q,order:()=>q,limit:()=>Promise.resolve({data:[],error:null})};return q;});
  mocks.rpc.mockImplementation(async(name:string)=>({error:null,data:name==="get_project_naming"?baseOverview:null}));});
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
 it("reads owner-bound overview and batch pages with bounded queries",async()=>{
  expect((await overview(request(undefined,"GET"),params())).status).toBe(200);expect(mocks.rpc).toHaveBeenCalledWith("get_project_naming",{p_project_id:project,p_query:{}});
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
  mocks.rpc.mockResolvedValue({data:null,error:{code,message:"private-provider-database-information"}});const response=await selection(request({candidateId:candidate,expectedRevision:1,acceptEarlierContext:false}),params());expect(response.status).toBe(status);expect(await response.text()).not.toContain("private-provider");
 });
 it("enforces streamed UTF-8 bytes despite a false Content-Length",async()=>{
  const body=new TextEncoder().encode(JSON.stringify({expectedProjectRevision:1,source,capturedContext:context,idempotencyKey:"fixture-api-import00001",extra:"é".repeat(17000)}));
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(body.slice(0,10));controller.enqueue(body.slice(10));controller.close();}});
  const streamed=new Request("https://fluid.example/api/naming",{method:"POST",headers:{origin:"https://fluid.example","content-type":"application/json","content-length":"1"},body:stream,duplex:"half"} as RequestInit&{duplex:"half"});
  expect((await importRoute(streamed,params())).status).toBe(413);expect(mocks.rpc).not.toHaveBeenCalled();
  expect((await preferencesRoute(request({expectedPreferencesVersion:0,preferences:{...preferences,notes:"🚀".repeat(9000)}}),params())).status).toBe(413);
  expect((await importRoute(request({expectedProjectRevision:1,source,capturedContext:context,idempotencyKey:"fixture-api-import00001"},"POST",{"content-type":"text/plain"}),params())).status).toBe(422);
 });
 it("rejects untrusted generated import and malformed workshop history before RPC",async()=>{
  expect((await importRoute(request({expectedProjectRevision:1,source:{...source,origin:"generated"},capturedContext:context,idempotencyKey:"fixture-api-forgedimport"}),params())).status).toBe(422);
  expect((await importRoute(request({expectedProjectRevision:1,source:{...source,origin:"workshop",history:[{id:candidate,input:{kind:"tweaks",seed:"Cedar",operations:["uppercase"]},output:"Cedar",createdAt:at}]},capturedContext:context,idempotencyKey:"fixture-api-forgedhistory"}),params())).status).toBe(422);expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it("rejects foreign nested ownership, mismatched path binding and malformed stored DTOs",async()=>{
  mocks.rpc.mockResolvedValueOnce({data:{...baseOverview,candidates:{...baseOverview.candidates,ownerId:other}},error:null});expect((await overview(request(undefined,"GET"),params())).status).toBe(404);
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
  const response=await importRoute(request({expectedProjectRevision:1,source,capturedContext:context,idempotencyKey:"fixture-api-import00001"}),params());expect(response.status).toBe(409);expect(await response.json()).toEqual({error:{code:"naming_history_capacity",message:"This project's naming history has reached the generation limit. Your saved names are preserved."}});
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
