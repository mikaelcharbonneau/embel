import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { namingBrainJobInputSchema,namingBrainPolicySchema,type NamingBrainPolicy } from "../../src/domain/naming-brain";
import { getNamingPreferencesReadiness,namingPreferencesV2Schema } from "../../src/domain/naming-brain-preferences";
import { namingPreferencesRuntimeFingerprint } from "../naming-brain-configuration";
import type { ClaimedJob } from "../../src/domain/jobs";
import { NamingBrainJobStore,namingLatestReceipt,normalizeNamingStoredJson } from "../naming-brain-store";
import { createNamingBrainHandlers } from "../handlers/naming-brain";
import { runOneJob } from "../runner";
import { parseClaimedJob,type JobDatabase } from "../postgres-store";
import { sharedPendingExecutionSchema,type SharedPendingExecution } from "../shared-pool/contracts";
import { createNamingAgentRuntime } from "../../src/server/ai/naming-brain/transport";
import type { NamingManagedProtocol } from "../../src/server/ai/naming-brain/protocol";
import type { createNamingReferenceReader } from "../../src/server/ai/naming-brain/source-reader";
import type { SharedLaneBase,SharedLaneEngine,SharedLaneResult } from "./contracts";
import { createSharedLaneGateway } from "./gateway";
import { NAMING_BRAINSTORM_PROFILE } from "../../src/domain/naming-brainstorm";
import { createNamingBrainstormProvider, type NamingBrainstormProvider } from "../../src/server/ai/naming-brainstorm-provider";
import { observeNamingBrainstorm, runNamingBrainstorm } from "../naming-brainstorm";

const unavailable=()=>Error("shared_naming_authority_unavailable");
const terminal=new Set(["succeeded","failed","partial","cancelled","needs_reconciliation"]);
/** Existing durable Naming engine, one SQL-selected job per slot turn. The
 * frozen job still carries its historical input; shared SQL authority is new. */
