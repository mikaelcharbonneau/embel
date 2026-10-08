import { expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { createLogoWorkerRuntime } from "../../worker/logo-runtime";
import { createChatGPTDirectionsProvider } from "@/server/ai/chatgpt-directions";
import type { ChatGPTTransport } from "@/server/ai/chatgpt-transport";
import type { LogoWorkerConnection } from "@/server/data/logo-jobs";
import type { IdentityAssetStore } from "@/server/data/identity-asset-store";
import type { LogoProviderObservation } from "@/domain/logo-jobs";
import { subscriptionFixture } from "../features/identity-directions/subscription-fixtures";
import { id } from "../features/identity-directions/fixtures";
function fixture(mode:"completed"|"oversized_input"|"wrong_account_oversized"|"unverified_dispatch"="completed"){
 const {job,policy,input,candidate}=subscriptionFixture(),events:string[]=[],observations:LogoProviderObservation[]=[];
 if(mode==="oversized_input")input.logo.components[0]!.paths[0]!.d="M 0 0 "+"L 1 1 ".repeat(23000);
 if(mode==="wrong_account_oversized")policy.limits.maxStreamBytes=1024;
 const row={id:job.id,owner_id:job.ownerId,project_id:job.projectId,operation:job.operation,input:job.input,input_revision:job.inputRevision,lease_token:job.leaseToken,state:job.status,reserved_cost_microusd:0,actual_cost_microusd:0};
 const completions:unknown[][]=[];
 const query=vi.fn(async(sql:string,parameters?:unknown[])=>{
  if(sql.includes("report_logo_worker_ready")){events.push("report");return{rows:[{value:true}]};}
  if(sql.includes("expire_logo_job_leases"))return{rows:[{value:0}]};
  if(sql.includes("claim_logo_job")||sql.includes("heartbeat_logo_job"))return{rows:[row]};
  if(sql.includes("runtime_readiness")){events.push("lease-check");return{rows:[{value:true}]};}
  if(sql.includes("begin_logo_job_step"))return{rows:[{value:"started"}]};
  if(sql.includes("complete_logo_job_step")){completions.push(parameters!);events.push("complete");}
  if(sql.includes("finish_logo_job"))events.push("finish");return{rows:[]};
 });
 const transport:ChatGPTTransport={listModels:vi.fn(),streamResponse:vi.fn<ChatGPTTransport["streamResponse"]>(async(_r,options)=>{
  if(mode==="unverified_dispatch")return{status:"unavailable",partialText:"unverified partial",failure:{code:"stream_interrupted",providerCode:null,providerParam:null,httpStatus:null,bodyShape:"empty",requestId:null,responseId:null,dispatched:true,recovery:"manual_review"}};
  await options.beforeDispatch?.();expect(events.at(-1)).toBe("lease-check");events.push("provider");
  return{status:"completed",response:{id:"resp_fixture",status:"completed",model:policy.model,output:[{type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:JSON.stringify(candidate)}]}]},partialText:"",requestId:null,responseId:"resp_fixture",accountId:mode==="wrong_account_oversized"?"wrong":policy.registrationId};
 })};
 const provider=createChatGPTDirectionsProvider({transport,ownerId:job.ownerId,projectId:job.projectId,policy,expectedAccountId:policy.registrationId});
 const never=async():Promise<never>=>{throw Error("Unused local fixture");};
 const runtime=createLogoWorkerRuntime({connection:{query} as unknown as LogoWorkerConnection,workerId:"fixture-logo-worker",manifest:[{operation:"identity.logo_directions",policyIdentity:"b".repeat(64),handlerVersion:policy.handlerVersion,provider:"openai",model:policy.model,engine:null,maxCostMicrousd:0,billingMode:"chatgpt_subscription",policy}],composition:{concepts:null,refinements:null,vector:null,exports:null,unavailableReasons:{},directions:{provider,assets:{readLeasedAsset:never,publishLeasedAsset:never} as unknown as IdentityAssetStore,loadInput:async()=>input,assertReady:async()=>{},recordResponse:async(claim,observation)=>{events.push("record");observations.push(observation);return{...observation,id:id(94),ownerId:claim.ownerId,projectId:claim.projectId,jobId:claim.id,leaseToken:claim.leaseToken};},publish:async(claim,result)=>{events.push("publish");return{id:id(95),ownerId:claim.ownerId,projectId:claim.projectId,jobId:claim.id,inputHash:"a".repeat(64),directionIds:result.directions.map(d=>d.id) as [string,string,string],publicationState:"staged"};}}}});
 return{runtime,transport,events,completions,observations};
}
it("runs the concrete subscription adapter through injected logo readiness and the durable runner",async()=>{
 const f=fixture();expect(f.runtime.capabilities["identity.logo_concept"].status).toBe("unavailable");expect(await f.runtime.tick()).toBe("succeeded");expect(f.events).toEqual(["report","lease-check","lease-check","provider","record","publish","complete","finish"]);expect(f.transport.streamResponse).toHaveBeenCalledTimes(1);expect(f.completions[0]?.slice(3,5)).toEqual(["succeeded",0]);expect(f.completions[0]?.[6]).toBeNull();f.runtime.close();
});
it("settles proven oversized-input rejection cleanly without a provider receipt or an ambiguous reservation",async()=>{
 const f=fixture("oversized_input");expect(await f.runtime.tick()).toBe("failed");expect(f.transport.streamResponse).not.toHaveBeenCalled();expect(f.observations).toEqual([]);expect(f.events).toEqual(["report","lease-check","complete","finish"]);expect(f.completions[0]?.slice(3,5)).toEqual(["failed",0]);expect(JSON.parse(String(f.completions[0]?.[5]))).toEqual({error:"not_dispatched"});f.runtime.close();
});
it("never records zero API billing for an oversized completed envelope belonging to another account",async()=>{
 const f=fixture("wrong_account_oversized");expect(await f.runtime.tick()).toBe("needs_reconciliation");expect(f.observations[0]?.billing).toEqual({status:"unknown",confirmedMicrousd:null});expect(f.completions[0]?.[3]).toBe("ambiguous");expect(JSON.parse(String(f.completions[0]?.[5]))).toHaveProperty("result.payload");expect(f.events).not.toContain("publish");expect(f.events).not.toContain("finish");f.runtime.close();
});
it("retains contradictory unverified dispatched outcomes instead of accepting their unavailable label as proof of no dispatch",async()=>{
 const f=fixture("unverified_dispatch");expect(await f.runtime.tick()).toBe("needs_reconciliation");expect(f.observations[0]?.billing).toEqual({status:"unknown",confirmedMicrousd:null});expect(JSON.stringify(f.completions)).toContain("unverified partial");expect(f.events).not.toContain("publish");expect(f.events).not.toContain("finish");f.runtime.close();
});
