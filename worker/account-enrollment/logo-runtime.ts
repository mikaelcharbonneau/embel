import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { decodeJwt } from "jose";
import { z } from "zod";
import type { OwnerWorkerProcessDescriptor } from "./adapter";
import type { OwnerWorkerArtifactAttestation,OwnerWorkerDatabaseSecret,OwnerWorkerProviderSecret,OwnerWorkerReadyNotice } from "./process-contracts";
import { assertOwnerWorkerArtifact,createOwnerWorkerPool,qualifyOwnerWorkerPool } from "./process-qualification";
import { qualifiedLogoGenerativeStorageCapability,createLogoGenerativeStorageAuthorization } from "../logo-generative-storage-authorization";
import { createLogoGenerativeAssetStore } from "../logo-generative-asset-store";
import { startLogoProductionWorker } from "../logo-production-startup";
import type { LogoWorkerConnection } from "../../src/server/data/logo-jobs";
import { SUNBURST_STANDARD_IMAGE_PRICING } from "../../src/server/logo-creation/openai-image-pricing";
import { parseLogoDedicatedConfiguration } from "../logo-dedicated-config";
import { createLocalLogoStorageSession,verifyLocalLogoStorageSession } from "../logo-local-storage-session";
import { inspectIdentityRaster } from "../../src/features/logo-vector/server/converter";
import { isOwnerWorkerObservationStatement,queryOwnerWorkerObservation } from "./observation";

export type OwnerLogoRuntimeSecrets=Readonly<{database:OwnerWorkerDatabaseSecret;provider:OwnerWorkerProviderSecret;attestation:OwnerWorkerArtifactAttestation;
 storage:{authUserId:string;publishableKey:string;sessionApproved:true;identity:{version:1;ownerId:string;authUserId:string;email:string;password:string}};capabilities:readonly unknown[]}>;
const unavailable=()=>Error("owner_logo_runtime_unavailable");
/** Separate per-owner factory. Legacy CloudLogo owner/bootstrap is unchanged.
 * Managed SQL authority, exact policy and live dedicated Storage session must
 * all qualify before any readiness notice or polling can occur. */
