import { createHash } from "node:crypto";
import { describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import {logoDirectionsApiPolicySchema,logoDirectionsApiJobInputSchema,logoDirectionsApiObservationSchema} from "../../src/domain/logo-jobs";
import type {LogoWorkerConnection} from "../../src/server/data/logo-jobs";
import type {IdentityAssetStore} from "../../src/server/data/identity-asset-store";
import type {OpenAIResponsesTransport} from "../../src/server/ai/openai-transport";
import {canonicalLogoDocumentBytes} from "../../src/features/logo-vector/model/canonical";
import {serializeLogoSvg} from "../../src/features/logo-vector/model/svg";
import {createSharedAdvancedLogoHandler} from "../../worker/shared-lanes/logo-advanced";
import {createSharedDirectionsApiProvider} from "../../worker/shared-lanes/logo-directions-api";
import {sharedDirectionsCapabilitySchema} from "../../worker/shared-lanes/logo-capability";
import {subscriptionFixture} from "../features/identity-directions/subscription-fixtures";
import {fontBytes,id} from "../features/identity-directions/fixtures";
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
export const apiDirectionsPolicy=()=>logoDirectionsApiPolicySchema.parse({version:1,billingMode:"openai_api",spendControl:"uncapped",handlerVersion:"logo-directions-api-v1",adapterVersion:"logo-directions-openai-v1",
 model:"gpt-6.1-sol",pricingVersion:"2026-10-03",serviceTier:"default",maxInputTokens:32768,maxOutputTokens:4096,maxInputBytes:131072,maxOutputBytes:32768,maxStreamBytes:2097152,deadlineMs:240000,maxTools:0,
 inputMicrousdPerMillionTokens:2000000,cachedInputMicrousdPerMillionTokens:100000,cacheWriteMicrousdPerMillionTokens:2500000,outputMicrousdPerMillionTokens:10000000});
/** Real provider request/normalizer/font inspection/publication; explicit inert
 * SQL, byte-store and Responses ports. This is not paid/live AI acceptance. */
function fixture(){
 const f=subscriptionFixture(),policy=apiDirectionsPolicy(),old=f.job.input as Record<string,unknown>;
 const {policy:_subscription,billingMode:_billing,...base}=old;void _subscription;void _billing;
 f.job.input=logoDirectionsApiJobInputSchema.parse({...base,version:3,handlerVersion:policy.handlerVersion,billingMode:"openai_api",spendControl:"uncapped",apiPolicy:policy});
 const capability=sharedDirectionsCapabilitySchema.parse({operation:f.job.operation,policyIdentity:"b".repeat(64),handlerVersion:policy.handlerVersion,provider:"openai",model:policy.model,engine:null,spendControl:"uncapped",apiPolicy:policy});
 const bytes=canonicalLogoDocumentBytes(f.input.logo),svg=serializeLogoSvg(f.input.logo);
 const ref=(n:number,contentHash:string)=>({ownerId:f.job.ownerId,projectId:f.job.projectId,assetId:id(n),versionId:id(n+1),contentHash});
 const source={...f.input,logoRevision:{id:f.input.approvedLogo.vectorRevisionId,ownerId:f.job.ownerId,projectId:f.job.projectId,parentRevisionId:null,source:{kind:"refinement",rasterRevisionId:id(86)},
  sourcePreview:ref(94,"d".repeat(64)),documentAsset:ref(90,hash(bytes)),svgAsset:ref(92,hash(svg)),documentHash:hash(bytes),proof:{version:1,documentHash:hash(bytes),svgContentHash:hash(svg),
  validator:{id:"fluid.logo-vector",version:"1"},viewBox:f.input.logo.viewBox,pathCount:2,componentCount:2,externalFontDependencies:[]},locks:[],inputRevisions:[],reviewStatus:"review_required",createdAt:"2026-10-07T00:00:00Z"}};
 delete(source as Partial<typeof source>).logo;
 const state={accepting:true,corruptFont:false,corruptLicense:false,receiptLost:false,model:policy.model as string,stopAfterResponse:false},observations:unknown[]=[],stage:unknown[][]=[];
 const controller=new AbortController();
 const connection:LogoWorkerConnection={async query<Row>(sql:string,args:unknown[]=[]){
  expect(args[0]).toBe(f.job.id);expect(args[1]).toBe(f.job.leaseToken);let value:unknown;
  if(sql.includes("load_logo_direction_inputs"))value=state.corruptLicense?{...source,permittedFonts:source.permittedFonts.map(font=>({...font,rights:{...font.rights,licenseTextHash:"f".repeat(64)}}))}:source;
  else if(sql.includes("read_leased_logo_record"))value=true;
  else if(sql.includes("record_logo_provider_response")){const observation=JSON.parse(String(args[2]));observations.push(observation);if(state.receiptLost)throw Error("inert receipt ACK lost");
   value={...observation,id:id(110),ownerId:f.job.ownerId,projectId:f.job.projectId,jobId:f.job.id,leaseToken:f.job.leaseToken};}
  else if(sql.includes("stage_logo_directions")){stage.push(args);value={id:id(111),ownerId:f.job.ownerId,projectId:f.job.projectId,jobId:f.job.id,inputHash:"a".repeat(64),
   directionIds:JSON.parse(String(args[2])).directions.map((direction:{id:string})=>direction.id),publicationState:"staged"};}
  else throw Error("Unexpected fixed SQL");
  return{rows:[{value}] as Row[]};
 }};
 const denied=async():Promise<never>=>{throw Error("No owned/write fixture access");};
 const assets:IdentityAssetStore={stageOwnedAsset:denied,publishOwnedUpload:denied,readOwnedAsset:denied,publishLeasedAsset:denied,
  async readLeasedAsset(job,reference){expect(job).toEqual(f.job);const doc=reference.assetId===source.logoRevision.documentAsset.assetId;
   const value=doc?bytes:state.corruptFont?new Uint8Array([1]):fontBytes(),mimeType=doc?"application/json":"font/ttf";
   return{reference,bytes:Uint8Array.from(value),mimeType,verification:{status:"verified",checkedAt:"2026-10-07T00:00:00Z",mimeType,byteLength:value.length,contentHash:reference.contentHash}};
  }};
 const createResponse=vi.fn(async()=>{if(state.stopAfterResponse)controller.abort();return{requestId:"req_inert_directions",body:{id:"resp_inert_directions",status:"completed",model:state.model,service_tier:"default",
  usage:{input_tokens:100,output_tokens:100,total_tokens:200,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}},output:[{type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:JSON.stringify(f.candidate)}]}]}};});
 const transport:OpenAIResponsesTransport={countInputTokens:vi.fn(async()=>100),createResponse};
 const handler=createSharedAdvancedLogoHandler({job:f.job,capability,connection,assets,provider:{apiKey:"inert-image-key",model:"unused-image-model",modelVerificationReceipt:"image-proof"},
  textProvider:{apiKey:"inert-text-key",model:policy.model,modelVerificationReceipt:"text-proof"},acceptingWork:()=>state.accepting,assertAvailable:async()=>{if(!state.accepting)throw Error("stopped");},textTransport:transport});
 return{...f,policy,state,observations,stage,createResponse,transport,execute:()=>handler.steps(f.job)[0]!.execute({job:f.job,signal:controller.signal})};
}
describe("future uncapped API directions through the actual advanced handler",()=>{
 it("dispatches once, records real calculated usage and stages three directions only after actual font-byte checks",async()=>{
  const f=fixture(),outcome=await f.execute();expect(outcome.status).toBe("succeeded");expect(outcome.costMicrousd).toBe(1200);
  expect(f.createResponse).toHaveBeenCalledTimes(1);expect(f.stage).toHaveLength(1);
  expect(JSON.parse(String(f.stage[0]![4])).length).toBeGreaterThan(0);
  const observation=logoDirectionsApiObservationSchema.parse(f.observations[0]);expect(observation.billing).toEqual({status:"recorded",confirmedMicrousd:1200});
  expect(observation.apiPolicy).not.toHaveProperty("maximumCostMicrousd");expect(f.job.reservedCostMicrousd).toBe(0);
 });
 it("retains the paid observation but never stages outputs from corrupt font bytes",async()=>{
  const f=fixture();f.state.corruptFont=true;const outcome=await f.execute();expect(outcome.status).toBe("needs_reconciliation");
  expect(outcome.costMicrousd).toBe(1200);expect(f.observations).toHaveLength(1);expect(f.stage).toHaveLength(0);
 });
 it("never fabricates a license proof for otherwise valid font bytes",async()=>{
  const f=fixture();f.state.corruptLicense=true;const outcome=await f.execute();
  expect(outcome.status).toBe("needs_reconciliation");expect(outcome.costMicrousd).toBe(1200);expect(f.stage).toHaveLength(0);
 });
 it("cannot dispatch after Stop and never fabricates a provider response receipt",async()=>{
  const f=fixture();f.state.accepting=false;expect(await f.execute()).toMatchObject({status:"failed",code:"not_dispatched",costMicrousd:0});
  expect(f.createResponse).not.toHaveBeenCalled();expect(f.observations).toHaveLength(0);expect(f.stage).toHaveLength(0);
 });
 it("retains actual observed usage after cancellation without publishing a ready direction",async()=>{
  const f=fixture();f.state.stopAfterResponse=true;const result=await f.execute();
  expect(result.status).toBe("needs_reconciliation");expect(result.costMicrousd).toBe(1200);expect(f.observations).toHaveLength(1);expect(f.stage).toHaveLength(0);
 });
 it("does not attribute known pricing or stage a substituted model",async()=>{
  const f=fixture();f.state.model="unapproved-model";expect((await f.execute()).status).toBe("needs_reconciliation");
  expect(logoDirectionsApiObservationSchema.parse(f.observations[0]).billing.status).toBe("unknown");expect(f.stage).toHaveLength(0);
 });
 it("captures its owner, stop callback and transport methods during construction",async()=>{
  const f=fixture(),options={ownerId:f.job.ownerId,policy:f.policy,apiKey:"inert-text-key",acceptingWork:()=>true,transport:f.transport};
  const provider=createSharedDirectionsApiProvider(options),replacement=vi.fn();
  options.ownerId=id(199);options.acceptingWork=()=>false;f.transport.createResponse=replacement;
  const result=await provider.propose(f.input,new AbortController().signal,{job:f.job,beforeDispatch:async()=>{}});
  expect(result.outcome.status).toBe("succeeded");expect(f.createResponse).toHaveBeenCalledTimes(1);expect(replacement).not.toHaveBeenCalled();
 });
});