export function createSharedNamingLaneEngine(options:SharedLaneBase & {policy:NamingBrainPolicy},dependencies:{protocol?:NamingManagedProtocol;referenceReader?:ReturnType<typeof createNamingReferenceReader>;brainstormProvider?:NamingBrainstormProvider}={}):SharedLaneEngine{
 const policy=namingBrainPolicySchema.parse(options.policy);
 if(policy.model!==options.provider.model||!options.provider.apiKey||!options.provider.modelVerificationReceipt)throw unavailable();
 const stop=new AbortController();let active:Promise<unknown>|null=null,closed=false,unconfirmed=false;
 return Object.freeze({async run(message?:unknown,signal?:AbortSignal):Promise<SharedLaneResult>{
  if(message!==undefined)throw unavailable();
  if(unconfirmed)throw Error("shared_naming_drain_unconfirmed");
  if(closed||active||signal?.aborted)return{disposition:"retry",state:"stopping"};
  const combined=AbortSignal.any([stop.signal,...signal?[signal]:[]]);
  const gateway=createSharedLaneGateway({...options,lane:"naming",signal:combined});
  const database:JobDatabase={async query(sql,values=[]){
   const normalized=sql.replace(/\s+/gu," ").trim();
   const expected=/^select public\.(claim_naming_brain_job|naming_brain_worker_action|authorize_naming_brain_dispatch|record_naming_brain_provider_receipt|complete_naming_brain_stage)\((\$[1-9][0-9]*(?:,\$[1-9][0-9]*)*)\) as result$/u.exec(normalized);
   if(!expected||expected[2]!==values.map((_,i)=>`$${i+1}`).join(","))throw unavailable();
   const name=expected[1];let action:string,observation=false;
   if(name==="claim_naming_brain_job"){
    if(values.length!==3||values[0]!==options.workerId||values[1]!==options.deploymentId)throw unavailable();action="claim";
   }else{
    gateway.assertJob(values[0],values[1]);
    if(name==="naming_brain_worker_action"){
     if(values.length!==4||typeof values[2]!=="string"||typeof values[3]!=="string")throw unavailable();
     action="action";observation=["heartbeat","stage","progressive_state","provider_item","provider_turn","tool_result","artifact","finish"].includes(values[2]);
    }else if(name==="authorize_naming_brain_dispatch"){if(values.length!==3)throw unavailable();action="authorize";}
    else if(name==="record_naming_brain_provider_receipt"){if(values.length!==3)throw unavailable();action="receipt";observation=true;}
    else{if(values.length!==5)throw unavailable();action="complete";observation=true;}
   }
   return{rows:[{result:await gateway.invoke(action,values,observation)}]};
  }};
  class SharedNamingStore extends NamingBrainJobStore{
   override async claim(workerId:string,seconds:number){
    const job=await super.claim(workerId,seconds);if(!job)return null;
    gateway.assertJob(job.id,job.leaseToken,job.ownerId,job.projectId);
    const input=namingBrainJobInputSchema.parse(job.input),execution=gateway.execution();
    if(this.executionAuthority(job)!=="shared_slot_v1"||input.providerBudgetVersion!==2||input.localPipelineVersion!==2||input.localTimingVersion!==2
     ||input.acceptedPolicyIdentity!==execution?.policyIdentity||input.policy.model!==options.provider.model)throw unavailable();return job;
   }
   override async assertContinuation(job:ClaimedJob){await super.assertContinuation(job);
    if(await gateway.invoke("assert_continue",[job.id,job.leaseToken])!==true)throw unavailable();}
  }
  const pending=new Set<Promise<unknown>>();
  const assertReady=async()=>{combined.throwIfAborted();if(await gateway.invoke("assert_continue",[])!==true)throw unavailable();};
  const store=new SharedNamingStore(database,options.deploymentId),handlers=createNamingBrainHandlers({store,apiKey:options.provider.apiKey,assertReady,
   runtime:(job,input)=>{
    const runtime=createNamingAgentRuntime({apiKey:options.provider.apiKey,model:input.policy.model,localPrototype:store.hasUnmeteredExecutionAuthority(job),
     persistence:store.runtimePersistence(job),assertContinuation:async()=>{await assertReady();await store.assertContinuation(job);},...dependencies});
    return{...runtime,runStage(...args:Parameters<typeof runtime.runStage>){const execution=runtime.runStage(...args);pending.add(execution);
     void execution.then(()=>pending.delete(execution),()=>{unconfirmed=true;pending.delete(execution);});return execution;}};
   }});
  const run=(async()=>{
   const fingerprint=namingPreferencesRuntimeFingerprint();
   if(await gateway.invoke("qualify",[policy,fingerprint])!==true)throw unavailable();
   const preferences=z.array(z.strictObject({ownerId:z.uuid(),projectId:z.uuid(),preferencesVersion:z.number().int().positive(),preferencesHash:z.string(),
    preferences:z.unknown(),expectedFingerprint:z.unknown()})).max(20).parse(await gateway.invoke("preference_work",[20]));
   for(const row of preferences){
    if(!isDeepStrictEqual(row.expectedFingerprint,fingerprint))throw unavailable();
    const parsed=namingPreferencesV2Schema.safeParse(row.preferences);
    const readiness=parsed.success&&isDeepStrictEqual(parsed.data,row.preferences)?getNamingPreferencesReadiness(parsed.data):{ready:false,missing:["invalid_preferences"]};
    await gateway.invoke("attest_preferences",[row.projectId,row.preferencesVersion,row.preferencesHash,fingerprint,readiness]);
   }
   // Claim once under the existing SQL authority, then select only the exact new
   // immutable profile. Historical jobs keep the established handler unchanged.
   const job=await store.claim(options.workerId,120);
   let state:string;
   if(job&&namingBrainJobInputSchema.parse(job.input).generationProfile===NAMING_BRAINSTORM_PROFILE){
    const input=namingBrainJobInputSchema.parse(job.input);
    state=await runNamingBrainstorm({gateway,input,job,signal:combined,
     provider:dependencies.brainstormProvider??createNamingBrainstormProvider({apiKey:options.provider.apiKey}),
     heartbeat:()=>store.heartbeat(job,120),assertContinuation:()=>store.assertContinuation(job)});
   }else{
    const originalClaim=store.claim.bind(store);let selected=true;
    store.claim=async()=>{if(selected){selected=false;return job;}return originalClaim(options.workerId,120);};
    state=await runOneJob({store,handlers,workerId:options.workerId,signal:combined,abortGraceMs:15_000});
   }
   await Promise.allSettled([...pending]);if(unconfirmed)throw Error("shared_naming_drain_unconfirmed");return state;
  })();active=run;
  try{const state=await run;return{disposition:state==="idle"||terminal.has(state)?"ack":"retry",state};}
  finally{await gateway.drain();active=null;}
 },async recover(pending:readonly SharedPendingExecution[],signal?:AbortSignal):Promise<SharedLaneResult>{
  if(unconfirmed)throw Error("shared_naming_drain_unconfirmed");
  if(closed||active||signal?.aborted)return{disposition:"retry",state:"stopping"};
  const rows=z.array(sharedPendingExecutionSchema).max(25).parse(pending),combined=AbortSignal.any([stop.signal,...signal?[signal]:[]]);
  const execute=async()=>{let retained=0,attempted=0;
   for(const row of rows){
    if(combined.aborted||attempted>=3)break;
    // A current slot may observe the exact original execution without
    // rewriting its admitted deployment or obtaining active authority.
    if(row.execution.lane!=="naming")continue;
    const historical=row.execution.deploymentId!==options.deploymentId;
    // The pending page grants no profile upgrade. Only an exact brainstorm
    // input may select cross-deployment observation; the recovered SQL job is
    // checked again before any provider access. Legacy same-DPL recovery stays exact.
    if(historical&&!/^dpl_[A-Za-z0-9_-]{8,196}$/u.test(row.execution.deploymentId))continue;
    const pendingInput=historical?namingBrainJobInputSchema.safeParse(normalizeNamingStoredJson(row.job.input)):null;
    if(historical&&(!pendingInput?.success||pendingInput.data.generationProfile!==NAMING_BRAINSTORM_PROFILE))continue;
    const gateway=createSharedLaneGateway({...options,lane:"naming",observationExecution:row.execution,
     ...(historical?{observationGenerationProfile:NAMING_BRAINSTORM_PROFILE}:{})});
    const view=z.strictObject({observationJob:z.record(z.string(),z.unknown()),observationLeaseToken:z.uuid()})
     .parse(await gateway.invoke("recover",[],true));
    if(view.observationLeaseToken!==row.execution.leaseToken)throw unavailable();
    // This is an explicitly historical observation handle, never a claim or an
    // active lease. Current state/input stay exactly as returned by SQL.
    const job=parseClaimedJob(normalizeNamingStoredJson({...view.observationJob,lease_token:view.observationLeaseToken}));
    gateway.assertJob(job.id,job.leaseToken,job.ownerId,job.projectId);
    const input=namingBrainJobInputSchema.parse(job.input);
    if(historical&&input.generationProfile!==NAMING_BRAINSTORM_PROFILE)continue;
    if(input.policy.model!==options.provider.model||input.providerBudgetVersion!==2||input.acceptedPolicyIdentity!==row.execution.policyIdentity)continue;
    if(input.generationProfile===NAMING_BRAINSTORM_PROFILE){
     attempted++;
     try{retained+=await observeNamingBrainstorm({gateway,input,
      provider:dependencies.brainstormProvider??createNamingBrainstormProvider({apiKey:options.provider.apiKey}),
      signal:AbortSignal.any([combined,AbortSignal.timeout(180_000)])});}
     catch{unconfirmed=true;throw Error("shared_naming_observation_unconfirmed");}
     await gateway.drain();continue;
    }
    const database:JobDatabase={async query(sql,values=[]){
     const match=/^select public\.(naming_brain_worker_action|record_naming_brain_provider_receipt)\((\$[1-9][0-9]*(?:,\$[1-9][0-9]*)*)\) as result$/u.exec(sql);
     if(!match||match[2]!==values.map((_,i)=>`$${i+1}`).join(","))throw unavailable();
     gateway.assertJob(values[0],values[1]);
     if(match[1]==="naming_brain_worker_action"){
      if(values.length!==4||!["stage","progressive_state","provider_item","provider_turn","tool_result","artifact"].includes(String(values[2])))throw unavailable();
      return{rows:[{result:await gateway.invoke("action",values,true)}]};
     }
     if(values.length!==3)throw unavailable();return{rows:[{result:await gateway.invoke("receipt",values,true)}]};
    }};
    const store=new NamingBrainJobStore(database,options.deploymentId),persistence=store.runtimePersistence(job);
    const runtime=createNamingAgentRuntime({apiKey:options.provider.apiKey,model:input.policy.model,localPrototype:true,...dependencies,
     persistence:{...persistence,async load(identity){return{...await persistence.load(identity),recoveryMode:"observe_only"};}},
     assertContinuation:async()=>{throw Error("shared_naming_observation_only");}});
    for(const stage of await store.loadStages(job)){
     for(const key of new Set(stage.receipts.map(receipt=>receipt.providerCallKey))){
      if(combined.aborted||attempted>=3)break;
      const receipt=namingLatestReceipt(stage,key);
      if(!receipt||receipt.protocol!=="openai_agents"||!receipt.sessionId||stage.artifacts.some(a=>a.providerReceipt.providerCallKey===key))continue;
      attempted++;
      try{
       const outcome=await runtime.resumeStage(receipt,{signal:combined,beforeDispatch:async()=>{throw Error("shared_naming_observation_only");},
        onReceipt:value=>store.recordReceipt(job,value),onArtifact:value=>store.saveProviderItem(job,value)});
       if(outcome.status==="completed")await store.saveArtifact(job,outcome.output);
       retained++;
      }catch{unconfirmed=true;throw Error("shared_naming_observation_unconfirmed");}
     }
    }
    await gateway.drain();
   }
   return{disposition:"retry" as const,state:retained?"observation_retained":"retained_unsupported"};
  };
  const run=execute();active=run;try{return await run;}finally{active=null;}
 },async close(){closed=true;stop.abort();await active;if(unconfirmed)throw Error("shared_naming_drain_unconfirmed");}});
}
