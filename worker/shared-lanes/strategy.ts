import { apiTextDispatchMessageSchema } from "../../src/domain/api-text-dispatch";
import { strategyJobPolicySchema,strategyOperationSchema, type StrategyOperation } from "../../src/domain/strategy-jobs";
import { isHostedStrategyPolicy } from "../../src/server/ai/config";
import { apiTextDispatchDatabase } from "../api-text-multi-account";
import { runApiTextDelivery } from "../api-text-runtime";
import type { OpenAIResponsesTransport } from "../../src/server/ai/openai-transport";
import { createOpenAIResponsesTransport } from "../../src/server/ai/openai-transport";
import { z } from "zod";
import { sharedPendingExecutionSchema,type SharedPendingExecution } from "../shared-pool/contracts";
import type { JobDatabase } from "../postgres-store";
import type { SharedLaneBase,SharedLaneEngine,SharedLaneResult } from "./contracts";
import { createSharedLaneGateway } from "./gateway";

/** Runs the actual admitted-message engine; no admission, policy inference or
 * paid model probe occurs while constructing this bounded slot adapter. */
export function createSharedStrategyLaneEngine(options:SharedLaneBase & {policies:Readonly<Record<string,unknown>>},dependencies:{transport?:OpenAIResponsesTransport}={}):SharedLaneEngine{
 const policies=new Map(Object.entries(options.policies).map(([operation,value])=>{
  const policy=strategyJobPolicySchema.parse(value);if(!isHostedStrategyPolicy(strategyOperationSchema.parse(operation),policy)||policy.model!==options.provider.model)throw Error("shared_strategy_policy_unavailable");
  return[operation as StrategyOperation,policy] as const;
 }));
 if(!policies.size||!options.provider.apiKey||!options.provider.modelVerificationReceipt)throw Error("shared_strategy_configuration_unavailable");
 const transport=dependencies.transport??createOpenAIResponsesTransport({apiKey:options.provider.apiKey});
 const stop=new AbortController();let active:Promise<unknown>|null=null,closed=false,unconfirmed=false;
 return Object.freeze({async run(raw?:unknown,signal?:AbortSignal):Promise<SharedLaneResult>{
  if(unconfirmed)throw Error("shared_strategy_drain_unconfirmed");
  if(closed||active||signal?.aborted)return{disposition:"retry",state:"stopping"};
  const parsed=apiTextDispatchMessageSchema.safeParse(raw);if(!parsed.success)return{disposition:"ack",state:"invalid_message"};
  const message=parsed.data,combined=AbortSignal.any([stop.signal,...signal?[signal]:[]]);
  const gateway=createSharedLaneGateway({...options,lane:"strategy",message,expectedJobId:message.jobId,signal:combined});
  const source:JobDatabase={async query(sql,values=[]){
   if(sql!=="select public.api_text_dispatch_action($1::jsonb,$2,$3::jsonb) as result"||values.length!==3
    ||typeof values[0]!=="string"||values[0]!==JSON.stringify(message)||typeof values[1]!=="string"||typeof values[2]!=="string")throw Error("shared_strategy_query_unavailable");
   const action=values[1],observation=["complete","finish","step","has_results"].includes(action);
   let result:unknown;
   try{result=await gateway.invoke(action,JSON.parse(values[2]),observation);}
   catch(error){
    if(action!=="heartbeat"||!gateway.execution())throw error;
    const args=JSON.parse(values[2]);if(!Array.isArray(args)||args[0]!==gateway.execution()!.leaseToken)throw error;
    result=await gateway.invoke("observe_status",[args[0]],true);
   }
   return{rows:[{result}]};
  }};
  const pending=new Set<Promise<unknown>>();
  const run=(async()=>{
   const result=await runApiTextDelivery({message,database:apiTextDispatchDatabase(source,message),configuration:{apiKey:options.provider.apiKey,policies},
    deploymentId:options.deploymentId,signal:combined,multiAccount:false,transport,
    observeStepOutcome:{async record(job,key,outcome){gateway.assertJob(job.id,job.leaseToken,job.ownerId,job.projectId);
      if(await gateway.invoke("observe_outcome",[job.leaseToken,key,outcome],true)!==true)throw Error("shared_strategy_observation_unconfirmed");},
     track(execution){pending.add(execution);void execution.then(()=>pending.delete(execution),()=>{unconfirmed=true;pending.delete(execution);});}}});
   // A runner result is not a quiescence proof. Keep the slot locally busy until
   // every actual issued handler future and its independent journal settle.
   await Promise.allSettled([...pending]);await gateway.drain();if(unconfirmed)throw Error("shared_strategy_drain_unconfirmed");return result;
  })();
  active=run;try{return await run;}finally{active=null;}
 },async recover(pending:readonly SharedPendingExecution[],signal?:AbortSignal):Promise<SharedLaneResult>{
  if(unconfirmed)throw Error("shared_strategy_drain_unconfirmed");
  if(closed||active||signal?.aborted)return{disposition:"retry",state:"stopping"};
  const rows=z.array(sharedPendingExecutionSchema).max(25).parse(pending),combined=AbortSignal.any([stop.signal,...signal?[signal]:[]]);
  const execute=async()=>{let retained=0,attempted=0;
   for(const row of rows){
    if(combined.aborted||attempted>=3)break;
    if(row.execution.lane!=="strategy"||row.execution.deploymentId!==options.deploymentId)continue;
    const gateway=createSharedLaneGateway({...options,lane:"strategy",message:null,observationExecution:row.execution});
    const known=z.array(z.strictObject({stepKey:z.string().min(1).max(100),responseId:z.string().regex(/^resp_[A-Za-z0-9_-]{1,195}$/u)})).max(25)
     .parse(await gateway.invoke("recovery",[],true));
    if(!transport.retrieveResponse)continue;
    for(const handle of known){
     if(combined.aborted||attempted>=3)break;attempted++;
     // Only a response ID independently selected from durable issued evidence
     // reaches GET. Request-header IDs never become retrieval capabilities.
     const observed=await transport.retrieveResponse(handle.responseId,AbortSignal.any([combined,AbortSignal.timeout(10_000)]));
     let saved:unknown;
     try{saved=await gateway.invoke("observe_response",[row.execution.leaseToken,handle.stepKey,handle.responseId,observed],true);}
     catch{unconfirmed=true;throw Error("shared_strategy_observation_unconfirmed");}
     if(saved===true)retained++;else if(saved!==false){unconfirmed=true;throw Error("shared_strategy_observation_unconfirmed");}
    }
    await gateway.drain();
   }
   return{disposition:"retry" as const,state:retained?"observation_retained":"retained_unsupported"};
  };
  const run=execute();active=run;try{return await run;}finally{active=null;}
 },async close(){closed=true;stop.abort();await active;if(unconfirmed)throw Error("shared_strategy_drain_unconfirmed");}});
}
