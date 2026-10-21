import { createHash } from "node:crypto";
import { z } from "zod";
import type { ApiTextDispatchMessage } from "../src/domain/api-text-dispatch";
import { strategyJobInputSchema, strategyOperationSchema } from "../src/domain/strategy-jobs";
import { stepOutcomeSchema, type StepOutcome } from "../src/domain/jobs";
import type { OpenAIStrategyConfiguration } from "../src/server/ai/config";
import type { OpenAIResponsesTransport } from "../src/server/ai/openai-transport";
import { evaluateStrategyResponse, prepareStrategyResponse } from "../src/server/ai/strategy-response";
import { ApiTextBackgroundJournal, backgroundControl } from "./api-text-background-journal";
import { observeBackgroundResponse } from "./strategy-background-response";
import { createOpenAIStrategyHandlers } from "./handlers/openai-strategy";
import { ApiTextJobStore } from "./api-text-store";
import { parseClaimedJob, type JobDatabase } from "./postgres-store";

export { backgroundControl } from "./api-text-background-journal";

export async function runBackgroundApiTextDelivery(options:{
 database:JobDatabase; scopedDatabase:JobDatabase; message:ApiTextDispatchMessage;
 configuration:OpenAIStrategyConfiguration; transport:OpenAIResponsesTransport; signal:AbortSignal;
}):Promise<{disposition:"ack"|"retry";state:string}> {
 const {database,scopedDatabase,message,configuration,transport}=options;
 const signal=AbortSignal.any([options.signal,AbortSignal.timeout(45000)]);
 const claimed=z.object({disposition:z.enum(["claimed","busy","terminal","unavailable","not_found"]),state:z.string(),job:z.unknown().optional()})
  .parse(await backgroundControl(database,message,"claim",`background-${crypto.randomUUID()}`));
 if(claimed.disposition!=="claimed")return {disposition:claimed.disposition==="terminal"||claimed.disposition==="not_found"?"ack":"retry",state:claimed.state};
 const job=parseClaimedJob(claimed.job);
 if(job.id!==message.jobId || !["running","cancel_requested"].includes(job.status))throw new Error("Background claim mismatch");
 const input=strategyJobInputSchema.parse(job.input),operation=strategyOperationSchema.parse(job.operation);
 const store=new ApiTextJobStore(scopedDatabase,message,message.deploymentId,operation);
 // Reuse validation and immutable step identity, not the synchronous executor.
 const handler=createOpenAIStrategyHandlers(configuration,transport).get(operation);
 const steps=handler?.steps(job);
 if(!steps || steps.length!==1)throw new Error("Background strategy plan unavailable");
 const step=steps[0]!;
 const metadata=await scopedDatabase.query("select state, request_key, reserved_cost_microusd from public.job_steps where job_id = $1 and owner_id = $2 and project_id = $3 and step_key = $4",[job.id,job.ownerId,job.projectId,step.key]);
 const existing=metadata.rows[0];
 const expectedKey=createHash("sha256").update(`${job.id}:${step.key}`).digest("hex");
 if(existing && (existing.request_key!==expectedKey || Number(existing.reserved_cost_microusd)!==step.maximumCostMicrousd))throw new Error("Background step mismatch");
 if(existing && ["succeeded","failed"].includes(String(existing.state))){
  const final=job.status==="cancel_requested"?"cancelled":existing.state as "succeeded"|"failed";
  await store.finish(job,final);return {disposition:"ack",state:final};
 }
 if(existing && existing.state!=="in_flight")return {disposition:"ack",state:"needs_reconciliation"};
 if(!existing){
  // A cancellation before any step was issued has no provider side effect.
  // Resuming an existing step must not re-register a plan: the SQL plan writer
  // intentionally refuses new plans once cancellation is requested.
  if(job.status==="cancel_requested"){
   await store.finish(job,"cancelled");return {disposition:"ack",state:"cancelled"};
  }
  await store.registerPlan(job,[{key:step.key,maximumCostMicrousd:step.maximumCostMicrousd}]);
  await store.beginStep(job,step.key,step.maximumCostMicrousd);
 }
 const journal=new ApiTextBackgroundJournal(database,message,{jobId:job.id,leaseToken:job.leaseToken,stepKey:step.key});
 const state=await journal.load();
 let outcome:StepOutcome|undefined;
 let request:Record<string,unknown>={},requestKey="observation-only";
 if(state.dispatchState==="not_dispatched" && !state.cancelRequested){
  const prepared=await prepareStrategyResponse({job,operation,input,transport,signal,beforeDispatch:()=>store.authorizeDispatch(job,step.key)});
  if(prepared.kind==="failure")outcome=prepared.outcome;
  else {request=prepared.request;requestKey=prepared.requestKey;}
 }
 if(!outcome){
  const result=await observeBackgroundResponse({journal,provider:transport,request,requestKey,signal,pollWindowMs:15000});
  if(result.kind==="pending"){
   // Keep the job running/cancel_requested and its reservation intact. Another
   // observer can claim the expired lease but cannot create a second response.
   await backgroundControl(database,message,"yield",job.leaseToken);
   return {disposition:"retry",state:"background_observing"};
  }
  if(result.kind==="terminal")outcome=evaluateStrategyResponse({job,operation,input,raw:result.response});
  else if(result.kind==="not_dispatched")outcome={status:"failed",code:`background_${result.reason}`,costMicrousd:0,providerRequestId:null};
  else outcome={status:"needs_reconciliation",code:`background_${result.reason}`,costMicrousd:0,providerRequestId:result.responseId};
 }
 outcome=stepOutcomeSchema.parse(outcome);
 if(outcome.costMicrousd>step.maximumCostMicrousd || job.actualCostMicrousd+outcome.costMicrousd>job.reservedCostMicrousd){
  outcome={...outcome,status:"needs_reconciliation",code:"provider_cost_exceeded"};
 }
 await store.completeStep(job,step.key,outcome);
 if(outcome.status==="needs_reconciliation")return {disposition:"ack",state:"needs_reconciliation"};
 const cancellation=(await store.heartbeat(job,60)).cancelled;
 const final=cancellation?"cancelled":outcome.status;
 await store.finish(job,final);
 return {disposition:"ack",state:final};
}
