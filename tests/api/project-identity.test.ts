import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));const mocks=vi.hoisted(()=>({auth:vi.fn(),rpc:vi.fn()}));vi.mock("../../src/server/auth/context",()=>({getAuthenticatedContext:mocks.auth}));
import { PATCH } from "../../src/app/api/projects/[projectId]/identity/preferences/route";
const owner="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",project="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const params={params:Promise.resolve({projectId:project})};
const body={expectedPreferencesRevision:0,preferences:{version:1,creativeLocale:"en",notes:"Local preference",avoidanceNotes:""}};
const request=(value:unknown=body,origin="https://fluid.example")=>new Request("https://fluid.example/api/projects/"+project+"/identity/preferences",{method:"PATCH",headers:{origin,"content-type":"application/json"},body:JSON.stringify(value)});
describe("Identity preference API boundaries",()=>{
 beforeEach(()=>{vi.resetAllMocks();vi.stubEnv("APP_ORIGIN","https://fluid.example");mocks.auth.mockResolvedValue({userId:owner,client:{rpc:mocks.rpc}});mocks.rpc.mockResolvedValue({data:null,error:{code:"PT409"}});});
 afterEach(()=>{vi.unstubAllEnvs();});
 it("rejects cross-origin writes before authentication or SQL",async()=>{expect((await PATCH(request(body,"https://foreign.example"),params)).status).toBe(403);expect(mocks.auth).not.toHaveBeenCalled();expect(mocks.rpc).not.toHaveBeenCalled();});
 it.each([{ownerId:owner},{provider:"forged"},{expectedProjectRevision:1},{source:{kind:"generated"}}])("rejects extra browser metadata %j",async(extra)=>{expect((await PATCH(request({...body,...extra}),params)).status).toBe(422);expect(mocks.rpc).not.toHaveBeenCalled();});
 it.each([["P0002",404],["PT409",409],["22023",422],["08006",503]] as const)("maps %s without private error leakage",async(code,status)=>{mocks.rpc.mockResolvedValue({data:null,error:{code,message:"private details"}});const response=await PATCH(request(),params);expect(response.status).toBe(status);expect(await response.text()).not.toContain("private details");expect(response.headers.get("cache-control")).toBe("private, no-store");});
 it("enforces actual streamed byte limit despite false declared length",async()=>{
  const bytes=new TextEncoder().encode(JSON.stringify({...body,extra:"é".repeat(17000)}));const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes);controller.close();}});
  const response=await PATCH(new Request("https://fluid.example/api/projects/"+project+"/identity/preferences",{method:"PATCH",headers:{origin:"https://fluid.example","content-type":"application/json","content-length":"1"},body:stream,duplex:"half"} as RequestInit&{duplex:"half"}),params);expect(response.status).toBe(413);expect(mocks.rpc).not.toHaveBeenCalled();
 });
});

