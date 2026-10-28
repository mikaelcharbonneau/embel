import { createHash } from "node:crypto";
import { describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { strategyJobInputSchema } from "../../src/domain/strategy-jobs";
import { ApiTextJobStore } from "../../worker/api-text-store";
import { createOpenAIStrategyHandlers } from "../../worker/handlers/openai-strategy";
import { createStrategyRequest,evaluateStrategyResponse,executeStrategyResponse } from "../../src/server/ai/strategy-response";
import { guidedJobFixture } from "./guided-strategy-fixtures";
import { inputFixture,jobFixture,responseFixture,transportFixture } from "../server/openai-fixtures";
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fixture(){
 const guided=guidedJobFixture(),old=strategyJobInputSchema.parse(guided.input);if(old.version!==2)throw Error("Expected saved v2 fixture");
 const {acceptedMaxCostMicrousd:discarded,...saved}=old;void discarded;
 const input=strategyJobInputSchema.parse({...saved,version:3,spendControl:"uncapped",policyIdentity:"a".repeat(64)});
 const job={...guided,input},message={version:1 as const,jobId:job.id,policyIdentity:"a".repeat(64),deploymentId:"dpl_synthetic",dispatchIdentity:"b".repeat(64)};
 const row={id:job.id,owner_id:job.ownerId,project_id:job.projectId,lease_token:job.leaseToken,input:job.input,input_hash:"c".repeat(64),input_revision:job.inputRevision,
  billing_mode:"openai_api",operation:job.operation,state:"running",reserved_cost_microusd:job.reservedCostMicrousd,actual_cost_microusd:job.actualCostMicrousd};
 const authority={version:1,contract:"hosted_strategy_owner_uncapped_v1",jobId:job.id,ownerId:job.ownerId,projectId:job.projectId,leaseToken:job.leaseToken,inputHash:row.input_hash,
  policyIdentity:message.policyIdentity,roleOid:123,generation:1,revision:1};
 return{job,input,message,row,authority};
}
describe("future managed Strategy contract boundaries (inert unit fixtures)",()=>{
 it("preserves saved v1/v2 input and provider wire hashes from repository HEAD",()=>{
  // Compared with createStrategyRequest from cce8b49 before recording these pins.
  const old=inputFixture(),guided=strategyJobInputSchema.parse(guidedJobFixture().input);
  expect(hash(old)).toBe("8d99fe44378b7bced29e0ac547b670f2617a6e87a78c0aa6c436b99eadd1f5b1");
  expect(hash(guided)).toBe("efa35b0f320e7af399ec5f7bfc0c45ac9d2d00b46f719f813d79e33668f09f10");
  expect(hash(createStrategyRequest("strategy.reformulate",old))).toBe("78a6ebd8226005aab84cd1fc01be693e37760fd95a0eea5a8c9309cbc5d10cdf");
  expect(hash(createStrategyRequest("strategy.competitors",guided))).toBe("5abd57dafbf508dc3cd80ba45f9bf63a5bf5a31567ce295a9de595da8306099f");
 });
 it.each(["absent","owner","lease","inputHash","policyIdentity"])("denies a v3 claim with %s authority defect",async defect=>{
  const f=fixture(),proof={...f.authority};
  if(defect==="owner")proof.ownerId="11111111-1111-4111-8111-111111111111";
  if(defect==="lease")proof.leaseToken="11111111-1111-4111-8111-111111111111";
  if(defect==="inputHash")proof.inputHash="d".repeat(64);
  if(defect==="policyIdentity")proof.policyIdentity="d".repeat(64);
  const database={async query(){return{rows:[{result:{disposition:"claimed",state:"running",job:f.row,...(defect==="absent"?{}:{executionAuthority:proof})}}]};}};
  const store=new ApiTextJobStore(database,f.message,f.message.deploymentId,f.job.operation);
  await expect(store.claim("inert-worker",60)).rejects.toBeDefined();expect(store.hasUnmeteredExecutionAuthority(f.job)).toBe(false);
 });
 it("does not let immutable input alone authorize a provider call",async()=>{
  const f=fixture(),transport=transportFixture();
  const handlers=createOpenAIStrategyHandlers({apiKey:"synthetic-key",policies:new Map([["strategy.competitors",f.input.policy]])},transport);
  expect(()=>handlers.get("strategy.competitors")!.steps(f.job)).toThrow("execution authority");
  const result=await executeStrategyResponse({job:f.job,input:f.input,operation:"strategy.competitors",transport,signal:new AbortController().signal});
  expect(result).toMatchObject({status:"failed",code:"unsupported_execution_contract"});expect(transport.countInputTokens).not.toHaveBeenCalled();expect(transport.createResponse).not.toHaveBeenCalled();
 });
 it("keeps a known terminal text failure known when the remaining monetary estimate is exhausted, without changing unknown usage",()=>{
  const job=jobFixture(),old=inputFixture(),guided=guidedJobFixture();
  const guidedInput=strategyJobInputSchema.parse(guided.input);if(guidedInput.version!==2)throw Error("Expected savedv2");
  const policy={...guidedInput.policy,maxWebSearchCalls:0};
  const input=strategyJobInputSchema.parse({version:3,context:guidedInput.context,policy,assistantHistory:guidedInput.assistantHistory,spendControl:"uncapped",policyIdentity:"a".repeat(64)});
  const response={...responseFixture(),status:"failed",output:[]};
  const claimed={...job,actualCostMicrousd:job.reservedCostMicrousd,input};
  expect(evaluateStrategyResponse({job:{...job,actualCostMicrousd:job.reservedCostMicrousd},operation:"strategy.reformulate",input:old,raw:{body:response,requestId:null}})).toMatchObject({status:"needs_reconciliation"});
  expect(evaluateStrategyResponse({job:claimed,operation:"strategy.reformulate",input,raw:{body:response,requestId:null},unmeteredExecution:true})).toMatchObject({status:"failed",code:"provider_failed"});
  expect(evaluateStrategyResponse({job:claimed,operation:"strategy.reformulate",input,raw:{body:{...response,usage:null},requestId:null},unmeteredExecution:true})).toMatchObject({status:"needs_reconciliation",code:"provider_usage_missing"});
 });
});