export async function runOwnerLogoRuntime(options:{descriptor:OwnerWorkerProcessDescriptor;secrets:OwnerLogoRuntimeSecrets;signal:AbortSignal;
 onReady?:(notice:OwnerWorkerReadyNotice)=>void|Promise<void>}):Promise<void>{
 const{descriptor,secrets}=options,stopped=new AbortController(),signal=AbortSignal.any([options.signal,stopped.signal]),profile=descriptor.profile,b=descriptor.binding;
 assertOwnerWorkerArtifact(descriptor,secrets.attestation);
 if(profile.capability!=="logo"||secrets.provider.model!==profile.model||secrets.provider.modelVerificationReceipt!==profile.modelVerificationReceipt
  ||secrets.storage.authUserId!==b.storageAuthUserId||secrets.storage.authUserId===b.ownerId||secrets.capabilities.length!==2)throw unavailable();
 const capabilities=secrets.capabilities.map(qualifiedLogoGenerativeStorageCapability);
 const concept=capabilities.find(c=>c?.operation==="identity.logo_concept"),refinement=capabilities.find(c=>c?.operation==="identity.logo_refine");
 if(!concept||!refinement||concept.policyIdentity!==profile.policyIdentities["identity.logo_concept"]||refinement.policyIdentity!==profile.policyIdentities["identity.logo_refine"])throw unavailable();
 const image={apiKey:secrets.provider.apiKey,model:profile.model,rateVersion:SUNBURST_STANDARD_IMAGE_PRICING.binding.rateVersion,paidCallsApproved:true};
 const pool=createOwnerWorkerPool(descriptor,secrets.database);let runtime:Awaited<ReturnType<typeof startLogoProductionWorker>>|undefined;
 let session:Awaited<ReturnType<typeof createLocalLogoStorageSession>>|undefined;
 let heartbeatTimer:ReturnType<typeof setInterval>|undefined,heartbeat:Promise<void>|undefined;
 const authorizations:ReturnType<typeof createLogoGenerativeStorageAuthorization>[]=[];
 try{
  await qualifyOwnerWorkerPool(pool,descriptor,signal);
  // Offline deterministic prerequisite check. This synthetic pixel never
  // enters customer Storage or a provider request.
  const sentinel=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==","base64");
  const inspected=await inspectIdentityRaster(sentinel,"image/png",signal);
  if(inspected.width!==1||inspected.height!==1||inspected.format!=="png")throw unavailable();
  const url=new URL(secrets.database.databaseUrl);
  const scope={version:1,enabled:true,binding:{ownerId:b.ownerId,roleName:b.roleName,roleOid:b.roleOid},workerId:b.workerId,
   database:{host:url.hostname,port:5432,database:"postgres",password:decodeURIComponent(url.password)},
   storage:{authUserId:secrets.storage.authUserId,publishableKey:secrets.storage.publishableKey,sessionApproved:secrets.storage.sessionApproved},image,operations:{concepts:concept,refinements:refinement}};
  session=await createLocalLogoStorageSession(secrets.storage.identity,scope);
  const accessToken=await session.tokenProvider(signal),configurationFor=(token:string)=>parseLogoDedicatedConfiguration({...scope,storage:{...scope.storage,accessToken:token}});
  await verifyLocalLogoStorageSession(configurationFor(accessToken),accessToken);
  const storageScope={ownerId:b.ownerId,authUserId:secrets.storage.authUserId,workerRoleName:b.roleName,workerRoleOid:b.roleOid,workerId:b.workerId,publishableKey:secrets.storage.publishableKey,accessToken};
  authorizations.push(...capabilities.map(capability=>createLogoGenerativeStorageAuthorization({...storageScope,capability},{fetch:globalThis.fetch,tokenProvider:session!.tokenProvider})));
  const connection:LogoWorkerConnection={async query<Row>(sql:string,values:unknown[]=[]){
   // Runtime/SQL own new-work fences. A Stop signal alone must not suppress an
   // already-dispatched immutable response or completion while the host drains.
   const result=isOwnerWorkerObservationStatement(sql)?await queryOwnerWorkerObservation(pool,descriptor,sql,values)
    :await(async()=>{signal.throwIfAborted();await qualifyOwnerWorkerPool(pool,descriptor,signal);return pool.query(sql,values);})();
   return{rows:result.rows as Row[]};}};
  const operation=(capability:NonNullable<typeof concept>)=>{
   const authorization=authorizations.find(a=>a?.capability.operation===capability.operation);if(!authorization)throw unavailable();
   return{capability,image,assets:createLogoGenerativeAssetStore({connection,authorization}),assertAvailable:authorization.assertAvailable.bind(authorization)};
  };
  runtime=await startLogoProductionWorker({enabled:true,ownerId:b.ownerId,workerId:b.workerId,connection,concepts:operation(concept),refinements:operation(refinement)});
  if(runtime.status!=="ready"||!await runtime.runtime.refreshReadiness())throw unavailable();
  const sessionId=z.uuid().parse(decodeJwt(accessToken).session_id);
  const ready=runtime;
  async function pulse(){
   await qualifyOwnerWorkerPool(pool,descriptor,signal);const token=await session!.tokenProvider(signal);await verifyLocalLogoStorageSession(configurationFor(token),token);
   if(decodeJwt(token).session_id!==sessionId)throw unavailable();
   if(!await ready.runtime.refreshReadiness())throw unavailable();
   const result=await pool.query("SELECT public.report_account_worker_heartbeat($1::jsonb,$2::uuid) value",[JSON.stringify(b),sessionId]);
   if(result.rows.length!==1||result.rows[0]?.value!==true)throw unavailable();
  }
  await pulse();
  await options.onReady?.({workerId:b.workerId,roleOid:b.roleOid,observedAt:new Date().toISOString(),storageSessionId:sessionId});
  heartbeatTimer=setInterval(()=>{if(heartbeat||signal.aborted)return;heartbeat=pulse().catch(()=>{stopped.abort();}).finally(()=>{heartbeat=undefined;});},15_000);heartbeatTimer.unref();
  while(!signal.aborted){await runtime.runtime.tick(signal);await delay(1000,undefined,{signal}).catch(()=>{});}
 }finally{stopped.abort();clearInterval(heartbeatTimer);await heartbeat?.catch(()=>{});await runtime?.close();authorizations.forEach(a=>a?.close());await session?.close();await pool.end();}
}