import { beforeAll,afterAll } from "vitest";
import { POST as select } from "../../src/app/api/projects/[projectId]/identity/selection/route";
import { POST as refine } from "../../src/app/api/projects/[projectId]/identity/refinements/route";
import { GET as overview } from "../../src/app/api/projects/[projectId]/identity/route";
import { GET as detail } from "../../src/app/api/projects/[projectId]/identity/systems/[systemVersionId]/route";
import { selectIdentitySystemResponseSchema,identityRefinementResponseSchema,projectIdentityOverviewSchema } from "../../src/domain/project-identity";
import { OWNER_A,OWNER_B,createTestDatabase,resetFixture,seedProject,type TestDatabase } from "../database/local-supabase";
import { createIdentityTransactionService } from "../../src/server/data/identity-transaction";
import { createIdentityTransactionFixture } from "../server/fixtures/identity-transaction";
import { identityDalAuth,seedIdentityRoot } from "../database/identity-system-database";
describe("Identity API reads with explicitly synthetic injected commits and unavailable production saves",()=>{
 let db:TestDatabase;let id:string;let f:Awaited<ReturnType<typeof seedIdentityRoot>>;
 beforeAll(async()=>{db=await createTestDatabase();},30_000);afterAll(async()=>{await db?.close();});
 beforeEach(async()=>{vi.resetAllMocks();vi.stubEnv("APP_ORIGIN","https://fluid.example");await resetFixture(db);id=(await seedProject(db)).id;f=await seedIdentityRoot(db,id);mocks.auth.mockResolvedValue(identityDalAuth(db));});
 afterEach(()=>{vi.unstubAllEnvs();});
 const post=(id:string,value:unknown,origin="https://fluid.example")=>new Request(`https://fluid.example/api/projects/${id}/identity/selection`,{method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify(value)});
 const intent=()=>({systemVersionId:f.system.id.toUpperCase(),expectedProjectRevision:f.input.projectRevision,expectedReferenceRevision:f.input.referenceSnapshot.referenceRevision,expectedPreferencesRevision:0,expectedIdentityRevision:0,acceptEarlierBasis:false});
 it("reads strict canonical history after explicitly synthetic injected transaction commits",async()=>{
  const context={params:Promise.resolve({projectId:id.toUpperCase()})};const local=createIdentityTransactionFixture(db,OWNER_A),transactions=createIdentityTransactionService(local.factory),auth=identityDalAuth(db);
  const selected=selectIdentitySystemResponseSchema.parse(await transactions.select(auth,id.toUpperCase(),intent()));expect(selected.currentSelection.system.id).toBe(f.system.id);
  const {systemVersionId,...rest}=intent();const result=identityRefinementResponseSchema.parse(await transactions.refine(auth,id,{...rest,baseSystemVersionId:systemVersionId,expectedIdentityRevision:1,component:"typography",input:{styles:[{key:"body",role:"Body",family:"Changed family",weight:500,style:"italic"}],usageNotes:"Manual specification"},idempotencyKey:"api-identity-refinement-01"}));expect(result.system.source.kind).toBe("manual_edit");expect(local.events.filter(event=>event==="COMMIT")).toHaveLength(2);
  const read=await overview(new Request(`https://fluid.example/api/projects/${id}/identity?limit=1`),context);expect(read.status).toBe(200);const actual=projectIdentityOverviewSchema.parse(await read.json());expect(actual.currentSelection!.system.id).toBe(result.system.id);expect(actual.systems.nextCursor).not.toBeNull();expect(actual.saveAvailability).toEqual({status:"unavailable",reason:"trusted_transaction_unavailable"});expect(read.headers.get("cache-control")).toBe("private, no-store");
 });
 it("returns production 503 and foreign 404 without mutation effects while reads and preferences remain safe",async()=>{
  const context={params:Promise.resolve({projectId:id})};const {systemVersionId,...rest}=intent();const refinement={...rest,baseSystemVersionId:systemVersionId,component:"colors",input:{swatches:[{key:"primary",name:"New forest",hex:"#AABBCC"}],usageNotes:"User choice"},idempotencyKey:"api-unavailable-save-0001"};
  for(const [handler,value] of [[select,intent()],[refine,refinement]] as const){const response=await handler(post(id,value),context);expect(response.status).toBe(503);expect(response.headers.get("cache-control")).toBe("private, no-store");expect(await response.text()).not.toContain("fluid_private");}
  mocks.auth.mockResolvedValue(identityDalAuth(db,OWNER_B));for(const [handler,value] of [[select,intent()],[refine,refinement]] as const)expect((await handler(post(id,value),context)).status).toBe(404);
  for(const table of ["identity_sessions","identity_selections","identity_component_changes","asset_usages"])expect((await db.query(`select count(*)::int count from public.${table}`)).rows[0]).toEqual({count:0});
  mocks.auth.mockResolvedValue(identityDalAuth(db));const read=await overview(new Request(`https://fluid.example/api/projects/${id}/identity`),context);expect(read.status).toBe(200);const actual=projectIdentityOverviewSchema.parse(await read.json());expect(actual.systems.items.map(system=>system.id)).toEqual([f.system.id]);expect(actual.saveAvailability).toEqual({status:"unavailable",reason:"trusted_transaction_unavailable"});
  expect((await PATCH(new Request(`https://fluid.example/api/projects/${id}/identity/preferences`,{method:"PATCH",headers:{origin:"https://fluid.example","content-type":"application/json"},body:JSON.stringify(body)}),context)).status).toBe(200);
 });
 it.each([select,refine])("rejects cross-origin writes before authentication",async(handler)=>{expect((await handler(post(id,intent(),"https://foreign.example"),{params:Promise.resolve({projectId:id})})).status).toBe(403);expect(mocks.auth).not.toHaveBeenCalled();});
 it.each(["?limit=1&limit=2","?ownerId=forged","?cursor=%7B%22id%22%3A1%7D","?limit=51"])("rejects malformed bounded history query %s",async(query)=>{expect((await overview(new Request(`https://fluid.example/api/projects/${id}/identity${query}`),{params:Promise.resolve({projectId:id})})).status).toBe(422);});
 it("does not accept provenance injection or an unfenced selection",async()=>{
  expect((await select(post(id,{...intent(),source:{kind:"generated"}}),{params:Promise.resolve({projectId:id})})).status).toBe(422);
  const body={...intent()} as Record<string,unknown>;delete body.expectedReferenceRevision;expect((await select(post(id,body),{params:Promise.resolve({projectId:id})})).status).toBe(422);
 });
 it("rejects extra detail query and hides an invalid route UUID",async()=>{
  expect((await detail(new Request(`https://fluid.example/api/projects/${id}/identity/systems/${f.system.id}?extra=1`),{params:Promise.resolve({projectId:id,systemVersionId:f.system.id})})).status).toBe(422);
  expect((await detail(new Request(`https://fluid.example/api/projects/${id}/identity/systems/invalid`),{params:Promise.resolve({projectId:id,systemVersionId:"invalid"})})).status).toBe(404);
 });
});
