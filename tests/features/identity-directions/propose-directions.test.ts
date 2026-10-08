import { describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import type { ClaimedJob } from "@/domain/jobs";
import type { IdentityAssetStore } from "@/server/data/identity-asset-store";
import type { LogoProviderObservation,LogoResolvedDirectionInput } from "@/domain/logo-jobs";
import { createLogoDirectionsHandler, type LogoDirectionsDependencies } from "../../../worker/handlers/logo-directions";
import { directionFixture,id } from "./fixtures";
import { separatedLogoDocument } from "../logo-vector/fixtures";
function setup(){
 const o=directionFixture(),input:LogoResolvedDirectionInput={inputRevisions:[{stage:"brief_references",id:id(70),revision:1},{stage:"vector",id:id(5),revision:1}],approvedLogo:o.currentApprovedLogo!,logo:separatedLogoDocument(),brief:{version:2,id:id(70),ownerId:o.ownerId,projectId:o.projectId,stage:"brief_references",revision:1,parentRevisionId:null,inputRevisions:[],inputHash:"a".repeat(64),payload:{name:"Fluid",activity:"Design",audience:"Teams",personality:"Clear",logoTypes:["wordmark"],referenceSnapshotId:id(71),sourceProjectRevision:1},createdAt:"2026-10-06T00:00:00Z"},references:{version:2,id:id(71),ownerId:o.ownerId,projectId:o.projectId,revision:1,references:[]},permittedFonts:o.fonts,targetCount:3};
 const candidate={directions:[0,1,2].map(n=>({name:`Direction ${n}`,palette:{swatches:[{key:"ink",name:"Ink",hex:["#191919","#242424","#333333"][n]!},{key:"paper",name:"Paper",hex:"#FFFFFF"}],pairings:[{foregroundKey:"ink",backgroundKey:"paper",role:"body"}]},typography:{styles:structuredClone(o.typography[n]!.styles)},graphics:{elements:[]}}))};
 const job:ClaimedJob={id:id(80),ownerId:o.ownerId,projectId:o.projectId,operation:"identity.logo_directions",input:{version:2,ownerId:o.ownerId,projectId:o.projectId,operation:"identity.logo_directions",requestKey:id(81),quoteId:id(82),policyIdentity:"b".repeat(64),handlerVersion:"logo-directions-v1",inputHash:"a".repeat(64),approvedLogoId:id(3),briefRevisionId:id(70),referenceSnapshotId:id(71),fontVersionIds:[id(50)],targetCount:3},inputRevision:1,leaseToken:id(83),status:"running",reservedCostMicrousd:100,actualCostMicrousd:0};
 const observation:LogoProviderObservation={provider:"synthetic",model:"test-only",providerRequestId:"fixture-response",responseHash:"c".repeat(64),observedAt:"2026-10-07T00:00:00Z",billing:{status:"recorded",confirmedMicrousd:10},artifactHash:null};
 const deps:LogoDirectionsDependencies={assets:{} as IdentityAssetStore,assertReady:vi.fn(async()=>{}),loadInput:vi.fn(async()=>input),provider:{propose:vi.fn<LogoDirectionsDependencies["provider"]["propose"]>(async()=>({outcome:{status:"succeeded" as const,result:candidate,costMicrousd:10,providerRequestId:"fixture-response"},observation}))},recordResponse:vi.fn(async(j,obs)=>({...obs,id:id(84),ownerId:j.ownerId,projectId:j.projectId,jobId:j.id,leaseToken:j.leaseToken})),publish:vi.fn<LogoDirectionsDependencies["publish"]>(async(j,result)=>({id:id(85),ownerId:j.ownerId,projectId:j.projectId,jobId:j.id,inputHash:"a".repeat(64),directionIds:result.directions.map(d=>d.id) as [string,string,string],publicationState:"staged"}))};
 const run=(signal=new AbortController().signal)=>createLogoDirectionsHandler(deps).steps(job)[0]!.execute({job,signal});return{deps,input,job,candidate,observation,run};
}
describe("leased three-direction producer",()=>{
 it("does not dispatch before a real approved-logo source resolves",async()=>{const f=setup();f.deps.loadInput=async()=>({...f.input,approvedLogo:null}) as never;expect(await f.run()).toMatchObject({status:"failed",code:"not_dispatched"});expect(f.deps.provider.propose).not.toHaveBeenCalled();expect(f.deps.publish).not.toHaveBeenCalled();});
 it("publishes exactly three complete components only after a matching provider receipt",async()=>{const f=setup(),before=JSON.stringify(f.input.approvedLogo);const result=await f.run();expect(result).toMatchObject({status:"succeeded",result:{kind:"logo_directions",publicationId:id(85),providerResponseReceiptId:id(84)}});expect(f.deps.publish).toHaveBeenCalledTimes(1);expect(JSON.stringify(f.input.approvedLogo)).toBe(before);f.deps.recordResponse=async(j,o)=>({...o,id:id(84),ownerId:id(99),projectId:j.projectId,jobId:j.id,leaseToken:j.leaseToken});expect(await f.run()).toMatchObject({status:"needs_reconciliation",code:"provider_evidence_unconfirmed"});expect(f.deps.publish).toHaveBeenCalledTimes(1);});
 it("retains unknown billing as reconciliation with a staged publication",async()=>{const f=setup();f.observation.billing={status:"unknown",confirmedMicrousd:null};expect(await f.run()).toMatchObject({status:"needs_reconciliation",code:"billing_unknown",result:{kind:"logo_directions"},costMicrousd:0});});
 it("retains an incomplete actual response without padding a third direction",async()=>{const f=setup();f.candidate.directions.pop();const result=await f.run();expect(result).toMatchObject({status:"needs_reconciliation",code:"direction_payload_invalid",result:{kind:"logo_directions_unpublished"}});if(result.status!=="needs_reconciliation")throw new Error("Expected uncertainty");expect(JSON.parse((result.result as unknown as {payload:{json:string}}).payload.json)).toEqual(f.candidate);expect(f.deps.publish).not.toHaveBeenCalled();});
 it.each(["provider_pending","after_success_abort","receipt_failed","publication_failed"] as const)("retains the actual bounded result on %s without publishing a current direction",async(mode)=>{
  const f=setup(),controller=new AbortController();
  const successful=f.deps.provider.propose;
  if(mode==="provider_pending")f.deps.provider.propose=async()=>({outcome:{status:"needs_reconciliation",code:"response_incomplete",result:f.candidate,costMicrousd:10,providerRequestId:"fixture-response"},observation:f.observation});
  if(mode==="after_success_abort")f.deps.provider.propose=async(...args)=>{const result=await successful(...args);controller.abort();return result;};
  if(mode==="receipt_failed")f.deps.recordResponse=async()=>{throw new Error("receipt connection lost");};
  if(mode==="publication_failed")f.deps.publish=vi.fn(async()=>{throw new Error("staging connection lost");});
  const result=await f.run(controller.signal);expect(result.status).toBe("needs_reconciliation");
  expect(result).toMatchObject({result:{version:2,kind:"logo_directions_unpublished",payload:{truncated:false}}});
  if(result.status!=="needs_reconciliation")throw new Error("Expected retained uncertainty");
  const retained=result.result as unknown as {payload:{json:string;sha256:string}};expect(JSON.parse(retained.payload.json)).toEqual(f.candidate);expect(retained.payload.sha256).toMatch(/^[a-f0-9]{64}$/);
  if(mode!=="publication_failed")expect(f.deps.publish).not.toHaveBeenCalled();
 });
 it("bounds oversized retained output while preserving its full hash and exact prefix",async()=>{
  const f=setup(),large={raw:"A".repeat(600_000)};f.deps.provider.propose=async()=>({outcome:{status:"needs_reconciliation",code:"response_incomplete",result:large,costMicrousd:10,providerRequestId:"fixture-response"},observation:f.observation});
  const result=await f.run();if(result.status!=="needs_reconciliation")throw new Error("Expected retained uncertainty");
  const retained=result.result as unknown as {payload:{json:string;byteLength:number;truncated:boolean}};expect(retained.payload.truncated).toBe(true);expect(retained.payload.byteLength).toBeGreaterThan(600_000);expect(JSON.stringify(large).startsWith(retained.payload.json)).toBe(true);expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(1_048_576);
 });

});

import { subscriptionPolicy } from "./subscription-fixtures";
it("publishes a valid subscription response identity without manufacturing a header request ID",async()=>{
 const f=setup(),policy=subscriptionPolicy();f.job.input={...f.job.input as object,billingMode:"chatgpt_subscription",policy};f.job.reservedCostMicrousd=0;
 f.deps.provider.propose=vi.fn<LogoDirectionsDependencies["provider"]["propose"]>(async(_input,_signal,dispatch)=>{await dispatch.beforeDispatch(dispatch.job);return{outcome:{status:"succeeded",result:f.candidate,costMicrousd:0,providerRequestId:null},observation:{version:2,billingMode:"chatgpt_subscription",registrationId:policy.registrationId,responseId:"resp_fixture",usage:null,provider:"openai",model:policy.model,providerRequestId:null,responseHash:"c".repeat(64),observedAt:"2026-10-07T00:00:00Z",billing:{status:"recorded",confirmedMicrousd:0},artifactHash:null}};});
 expect(await f.run()).toMatchObject({status:"succeeded",providerRequestId:null,costMicrousd:0});expect(f.deps.assertReady).toHaveBeenCalledTimes(2);expect(f.deps.publish).toHaveBeenCalledTimes(1);
});
it("keeps legacy directions dependent on the actual header request identity",async()=>{const f=setup();f.observation.providerRequestId=null;f.deps.provider.propose=async()=>({outcome:{status:"succeeded",result:f.candidate,costMicrousd:10,providerRequestId:null},observation:f.observation});expect(await f.run()).toMatchObject({status:"needs_reconciliation",code:"provider_evidence_incomplete"});expect(f.deps.publish).not.toHaveBeenCalled();});
it("does not accept a legacy observation for a frozen subscription job",async()=>{const f=setup();f.job.input={...f.job.input as object,billingMode:"chatgpt_subscription",policy:subscriptionPolicy()};f.job.reservedCostMicrousd=0;expect((await f.run()).status).toBe("needs_reconciliation");expect(f.deps.publish).not.toHaveBeenCalled();});
it.each(["usage","recorded_billing"] as const)("retains contradictory %s instead of trusting a substituted provider's not-dispatched claim",async evidence=>{
 const f=setup(),policy=subscriptionPolicy();f.job.input={...f.job.input as object,billingMode:"chatgpt_subscription",policy};f.job.reservedCostMicrousd=0;
 f.deps.provider.propose=async()=>({outcome:{status:"failed",code:"not_dispatched",costMicrousd:0,providerRequestId:null},observation:{version:2,billingMode:"chatgpt_subscription",registrationId:policy.registrationId,responseId:null,usage:evidence==="usage"?{inputTokens:1,outputTokens:2,totalTokens:3}:null,provider:"openai",model:policy.model,providerRequestId:null,responseHash:null,observedAt:"2026-10-07T00:00:00Z",billing:evidence==="recorded_billing"?{status:"recorded",confirmedMicrousd:0}:{status:"unknown",confirmedMicrousd:null},artifactHash:null}});
 expect((await f.run()).status).toBe("needs_reconciliation");expect(f.deps.recordResponse).toHaveBeenCalledTimes(1);expect(f.deps.publish).not.toHaveBeenCalled();
});
