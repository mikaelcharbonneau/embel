import { describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import {uncappedLogoVectorProposalTextPolicySchema,uncappedLogoVectorProposalJobInputSchema,logoVectorProposalProviderObservationSchema} from "../../src/domain/logo-vector-proposal-jobs";
import {qualifiedUncappedLogoVectorProposalCapability} from "../../worker/logo-vector-proposal-capability";
import {createSharedAdvancedLogoHandler} from "../../worker/shared-lanes/logo-advanced";
import type {LogoWorkerConnection} from "../../src/server/data/logo-jobs";
import {providerFixture} from "../server/logo-vector-proposal-provider-fixtures";
/** Existing provider, evidence validator, DAL and handler; explicit inert
 * metadata/Responses ports. No vector is generated or accepted by this test. */
function fixture(){
 const f=providerFixture(),{maximumCostMicrousd:_old,...policy}=f.textPolicy;void _old;
 const textPolicy=uncappedLogoVectorProposalTextPolicySchema.parse({...policy,version:2,spendControl:"uncapped",adapterVersion:"logo-vector-propose-api-uncapped-v2"});
 const resolved={...f.resolved,input:uncappedLogoVectorProposalJobInputSchema.parse({...f.resolved.input,version:3,billingMode:"openai_api",spendControl:"uncapped",textPolicy})};
 f.job.input=resolved.input;f.job.reservedCostMicrousd=0;
 const capability=qualifiedUncappedLogoVectorProposalCapability({operation:f.job.operation,policyIdentity:f.resolved.input.policyIdentity,handlerVersion:"logo-vector-propose-v1",
  provider:"openai",model:textPolicy.model,engine:null,spendControl:"uncapped",textPolicy})!;
 let observation:ReturnType<typeof logoVectorProposalProviderObservationSchema.parse>|null=null;
 const state={accepting:true,receiptLost:false},events:string[]=[];
 const connection:LogoWorkerConnection={async query<Row>(sql:string,args:unknown[]=[]){events.push(sql);expect(args[0]).toBe(f.job.id);expect(args[1]).toBe(f.job.leaseToken);let value:unknown;
  if(sql.includes("read_leased_logo_record"))value=args[2]==="runtime_readiness"?true:resolved;
  else if(sql.includes("record_logo_provider_response")){observation=logoVectorProposalProviderObservationSchema.parse(JSON.parse(String(args[2])));if(state.receiptLost)throw Error("Inert receipt ACK lost");value=await f.ports.recordResponse(f.job,observation);}
  else if(sql.includes("stage_logo_vector_proposal")){if(!observation)throw Error("Missing originalreceipt");const receipt=await f.ports.recordResponse(f.job,observation);value=await f.ports.stageProposal(f.job,JSON.parse(String(args[2])),receipt);}
  else throw Error("Unrecognized fixed SQL");
  return{rows:[{value}] as Row[]};
 }};
 const handler=createSharedAdvancedLogoHandler({job:f.job,capability,connection,assets:null,
  provider:{apiKey:"inert-unused-image-key",model:"unused-image",modelVerificationReceipt:"imageproof"},
  textProvider:{apiKey:"inert-text-key",model:textPolicy.model,modelVerificationReceipt:"verified-text-model"},
  acceptingWork:()=>state.accepting,assertAvailable:async()=>{if(!state.accepting)throw Error("stopped");},textTransport:f.transport});
 return{...f,resolved,textPolicy,capability,state,events,execute:()=>handler.steps(f.job)[0]!.execute({job:f.job,signal:new AbortController().signal}),
  get observation(){return observation;}};
}
describe("uncapped vector proposal via real advanced factory and evidence ports",()=>{
 it("records actual expense with zero bookkeeping reserve and stages intent without any asset authority",async()=>{
  const f=fixture(),outcome=await f.execute();expect(outcome).toMatchObject({status:"succeeded",costMicrousd:68});
  expect(f.transport.createResponse).toHaveBeenCalledTimes(1);expect(f.capability).not.toHaveProperty("maxCostMicrousd");
  expect(f.textPolicy).not.toHaveProperty("maximumCostMicrousd");
  expect(f.events.some(sql=>sql.includes("stage_logo_vector_proposal"))).toBe(true);
  expect(f.events.every(sql=>!sql.includes("logo_asset"))).toBe(true);
 });
 it("stops before create after admission closes, without interpreting that as unknown paid output",async()=>{
  const f=fixture();f.state.accepting=false;expect(await f.execute()).toMatchObject({status:"failed",code:"not_dispatched",costMicrousd:0});
  expect(f.transport.createResponse).not.toHaveBeenCalled();expect(f.observation).toBeNull();
 });
 it("retains observed paid evidence on lost journal acknowledgement and never retries inference",async()=>{
  const f=fixture();f.state.receiptLost=true;expect(await f.execute()).toMatchObject({status:"needs_reconciliation",code:"provider_evidence_unconfirmed",costMicrousd:68});
  expect(f.transport.createResponse).toHaveBeenCalledTimes(1);expect(f.observation?.billing).toEqual({status:"recorded",confirmedMicrousd:68});
  expect(f.events.some(sql=>sql.includes("stage_logo_vector_proposal"))).toBe(false);
 });
});
