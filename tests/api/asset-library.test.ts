import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));const mocks=vi.hoisted(()=>({auth:vi.fn(),rpc:vi.fn()}));vi.mock("../../src/server/auth/context",()=>({getAuthenticatedContext:mocks.auth}));
import { GET as list } from "../../src/app/api/assets/route";
import { GET as detail } from "../../src/app/api/assets/library/[assetId]/route";
import { PATCH as retention } from "../../src/app/api/assets/library/[assetId]/retention/route";
import { POST as selection } from "../../src/app/api/assets/library/[assetId]/selection/route";
import { ApiError } from "../../src/server/http/errors";
const owner="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",asset="11111111-1111-4111-8111-111111111111",version="22222222-2222-4222-8222-222222222222";
const params={params:Promise.resolve({assetId:asset})};
function request(body?:unknown,query="",headers:Record<string,string>={}){return new Request("https://fluid.example/api/assets"+query,{method:body===undefined?"GET":"POST",headers:{origin:"https://fluid.example","content-type":"application/json",...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});}
const writes=[["retention",retention,{expectedRetentionRevision:0,liked:true,saved:false}],["selection",selection,{versionId:version,expectedProjectRevision:1,expectedSelectionRevision:0,acceptStaleBasis:false}]] as const;
describe("Assets API strict private boundaries",()=>{
 beforeEach(()=>{vi.resetAllMocks();vi.stubEnv("APP_ORIGIN","https://fluid.example");mocks.auth.mockResolvedValue({userId:owner,client:{rpc:mocks.rpc}});mocks.rpc.mockResolvedValue({data:{ownerId:owner,query:{tab:"my_selection",limit:40},items:[],nextCursor:null},error:null});});
 afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
 it("returns a verified private empty page and exact bounded default query",async()=>{const response=await list(request());expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ownerId:owner,items:[]});expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("list_account_assets",{p_query:{tab:"my_selection",limit:40}});expect(response.headers.get("cache-control")).toBe("private, no-store");expect(response.headers.get("vary")).toBe("Cookie");});
 it("parses filter-bound JSON cursors and rejects malformed/repeated/unknown parameters",async()=>{
  for(const query of ["?ownerId="+owner,"?limit=101","?limit=1&limit=2","?cursor=%7B","?cursor="+"a".repeat(2049),"?tab=all_generations&cursor="+encodeURIComponent(JSON.stringify({createdAt:"2026-10-04T00:00:00Z",assetId:asset,tab:"my_selection",projectId:null,format:null}))])expect((await list(request(undefined,query))).status).toBe(422);
  expect(mocks.rpc).not.toHaveBeenCalled();expect((await detail(request(undefined,"?tab=all_generations"),params)).status).toBe(422);
 });
 it("canonicalizes validated UUIDs at route, body and mixed-case query boundaries",async()=>{
  const canonicalAsset="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",canonicalVersion="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",project="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  mocks.rpc.mockResolvedValue({data:null,error:{code:"P0002"}});
  const cursor={createdAt:"2026-10-04T00:00:00Z",assetId:canonicalAsset.toUpperCase(),tab:"all_generations",projectId:project,format:null};
  const query=new URLSearchParams({tab:"all_generations",projectId:project.toUpperCase(),cursor:JSON.stringify(cursor)});
  await list(request(undefined,"?"+query));expect(mocks.rpc).toHaveBeenLastCalledWith("list_account_assets",{p_query:{tab:"all_generations",projectId:project,limit:40,cursor:{...cursor,assetId:canonicalAsset}}});
  const path={params:Promise.resolve({assetId:canonicalAsset.toUpperCase()})};
  await selection(request({versionId:canonicalVersion.toUpperCase(),expectedProjectRevision:1,expectedSelectionRevision:0,acceptStaleBasis:false}),path);
  expect(mocks.rpc).toHaveBeenLastCalledWith("select_asset_version",{p_asset_id:canonicalAsset,p_version_id:canonicalVersion,p_expected_project_revision:1,p_expected_selection_revision:0,p_accept_stale_basis:false});
 });
 it.each(writes)("fences auth/origin and forbids trusted metadata injection in %s",async(_name,handler,body)=>{
  expect((await handler(request(body,"",{origin:"https://foreign.example"}),params)).status).toBe(403);expect(mocks.auth).not.toHaveBeenCalled();
  mocks.auth.mockRejectedValueOnce(new ApiError("unauthenticated"));expect((await handler(request(body),params)).status).toBe(401);
  for(const injected of [{ownerId:owner},{used:true},{provider:"forged"},{storagePath:"private"},{vectorStatus:"validated_paths"}])expect((await handler(request({...body,...injected}),params)).status).toBe(422);expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it.each([["P0002",404],["PT409",409],["23505",409],["22023",422],["22003",422],["08006",503]] as const)("maps database %s safely to %i",async(code,status)=>{mocks.rpc.mockResolvedValue({data:null,error:{code,message:"private error"}});const response=await list(request());expect(response.status).toBe(status);expect(await response.text()).not.toContain("private error");});
 it("enforces actual streamed UTF-8 bytes despite a false Content-Length",async()=>{
  const bytes=new TextEncoder().encode(JSON.stringify({expectedRetentionRevision:0,liked:true,saved:false,extra:"é".repeat(17_000)}));const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(bytes);c.close();}});
  const response=await retention(new Request("https://fluid.example/api/assets",{method:"PATCH",headers:{origin:"https://fluid.example","content-type":"application/json","content-length":"1"},body:stream,duplex:"half"} as RequestInit&{duplex:"half"}),params);expect(response.status).toBe(413);expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it("rejects malformed stored data, foreign owner and malformed asset IDs",async()=>{
  mocks.rpc.mockResolvedValueOnce({data:{ownerId:version,query:{tab:"my_selection",limit:40},items:[],nextCursor:null},error:null});expect((await list(request())).status).toBe(404);
  mocks.rpc.mockResolvedValueOnce({data:{ownerId:owner},error:null});expect((await list(request())).status).toBe(503);
  expect((await detail(request(),{params:Promise.resolve({assetId:"bad-id"})})).status).toBe(404);
 });
});
