import "server-only";
import { createSharedStrategyLaneEngine } from "../shared-lanes/strategy";
import { createSharedNamingLaneEngine } from "../shared-lanes/naming";
import { createSharedLogoLaneEngine } from "../shared-lanes/logo";
import { namingBrainPolicySchema } from "../../src/domain/naming-brain";
import { createSharedSlotStorageSession } from "../shared-storage/session";
import { createSharedLogoStorageAuthorization } from "../shared-storage/authorization";
import { qualifiedLogoGenerativeStorageCapability } from "../logo-generative-storage-authorization";
import { createSharedAdvancedLogoStorageAuthorization } from "../shared-lanes/logo-storage";
import { createIdentityGenerationRuntimeAdapter } from "../identity/runtime";
import { createSharedLaneGateway } from "../shared-lanes/gateway";
import { qualifiedLogoProductionStorageCapability } from "../logo-production-storage-authorization";
import { createDevelopmentSharedLogoProductionRuntimeQualification,createPackagedLogoProductionRuntimeQualification,type SharedLogoNativeRuntimeQualification } from "./logo-native-qualification";
import { assertSharedPoolAttestation,readSharedPoolConfiguration,type SharedPoolAttestation } from "./configuration";
import { readSharedPoolSecrets } from "./secrets";
import { createSharedPoolController,type SharedPoolControllerDependencies,type SharedEngineFactory } from "./controller";
import type { SharedPendingExecution,SharedLaneEngine } from "./contracts";

/** Actual durable engines for all three lanes. No fixture implementation,
 * owner credential, account provisioning, model probe or alternate launcher. */
export const createSharedPoolLaneEngine:SharedEngineFactory=async options=>{
 const base={database:options.database,slot:options.lease,deploymentId:options.configuration.target.deploymentId,workerId:options.slot.workerId,provider:options.provider};
 if(options.slot.lane==="strategy")return createSharedStrategyLaneEngine({...base,policies:options.slot.policies});
 if(options.slot.lane==="naming")return createSharedNamingLaneEngine({...base,policy:namingBrainPolicySchema.parse(options.slot.policies["naming.generate"])});
 const storage=options.secret.storage;if(!storage)throw Error("shared_logo_storage_unavailable");
 const session=await createSharedSlotStorageSession({targetOrigin:options.configuration.target.supabaseOrigin,...storage,slot:options.lease});
 const authorizations=new Set<{close():void}>();
 let nativeQualification:SharedLogoNativeRuntimeQualification|undefined;
 let createdEngine:SharedLaneEngine|undefined;
 const readiness=createSharedLaneGateway({...base,lane:"logo",signal:options.signal});
 try{
  const nativeCapabilities=Object.values(options.slot.policies).map(qualifiedLogoProductionStorageCapability)
   .filter((capability):capability is NonNullable<typeof capability>=>capability!==null);
  if(nativeCapabilities.length){
   const createQualification=options.configuration.target.kind==="vercel"?createPackagedLogoProductionRuntimeQualification:createDevelopmentSharedLogoProductionRuntimeQualification;
   nativeQualification=createQualification({workerId:options.slot.workerId,capabilities:nativeCapabilities});
   await nativeQualification.preflight(options.signal);
  }
  const engine=createSharedLogoLaneEngine({...base,capabilities:Object.values(options.slot.policies),textProvider:options.textProvider,
   identityFactory:createIdentityGenerationRuntimeAdapter,nativeQualification,storage:async(execution,capability)=>{
   const common={targetOrigin:options.configuration.target.supabaseOrigin,publishableKey:storage.publishableKey,
    slot:options.lease,execution,session};
   const generative=qualifiedLogoGenerativeStorageCapability(capability);
   const authorization=generative?createSharedLogoStorageAuthorization({...common,capability:generative})
    :createSharedAdvancedLogoStorageAuthorization({...common,capability});
   authorizations.add(authorization);return authorization;
  }});
  createdEngine=engine;
  const reportReady=async()=>{
   options.signal.throwIfAborted();
   if(await readiness.invoke("runtime_ready",[Object.values(options.slot.policies)])!==true)throw Error("shared_logo_readiness_unconfirmed");
  };
  await reportReady();
  const closeAuthorizations=()=>{authorizations.forEach(a=>a.close());authorizations.clear();};
  return {async run(message,signal){try{return await engine.run(message,signal);}finally{closeAuthorizations();}},
   renewReadiness:reportReady,
   ...(engine.recover?{async recover(pending:readonly SharedPendingExecution[],signal?:AbortSignal){try{return await engine.recover!(pending,signal);}finally{closeAuthorizations();}}}:{}),
   async close(){try{await engine.close();}finally{closeAuthorizations();try{await nativeQualification?.close();}finally{try{await readiness.drain();}finally{await session.close();}}}}};
 }catch(error){try{await createdEngine?.close();}finally{authorizations.forEach(a=>a.close());try{await nativeQualification?.close();}finally{try{await readiness.drain();}finally{await session.close();}}}throw error;}
};
/** Import/construction is inert. Only explicit enabled target, finite sensitive
 * settings and independently checked real artifact can produce a controller. */
export function createSharedPoolRuntime(env:Readonly<Record<string,string|undefined>>,attestation:SharedPoolAttestation,
 dependencies:Omit<SharedPoolControllerDependencies,"createEngine">&{createEngine?:SharedEngineFactory}={}){
 const config=readSharedPoolConfiguration(env);if(!config)return null;
 assertSharedPoolAttestation(config,attestation);const secrets=readSharedPoolSecrets(config,env);
 return createSharedPoolController(config,secrets,{...dependencies,createEngine:dependencies.createEngine??createSharedPoolLaneEngine});
}
