import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { JobDatabase } from "../postgres-store";
import type { SharedSlotLease, SharedExecution } from "../shared-pool/contracts";

const executionSchema = z.strictObject({version:z.literal(1),executionId:z.uuid(),executionToken:z.uuid(),slotId:z.uuid(),instanceId:z.uuid(),
 generation:z.number().int().positive(),lane:z.enum(["strategy","naming","logo"]),ownerId:z.uuid(),projectId:z.uuid(),jobId:z.uuid(),leaseToken:z.uuid(),
 operation:z.string().min(1).max(100),policyIdentity:z.string().regex(/^[a-f0-9]{64}$/u),deploymentId:z.string().min(1).max(200)});
const envelopeSchema=z.strictObject({execution:executionSchema.nullable(),result:z.unknown()});
const unavailable=()=>new Error("shared_lane_authority_unavailable");
const uncertainDelivery=(error:unknown)=>{
 const code=error&&typeof error==="object"&&"code" in error?String(error.code):null;
 return code===null||["ECONNRESET","ECONNREFUSED","ETIMEDOUT","EPIPE","ENETUNREACH","EHOSTUNREACH"].includes(code);
};

/** One facade per execution. A reusable database connection never supplies
 * ambient tenant authority, and an unrecognized query never reaches SQL. */
export function createSharedLaneGateway(options:{database:JobDatabase;slot:()=>SharedSlotLease|null;lane:"strategy"|"naming"|"logo";deploymentId:string;
 message?:unknown;expectedJobId?:string;signal?:AbortSignal;observationExecution?:SharedExecution}) {
 let execution:SharedExecution|null=options.observationExecution?Object.freeze(executionSchema.parse(options.observationExecution)):null;
 let capturedSlot:SharedSlotLease|null=execution?options.slot():null;
 if(execution&&(!capturedSlot||capturedSlot.lane!==options.lane||capturedSlot.slotId!==execution.slotId))throw unavailable();
 if(capturedSlot)capturedSlot=Object.freeze({...capturedSlot});
 let tail:Promise<unknown>=Promise.resolve();
 async function invoke(action:string,args:unknown,observation=false):Promise<unknown>{
  const run=tail.then(async()=>{
   if(options.observationExecution&&!observation)throw unavailable();
   if(!observation)options.signal?.throwIfAborted();
   const slot=execution?capturedSlot:options.slot();
   if(!slot||slot.lane!==options.lane)throw unavailable();
   if(execution&&!observation){const current=options.slot();if(!current||current.slotId!==slot.slotId||current.instanceId!==slot.instanceId
    ||current.generation!==slot.generation||current.leaseToken!==slot.leaseToken)throw unavailable();}
   const parameters=options.lane==="strategy"?{message:options.message,values:args}:args;
   const sql=`select public.shared_${options.lane}_worker_action($1::jsonb,$2::jsonb,$3,$4::jsonb) as envelope`;
   const values=[JSON.stringify(slot),execution===null?null:JSON.stringify(execution),action,JSON.stringify(parameters)];
   let result:Awaited<ReturnType<JobDatabase["query"]>>;
   try{result=await options.database.query(sql,[...values]);}
   catch(error){
    // A Logo receipt is immutable and SQL revalidates its exact execution on
    // replay. Retain the same timestamp/body while its image bytes still exist.
    // Retry only delivery uncertainty, never claim/dispatch or an acknowledged
    // rejection. Validate returned authority below, outside this retry boundary.
    if(options.lane!=="logo"||action!=="receipt"||!execution||!["identity.logo_concept","identity.logo_refine"].includes(execution.operation)
     ||!observation||options.signal?.aborted||!uncertainDelivery(error))throw error;
    await delay(250,undefined,{signal:options.signal});options.signal?.throwIfAborted();
    result=await options.database.query(sql,[...values]);
   }
   if(result.rows.length!==1)throw unavailable();
   const response=envelopeSchema.parse(result.rows[0]?.envelope);
   if(response.execution){const e=response.execution;
    if(e.lane!==options.lane||e.slotId!==slot.slotId||!options.observationExecution&&(e.instanceId!==slot.instanceId||e.generation!==slot.generation)
      ||e.deploymentId!==options.deploymentId||options.expectedJobId!==undefined&&e.jobId!==options.expectedJobId
      ||execution!==null&&!isDeepStrictEqual(e,execution))throw unavailable();
    if(!execution){
     if(action!=="claim")throw unavailable();
     const raw=options.lane==="logo"?(Array.isArray(response.result)?response.result[0]:null)
      :response.result&&typeof response.result==="object"&&!Array.isArray(response.result)?(response.result as Record<string,unknown>).job:null;
     const job=z.object({id:z.uuid(),owner_id:z.uuid(),project_id:z.uuid(),lease_token:z.uuid(),operation:z.string()}).parse(raw);
     if(job.id!==e.jobId||job.owner_id!==e.ownerId||job.project_id!==e.projectId||job.lease_token!==e.leaseToken||job.operation!==e.operation)throw unavailable();
     if(options.lane==="strategy"){
      const authority=z.object({contract:z.literal("hosted_strategy_shared_uncapped_v1"),jobId:z.uuid(),ownerId:z.uuid(),projectId:z.uuid(),leaseToken:z.uuid(),
       roleOid:z.number().int().positive(),generation:z.number().int().positive(),slotId:z.uuid(),instanceId:z.uuid(),executionId:z.uuid(),executionToken:z.uuid(),policyIdentity:z.string()})
       .parse((response.result as Record<string,unknown>).executionAuthority);
      if(authority.jobId!==e.jobId||authority.ownerId!==e.ownerId||authority.projectId!==e.projectId||authority.leaseToken!==e.leaseToken
       ||authority.roleOid!==slot.roleOid||authority.generation!==e.generation||authority.slotId!==e.slotId||authority.instanceId!==e.instanceId
       ||authority.executionId!==e.executionId||authority.executionToken!==e.executionToken||authority.policyIdentity!==e.policyIdentity)throw unavailable();
     }
     execution=Object.freeze(e);capturedSlot=Object.freeze({...slot});
    }
   }else if(execution)throw unavailable();
   return response.result;
  });
  tail=run.then(()=>undefined,()=>undefined);return run;
 }
 return Object.freeze({invoke,execution:()=>execution,
  assertJob(jobId:unknown,leaseToken?:unknown,ownerId?:unknown,projectId?:unknown){
   if(!execution||jobId!==execution.jobId||leaseToken!==undefined&&leaseToken!==execution.leaseToken
    ||ownerId!==undefined&&ownerId!==execution.ownerId||projectId!==undefined&&projectId!==execution.projectId)throw unavailable();
  },async drain(){await tail;}});
}
