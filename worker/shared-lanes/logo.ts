import {ASSET_MAX_FILE_BYTES} from "../../src/domain/asset-library";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ClaimedJob } from "../../src/domain/jobs";
import type { LogoWorkerConnection } from "../../src/server/data/logo-jobs";
import { sharedPendingExecutionSchema,type SharedExecution,type SharedPendingExecution } from "../shared-pool/contracts";
import type { SharedLogoStorageAuthorization } from "../shared-storage/authorization";
import { logoAssetReferenceSchema } from "../../src/domain/logo-vector";
import { identityAssetPublicationSchema,verifiedFileObservationSchema } from "../../src/domain/logo-deliverables";
import { parseClaimedJob } from "../postgres-store";
import { createLogoJobStore } from "../logo-job-store";
import { createLogoImageRuntimeAdapter } from "../logo-image-runtime-adapter";
import { createLogoGenerativeAssetStore } from "../logo-generative-asset-store";
import { qualifiedLogoRasterCapability,type LogoRasterStorageAuthorization } from "../logo-generative-storage-authorization";
import { createLogoConceptHandler } from "../handlers/logo-concepts";
import { createLogoRefinementHandler } from "../handlers/logo-refinements";
import { runOneJob,type HandlerRegistry } from "../runner";
import { SUNBURST_STANDARD_IMAGE_PRICING } from "../../src/server/logo-creation/openai-image-pricing";
import type { SharedLaneBase,SharedLaneEngine,SharedLaneResult } from "./contracts";
import type { OpenAIImageTransport } from "../../src/server/logo-creation/openai-image-transport";
import { createSharedLaneGateway } from "./gateway";
import {qualifySharedLogoCapability,type SharedLogoCapability} from "./logo-capability";
import {createSharedAdvancedLogoAssetStore,type SharedAdvancedLogoStorageAuthorization} from "./logo-storage";
import {createSharedAdvancedLogoHandler,type SharedIdentityFactory} from "./logo-advanced";
import type {OpenAIResponsesTransport} from "../../src/server/ai/openai-transport";
import type {LogoProductionRuntimeQualification} from "../logo-production-qualification";
import {qualifiedLogoProductionStorageCapability} from "../logo-production-storage-authorization";
import {isDeepStrictEqual as equalClaim} from "node:util";

export type SharedLogoStorageFactory=(execution:SharedExecution,capability:SharedLogoCapability)=>Promise<LogoRasterStorageAuthorization|SharedAdvancedLogoStorageAuthorization>;
const unavailable=()=>Error("shared_logo_authority_unavailable");
/** Fixed query grammar. The SQL gateway repeats every exact frozen binding;
 * metadata preparation never supplies a new owner to the restricted principal. */
