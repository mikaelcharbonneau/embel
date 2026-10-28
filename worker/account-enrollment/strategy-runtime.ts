import "server-only";
import { z } from "zod";
import type { OwnerWorkerProcessDescriptor } from "./adapter";
import type { OwnerWorkerArtifactAttestation,OwnerWorkerDatabaseSecret,OwnerWorkerProviderSecret,OwnerWorkerReadyNotice } from "./process-contracts";
import { assertOwnerWorkerArtifact,createOwnerWorkerPool,qualifyOwnerWorkerPool } from "./process-qualification";
import { strategyOperations } from "./configuration";
import { strategyJobPolicySchema,type StrategyOperation } from "../../src/domain/strategy-jobs";
import { apiTextDispatchMessageSchema } from "../../src/domain/api-text-dispatch";
import { isHostedStrategyPolicy } from "../../src/server/ai/config";
import { createApiTextReadiness } from "../handlers/openai-readiness";
import { runApiTextDelivery,type ApiTextDeliveryResult } from "../api-text-runtime";
import type { JobDatabase } from "../postgres-store";
import { isOwnerWorkerObservationStatement,queryOwnerWorkerObservation } from "./observation";

export type OwnerStrategyRuntimeSecrets=Readonly<{database:OwnerWorkerDatabaseSecret;provider:OwnerWorkerProviderSecret;
 policies:Readonly<Record<string,unknown>>;attestation:OwnerWorkerArtifactAttestation}>;
const unavailable=()=>Error("owner_strategy_runtime_unavailable");
/** Existing admitted-message engine. No job admission, automatic redelivery,
 * provider probe or new financial policy is introduced by startup. */
export async function startOwnerStrategyRuntime(options:{descriptor:OwnerWorkerProcessDescriptor;secrets:OwnerStrategyRuntimeSecrets;
 signal:AbortSignal;onReady?:(notice:OwnerWorkerReadyNotice)=>void|Promise<void>}) {
 const{descriptor,secrets}=options,profile=descriptor.profile,stopped=new AbortController(),signal=AbortSignal.any([options.signal,stopped.signal]);
 assertOwnerWorkerArtifact(descriptor,secrets.attestation);
 if(profile.capability!=="strategy"||profile.admissionContract!=="hosted_strategy_owner_uncapped_v1"||profile.spendControl!=="uncapped"
  ||secrets.provider.model!==profile.model||secrets.provider.modelVerificationReceipt!==profile.modelVerificationReceipt
  ||!z.string().min(16).max(500).regex(/^\S+$/u).safeParse(secrets.provider.apiKey).success
  ||Object.keys(secrets.policies).length!==strategyOperations.length)throw unavailable();
 const policyIdentities=profile.policyIdentities;
 const policies=new Map(strategyOperations.map(operation=>{
  const policy=strategyJobPolicySchema.parse(secrets.policies[operation]);
  if(!isHostedStrategyPolicy(operation,policy)||policy.model!==profile.model)throw unavailable();return[operation,policy] as const;
 }));
 const pool=createOwnerWorkerPool(descriptor,secrets.database),pending=new Set<Promise<unknown>>();let closed=false;
 const heartbeatTimer:{value?:ReturnType<typeof setInterval>}={};let heartbeat:Promise<void>|undefined;
 const database:JobDatabase={async query(sql,values=[]){
  if(isOwnerWorkerObservationStatement(sql))return queryOwnerWorkerObservation(pool,descriptor,sql,values);
  signal.throwIfAborted();if(closed)throw unavailable();
  const fixed=sql.replace(/\s+/gu," ").trim();
  if(fixed==="select state, request_key, reserved_cost_microusd from public.job_steps where job_id = $1 and owner_id = $2 and project_id = $3 and step_key = $4"){
   if(values.length!==4)throw unavailable();return pool.query("SELECT * FROM public.read_account_worker_strategy_step($1,$2,$3,$4)",values);
  }
  if(fixed==="select exists(select 1 from public.job_steps where job_id=$1 and owner_id=$2 and project_id=$3 and state='succeeded') as has_results"){
   if(values.length!==3)throw unavailable();return pool.query("SELECT public.account_worker_strategy_has_results($1,$2,$3) AS has_results",values);
  }
  return pool.query(sql,values);
 }};
 async function qualify() {
  await qualifyOwnerWorkerPool(pool,descriptor,signal);
  for(const[operation,policy]of policies){
   const hash=await pool.query("SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') value",[JSON.stringify(policy)]);
   if(hash.rows[0]?.value!==policyIdentities[operation])throw unavailable();
   await createApiTextReadiness(database,descriptor.binding.deploymentId)(operation,policy);
  }
  const pulse=await pool.query("SELECT public.report_account_worker_heartbeat($1::jsonb,NULL) value",[JSON.stringify(descriptor.binding)]);
  if(pulse.rows.length!==1||pulse.rows[0]?.value!==true)throw unavailable();
 }
 async function close(){closed=true;stopped.abort();clearInterval(heartbeatTimer.value);await heartbeat?.catch(()=>{});await Promise.allSettled([...pending]);await pool.end();}
 try{await qualify();signal.throwIfAborted();await options.onReady?.({workerId:descriptor.binding.workerId,roleOid:descriptor.binding.roleOid,observedAt:new Date().toISOString(),storageSessionId:null});}
 catch{await close();throw unavailable();}
 heartbeatTimer.value=setInterval(()=>{if(heartbeat||closed||signal.aborted)return;
  heartbeat=qualify().catch(()=>{stopped.abort();clearInterval(heartbeatTimer.value);}).finally(()=>{heartbeat=undefined;});},15_000);heartbeatTimer.value.unref();
 return Object.freeze({
  async deliver(raw:unknown):Promise<ApiTextDeliveryResult>{
   if(closed||signal.aborted)return{disposition:"retry",state:"stopping"};
   const message=apiTextDispatchMessageSchema.parse(raw);
   if(message.deploymentId!==descriptor.binding.deploymentId||!Object.values(policyIdentities).includes(message.policyIdentity))throw unavailable();
   await qualify();
   // Restricted principal SQL derives the owner. The payload has no owner selector.
   const run=runApiTextDelivery({message,database,configuration:{apiKey:secrets.provider.apiKey,policies:policies as ReadonlyMap<StrategyOperation,z.infer<typeof strategyJobPolicySchema>>},
    deploymentId:descriptor.binding.deploymentId,signal,multiAccount:false});
   pending.add(run);try{return await run;}finally{pending.delete(run);}
  },close,
 });
}