export const sharedLogoStatements=Object.freeze({
 "select public.load_logo_direction_inputs($1,$2) value":{action:"direction_inputs",count:2,column:"value"},
 "select public.stage_logo_directions($1,$2,$3,$4,$5) value":{action:"stage_directions",count:5,column:"value"},
 "select public.load_logo_export_inputs($1,$2) value":{action:"export_inputs",count:2,column:"value"},
 "select public.stage_logo_exports($1,$2,$3) value":{action:"stage_exports",count:3,column:"value"},
 "select fluid_private.stage_logo_vector_publication($1::uuid,$2::uuid,$3::jsonb) value":{action:"stage_vector",count:3,column:"value"},
 "select fluid_private.read_leased_logo_vector_revision($1::uuid,$2::uuid,$3::uuid) value":{action:"read_vector",count:3,column:"value"},
 "select fluid_private.stage_logo_vector_proposal($1,$2,$3,$4) value":{action:"stage_proposal",count:4,column:"value",observation:true},
 "select public.load_identity_generation_input($1,$2) value":{action:"identity_input",count:2,column:"value"},
 "select public.authorize_identity_generation_call($1,$2,$3,$4,$5,$6) value":{action:"identity_authorize",count:6,column:"value"},
 "select public.read_identity_generation_call($1,$2,$3,$4) value":{action:"identity_call",count:4,column:"value",observation:true},
 "select public.record_identity_generation_response($1,$2,$3,$4) value":{action:"identity_receipt",count:4,column:"value",observation:true},
 "select public.stage_identity_generation_system($1,$2,$3,$4,$5) value":{action:"identity_stage",count:5,column:"value"},
 "select * from public.heartbeat_logo_job($1,$2,$3)":{action:"heartbeat",count:3,rows:true,observation:true},
 "select public.register_logo_job_plan($1,$2,$3)":{action:"plan",count:3},
 "select public.begin_logo_job_step($1,$2,$3,$4,$5) value":{action:"begin",count:5,column:"value"},
 "select public.complete_logo_job_step($1,$2,$3,$4,$5,$6,$7)":{action:"complete",count:7,observation:true},
 "select public.finish_logo_job($1,$2,$3)":{action:"finish",count:3,observation:true},
 "select public.read_leased_logo_record($1,$2,'has_results',null) value":{action:"has_results",count:2,column:"value",observation:true},
 "select public.read_leased_logo_record($1,$2,$3,$4) value":{action:"read",count:4,column:"value"},
 "select public.record_logo_provider_response($1,$2,$3) value":{action:"receipt",count:3,column:"value",observation:true},
 "select fluid_private.prepare_logo_asset($1::uuid,$2::jsonb,$3::uuid,$4::uuid) as value":{action:"prepare_asset",count:4,column:"value",asset:true},
 "select fluid_private.read_logo_asset_publication($1::uuid,$2::jsonb,$3::uuid,$4::uuid) as value":{action:"read_asset",count:4,column:"value",asset:true},
 "select fluid_private.observe_logo_asset($1::uuid,$2::jsonb,$3::uuid,$4::uuid) as value":{action:"observe_asset",count:4,column:"value",asset:true},
} satisfies Record<string,{action:string;count:number;column?:string;rows?:boolean;observation?:boolean;asset?:boolean}>);

export function createSharedLogoLaneEngine(options:SharedLaneBase & {capabilities:readonly unknown[];storage:SharedLogoStorageFactory;textProvider?:SharedLaneBase["provider"];identityFactory?:SharedIdentityFactory;nativeQualification?:LogoProductionRuntimeQualification},dependencies:{transport?:OpenAIImageTransport;textTransport?:OpenAIResponsesTransport}={}):SharedLaneEngine{
 const capabilities=options.capabilities.map(value=>{const c=qualifySharedLogoCapability(value);if(!c)throw unavailable();
  if(["identity.logo_concept","identity.logo_refine","identity.image"].includes(c.operation)&&c.model!==options.provider.model)throw unavailable();
  if(c.operation==="identity.logo_directions"||c.operation==="identity.logo_vector_propose"||c.operation==="identity.image"){
   const model="apiPolicy" in c?c.apiPolicy.model:"textPolicy" in c?c.textPolicy?.model:null;
   if(!options.textProvider||!options.textProvider.apiKey||!options.textProvider.modelVerificationReceipt||options.textProvider.model!==model)throw unavailable();
  }
  if(c.operation==="identity.image"&&typeof options.identityFactory!=="function")throw unavailable();
  if(["identity.logo_vectorize","identity.logo_export"].includes(c.operation)&&(!options.nativeQualification||typeof options.nativeQualification.assertRuntimeAvailable!=="function"
   ||typeof options.nativeQualification.invalidate!=="function"||typeof options.nativeQualification.close!=="function"))throw unavailable();return c;});
 if(!capabilities.length||capabilities.length>7||new Set(capabilities.map(c=>c.operation)).size!==capabilities.length
  ||!options.provider.apiKey||!options.provider.modelVerificationReceipt||typeof options.storage!=="function")throw unavailable();
 const stop=new AbortController();let closed=false,active:Promise<unknown>|null=null,unconfirmed=false;
 return Object.freeze({async run(message?:unknown,signal?:AbortSignal):Promise<SharedLaneResult>{
  if(message!==undefined)throw unavailable();if(unconfirmed)throw Error("shared_logo_drain_unconfirmed");
  if(closed||active||signal?.aborted)return{disposition:"retry",state:"stopping"};
  const combined=AbortSignal.any([stop.signal,...signal?[signal]:[]]),gateway=createSharedLaneGateway({...options,lane:"logo",signal:combined});
  const execute=async()=>{
   const rows=z.array(z.record(z.string(),z.unknown())).max(1).parse(await gateway.invoke("claim",[options.workerId,120]));
   if(!rows.length)return{disposition:"ack" as const,state:"idle"};
   const job=parseClaimedJob(rows[0]),execution=gateway.execution();gateway.assertJob(job.id,job.leaseToken,job.ownerId,job.projectId);
   if(!execution||job.operation!==execution.operation)throw unavailable();
   const capability=capabilities.find(c=>c.operation===job.operation&&c.policyIdentity===execution.policyIdentity);if(!capability)throw unavailable();
   let consumed=false;
   const connection:LogoWorkerConnection={async query<Row>(sql:string,values:unknown[]=[]){
    const normalized=sql.replace(/\s+/gu," ").trim().replace(/^SELECT /u,"select ").replace(/ AS /gu," as ");
    if(normalized==="select * from public.claim_logo_job($1,$2)"){
     if(consumed||values.length!==2||values[0]!==options.workerId||values[1]!==120)throw unavailable();consumed=true;return{rows:structuredClone(rows) as Row[]};
    }
    const statement=sharedLogoStatements[normalized as keyof typeof sharedLogoStatements] as {action:string;count:number;column?:string;rows?:boolean;observation?:boolean;asset?:boolean}|undefined;
    if(!statement||values.length!==statement.count)throw unavailable();
    if(statement.asset){gateway.assertJob(values[2],values[3]);if(statement.action!=="observe_asset"&&values[0]!==execution.projectId)throw unavailable();}
    else gateway.assertJob(values[0],values[1]);
    const result=await gateway.invoke(statement.action,values,statement.observation||(statement.action==="read"&&values[2]==="vector_proposal_evidence_inputs"));
    if(statement.rows){if(!Array.isArray(result))throw unavailable();return{rows:result as Row[]};}
    return{rows:[{[statement.column??statement.action]:result}] as Row[]};
   }};
   const authorization=job.operation==="identity.logo_vector_propose"?null:await options.storage(execution,capability);
   if(authorization&&(authorization.ownerId!==execution.ownerId||!isDeepStrictEqual(authorization.capability,capability)))throw unavailable();
   try{
    const acceptingWork=()=>!closed&&!combined.aborted;
    const assertAvailable=async(current:ClaimedJob)=>{gateway.assertJob(current.id,current.leaseToken,current.ownerId,current.projectId);combined.throwIfAborted();
     if(await gateway.invoke("assert_continue",[])!==true)throw unavailable();
     if(["identity.logo_vectorize","identity.logo_export"].includes(current.operation)){
      const native=qualifiedLogoProductionStorageCapability(capability);if(!native||!options.nativeQualification)throw unavailable();
      await options.nativeQualification.assertRuntimeAvailable({ownerId:current.ownerId,workerId:options.workerId,capability:native},combined);
      combined.throwIfAborted();if(await gateway.invoke("assert_continue",[])!==true)throw unavailable();
     }
     await authorization?.assertAvailable(current);};
    const generative=qualifiedLogoRasterCapability(capability);
    let handler:ReturnType<typeof createLogoConceptHandler>|null=null;
    if(generative){
     if(!authorization)throw unavailable();
     const assets=createLogoGenerativeAssetStore({connection,authorization:authorization as LogoRasterStorageAuthorization});
     const adapter=createLogoImageRuntimeAdapter({ownerId:job.ownerId,capability:generative,image:{apiKey:options.provider.apiKey,model:options.provider.model,
      rateVersion:SUNBURST_STANDARD_IMAGE_PRICING.binding.rateVersion,paidCallsApproved:true},connection,assets,references:"uploaded",
      transport:dependencies.transport,acceptingWork,assertAvailable});
     if(!adapter)throw unavailable();handler=adapter.concepts?createLogoConceptHandler(adapter.concepts):adapter.refinements?createLogoRefinementHandler(adapter.refinements):null;
    }else{
     const assets=authorization?createSharedAdvancedLogoAssetStore(connection,authorization as SharedAdvancedLogoStorageAuthorization):null;
     handler=createSharedAdvancedLogoHandler({job,capability,connection,assets,provider:options.provider,textProvider:options.textProvider,identityFactory:options.identityFactory,
      acceptingWork,assertAvailable,textTransport:dependencies.textTransport,imageTransport:dependencies.transport});
    }
    if(!handler)throw unavailable();
    const pending=new Set<Promise<unknown>>();
    const handlers:HandlerRegistry=new Map([[job.operation,{steps(current:ClaimedJob){return handler.steps(current).map(step=>({...step,execute(args:{job:ClaimedJob;signal:AbortSignal}){
     const execution=Promise.resolve().then(()=>step.execute(args));pending.add(execution);
     void execution.then(()=>pending.delete(execution),()=>{unconfirmed=true;pending.delete(execution);});return execution;
    }}));}}]]);
    const store=createLogoJobStore(connection),trusted=new WeakSet<object>();
    const claimedStore={...store,async claim(workerId:string,seconds:number){const current=await store.claim(workerId,seconds);
     if(current){gateway.assertJob(current.id,current.leaseToken,current.ownerId,current.projectId);if(!equalClaim(current.input,job.input))throw unavailable();
      const input=current.input as {spendControl?:unknown};if(input?.spendControl==="uncapped"&&["identity.image","identity.logo_directions","identity.logo_vector_propose","identity.logo_concept","identity.logo_refine"].includes(current.operation))trusted.add(current);}
     return current;},hasUnmeteredExecutionAuthority:(current:ClaimedJob)=>trusted.has(current)};
    const state=await runOneJob({store:claimedStore,handlers,workerId:options.workerId,leaseSeconds:120,signal:combined});
    await Promise.allSettled([...pending]);
    if(unconfirmed)throw Error("shared_logo_drain_unconfirmed");
    if(state==="lease_lost"){
     const known=z.discriminatedUnion("status",[z.strictObject({status:z.literal("terminal"),state:z.enum(["succeeded","failed","partial","cancelled"])}),z.strictObject({status:z.literal("retained_unknown")})])
      .parse(await gateway.invoke("finish_known",[],true));
     if(known.status==="terminal")return{disposition:"ack" as const,state:known.state};
    }
    return{disposition:["lease_lost","running","queued"].includes(state)?"retry" as const:"ack" as const,state};
   }finally{authorization?.close();}
  };
  const run=execute();active=run;try{return await run;}finally{await gateway.drain();active=null;}
 },async recover(pending:readonly SharedPendingExecution[],signal?:AbortSignal):Promise<SharedLaneResult>{
  if(unconfirmed)throw Error("shared_logo_drain_unconfirmed");
  if(closed||active||signal?.aborted)return{disposition:"retry",state:"stopping"};
  const rows=z.array(sharedPendingExecutionSchema).max(25).parse(pending),combined=AbortSignal.any([stop.signal,...signal?[signal]:[]]);
  const reservationSchema=z.strictObject({id:z.uuid(),requestKey:z.uuid(),reference:logoAssetReferenceSchema,storagePath:z.string().min(1).max(147),
   mimeType:z.enum(["image/png","image/jpeg","image/webp","application/json","image/svg+xml","application/pdf","application/zip"]),byteLength:z.number().int().min(1).max(ASSET_MAX_FILE_BYTES),purpose:z.enum(["reference_media","brand_asset","input_attachment"]),
   sourceReceiptId:z.uuid(),rightsEvidenceId:z.uuid().nullable(),publicationState:z.enum(["staged","committed"])});
  const execute=async()=>{let retained=0,attempted=0,unsupported=0;
   for(const row of rows){
    if(combined.aborted||attempted>=3)break;
    if(row.execution.lane!=="logo")continue;
    const gateway=createSharedLaneGateway({...options,deploymentId:row.execution.deploymentId,lane:"logo",observationExecution:row.execution});
    const view=z.strictObject({observationJob:z.record(z.string(),z.unknown()),observationLeaseToken:z.uuid(),
     outputs:z.array(z.strictObject({reservation:reservationSchema,publication:identityAssetPublicationSchema})).max(3),executionClosed:z.boolean(),remaining:z.boolean().optional(),capability:z.unknown().optional()})
     .parse(await gateway.invoke("recovery",[],true));
    if(view.observationLeaseToken!==row.execution.leaseToken)throw unavailable();
    const parsed=parseClaimedJob({...view.observationJob,lease_token:view.observationLeaseToken});
    gateway.assertJob(parsed.id,view.observationLeaseToken,parsed.ownerId,parsed.projectId);
    // Preserve the actual nullable current lease and actual state. The original
    // frozen observation capability is supplied separately to the Storage broker.
    const job={...parsed,leaseToken:z.uuid().nullable().parse(view.observationJob.lease_token)};
    if(view.executionClosed){
     if(job.leaseToken!==null||!["succeeded","failed","partial","cancelled"].includes(job.status))throw unavailable();
     return{disposition:"ack" as const,state:job.status};
    }
    const capability=view.capability===undefined?capabilities.find(c=>c.operation===row.execution.operation&&c.policyIdentity===row.execution.policyIdentity):qualifySharedLogoCapability(view.capability);
    if(!capability||capability.operation!==row.execution.operation||capability.policyIdentity!==row.execution.policyIdentity){unsupported++;continue;}
    if(!view.outputs.length){
     const finished=z.discriminatedUnion("status",[z.strictObject({status:z.literal("terminal"),state:z.enum(["succeeded","failed","partial","cancelled"])}),z.strictObject({status:z.literal("retained_unknown")})])
      .parse(await gateway.invoke("finish_known",[],true));
     if(finished.status==="terminal")return{disposition:"ack" as const,state:finished.state};continue;
    }
    const authorization=await options.storage(row.execution,capability);
    try{
     if(authorization.ownerId!==row.execution.ownerId||!isDeepStrictEqual(authorization.capability,capability))throw unavailable();
     if(!('authorizeObservedOutput' in authorization)||typeof authorization.authorizeObservedOutput!=="function")continue;
     const observed=authorization as SharedLogoStorageAuthorization;
     for(const output of view.outputs){
      if(combined.aborted||attempted>=3)break;attempted++;
      const reader=await observed.authorizeObservedOutput({job,observationLeaseToken:view.observationLeaseToken,...output},combined);
      const bytes=await reader.read(combined),hash=createHash("sha256").update(bytes.bytes).digest("hex");
      if(bytes.mimeType!==output.reservation.mimeType||bytes.bytes.byteLength!==output.reservation.byteLength||hash!==output.reservation.reference.contentHash)throw unavailable();
      const verification=verifiedFileObservationSchema.parse({status:"verified",checkedAt:new Date().toISOString(),mimeType:bytes.mimeType,byteLength:bytes.bytes.byteLength,contentHash:hash});
      const saved=z.object({reservationId:z.uuid(),status:z.literal("observed_only"),providerOutcome:z.literal("retained_unknown"),verification:verifiedFileObservationSchema})
       .parse(await gateway.invoke("observe_recovered_asset",[view.observationLeaseToken,output.reservation.id,verification],true));
      if(saved.reservationId!==output.reservation.id||!isDeepStrictEqual({...saved.verification,checkedAt:null},{...verification,checkedAt:null}))throw unavailable();retained++;
     }
    }finally{authorization.close();}
    const finished=z.discriminatedUnion("status",[z.strictObject({status:z.literal("terminal"),state:z.enum(["succeeded","failed","partial","cancelled"])}),z.strictObject({status:z.literal("retained_unknown")})])
     .parse(await gateway.invoke("finish_known",[],true));
    if(finished.status==="terminal")return{disposition:"ack" as const,state:finished.state};
    await gateway.drain();
   }
   return{disposition:"retry" as const,state:retained?"observation_retained":unsupported?"retained_unsupported":"retained_unknown"};
  };
  const run=execute();active=run;try{return await run;}finally{active=null;}
 },async close(){closed=true;stop.abort();await active;if(unconfirmed)throw Error("shared_logo_drain_unconfirmed");}});
}
