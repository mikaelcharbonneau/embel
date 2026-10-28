import "server-only";
import { createHash,createHmac,pbkdf2Sync,randomBytes } from "node:crypto";
import JavaScriptClient from "pg/lib/client.js";
import JavaScriptPool from "pg-pool";
import type { Pool } from "pg";
import { z } from "zod";
import type { EnrollmentContext,EnrollmentCredentialStore,EnrollmentHttpBinding } from "../../src/server/account-enrollment/contracts";
import { EnrollmentEffectUnavailable } from "../../src/server/account-enrollment/contracts";
import { enrollmentCapabilities } from "../../src/domain/account-enrollment";
import { createPooledIdentityConnectionFactory,type IdentityPoolPort } from "../../src/server/runtime/identity-pool";
import { createEnrollmentVaultClient } from "./vault-client";
import { restrictedOwnerPoolOptions } from "./process-qualification";
import { ownerWorkerRole,workerProfileFingerprint,type ApprovedWorkerProfile,type WorkerEnrollmentCapability } from "./configuration";
import { createVaultStorageActorProvisioner } from "./storage-actor";

const unavailable=(uncertain=false)=>new EnrollmentEffectUnavailable("store_unavailable",uncertain);
const envelopeSchema=z.strictObject({version:z.literal(1),ownerId:z.uuid(),generation:z.number().int().positive(),revision:z.number().int().positive(),operationKey:z.uuid(),
 capability:z.enum(enrollmentCapabilities),retired:z.boolean(),verifier:z.string().nullable(),providerBindingRef:z.string().nullable(),modelVerificationReceipt:z.string().nullable(),
 profileFingerprint:z.string().nullable(),secrets:z.record(z.string(),z.unknown()).nullable()});
const role=(context:EnrollmentContext)=>context.step.capability==="home_attachments"?`embel_home_web_${context.claim.ownerId.replaceAll("-","")}`
 :context.step.capability==="identity_transactions"?`embel_identity_web_${context.claim.ownerId.replaceAll("-","")}`:ownerWorkerRole(context.step.capability,context.claim.ownerId);
const databaseSchema=z.strictObject({host:z.enum(["db.fricsfwqibyhemknqgyf.supabase.co","aws-0-us-east-1.pooler.supabase.com"]),caPem:z.string().min(80).max(65_536)});
function verifier(password:string){const salt=randomBytes(16),salted=pbkdf2Sync(password,salt,4096,32,"sha256"),client=createHmac("sha256",salted).update("Client Key").digest();
 return`SCRAM-SHA-256$4096:${salt.toString("base64")}$${createHash("sha256").update(client).digest("base64")}:${createHmac("sha256",salted).update("Server Key").digest("base64")}`;}
/** Concrete optional durable reservation implementation. Vault must already
 * exist with dedicated namespace CAS/create/read/destroy permissions. No backend
 * is selected/configured here. Provider/policy and per-owner Storage records
 * must already be separately approved; no credentials or accounts are invented.
 */
export function createVaultEnrollmentCredentialStore(configuration:{vault:unknown;prefix:string;database:z.infer<typeof databaseSchema>;
 profiles:ReadonlyMap<WorkerEnrollmentCapability,ApprovedWorkerProfile>;maxActivePools?:number;storageActor?:Parameters<typeof createVaultStorageActorProvisioner>[0]}):EnrollmentCredentialStore&{
 renewStorageActor(context:EnrollmentContext,profile:ApprovedWorkerProfile,signal?:AbortSignal):Promise<void>;cleanupUnprovisionedActor(context:EnrollmentContext,signal?:AbortSignal):Promise<void>;drainConnections(reference:string):Promise<void>;close():Promise<void>}{
 const client=createEnrollmentVaultClient(configuration.vault),database=databaseSchema.parse(configuration.database),pools=new Map<string,Pool>();
 let closed=false;const retiredRefs=new Set<string>();
 const actors=configuration.storageActor===undefined?null:createVaultStorageActorProvisioner(configuration.storageActor);
 const active=(ref?:string)=>{if(closed||ref&&retiredRefs.has(ref))throw unavailable();};
 if(!/^[A-Za-z0-9][A-Za-z0-9_/-]{0,39}$/u.test(configuration.prefix)||configuration.prefix.split("/").some(s=>!s||s==="."||s===".."))throw unavailable();
 const maxPools=z.number().int().min(1).max(128).parse(configuration.maxActivePools??32);
 const reference=(context:EnrollmentContext)=>`${configuration.prefix}/${context.claim.ownerId}/${context.claim.generation}/${context.step.capability}/${context.step.operationKey}`;
 function parse(context:EnrollmentContext,value:unknown){const result=envelopeSchema.safeParse(value);
  if(!result.success||result.data.ownerId!==context.claim.ownerId||result.data.generation!==context.claim.generation||result.data.revision!==context.claim.revision
   ||result.data.operationKey!==context.step.operationKey||result.data.capability!==context.step.capability)throw unavailable(true);return result.data;}
 return{
  async reserve(context,signal){
   active();signal?.throwIfAborted();if(context.claim.mode!=="enroll"||!context.step.effectsStarted||Date.parse(context.claim.leaseUntil)<=Date.now())throw unavailable();
   const ref=reference(context);active(ref);if(context.step.credentialRef&&context.step.credentialRef!==ref)throw unavailable(true);
   for(let attempt=0;attempt<2;attempt++){
    const existing=await client.read(ref,signal);
    active(ref);if(existing){const value=parse(context,existing.data);if(value.retired||!value.verifier||!value.secrets)throw unavailable(true);return{reference:ref,verifier:value.verifier};}
    const password=randomBytes(32).toString("base64url"),roleName=role(context),user=database.host.startsWith("aws-")?`${roleName}.fricsfwqibyhemknqgyf`:roleName;
    const databaseSecret={databaseUrl:`postgresql://${user}:${password}@${database.host}:5432/postgres?sslmode=verify-full`,caPem:database.caPem};
    // Validate the pinned target/CA/role before the first durable write.
    restrictedOwnerPoolOptions(roleName,databaseSecret,"embel-reserved-owner");
    let providerBindingRef:string|null=null,modelVerificationReceipt:string|null=null,profileFingerprint:string|null=null;
    let runtime:Record<string,unknown>={database:databaseSecret};
    if(context.step.capability!=="home_attachments"&&context.step.capability!=="identity_transactions"){
     const profile=configuration.profiles.get(context.step.capability);if(!profile)throw unavailable();
     const source=await client.read(profile.providerBindingRef,signal);
     const approved=z.strictObject({version:z.literal(1),providerBindingRef:z.string(),modelVerificationReceipt:z.string(),capability:z.enum(["strategy","naming","logo"]),profileFingerprint:z.string(),secrets:z.record(z.string(),z.unknown())}).safeParse(source?.data);
     if(!approved.success||approved.data.providerBindingRef!==profile.providerBindingRef||approved.data.modelVerificationReceipt!==profile.modelVerificationReceipt
      ||approved.data.capability!==context.step.capability||approved.data.profileFingerprint!==workerProfileFingerprint(profile)
      ||"database" in approved.data.secrets||"attestation" in approved.data.secrets||"storage" in approved.data.secrets)throw unavailable();
     runtime={...approved.data.secrets,database:databaseSecret};providerBindingRef=profile.providerBindingRef;modelVerificationReceipt=profile.modelVerificationReceipt;profileFingerprint=workerProfileFingerprint(profile);
     if(profile.capability==="logo"){
      const storage=actors?await actors.ensure({context,profile},signal):(await client.read(`${profile.storageIdentityRef}/${context.claim.ownerId}`,signal))?.data;
      const actor=z.strictObject({version:z.literal(1),ownerId:z.uuid(),storageIdentityRef:z.string(),storage:z.record(z.string(),z.unknown())}).safeParse(storage);
      if(!actor.success||actor.data.ownerId!==context.claim.ownerId||actor.data.storageIdentityRef!==profile.storageIdentityRef)throw unavailable();runtime.storage=actor.data.storage;
     }
    }
    const value={version:1,ownerId:context.claim.ownerId,generation:context.claim.generation,revision:context.claim.revision,operationKey:context.step.operationKey,capability:context.step.capability,
     retired:false,verifier:verifier(password),providerBindingRef,modelVerificationReceipt,profileFingerprint,secrets:runtime};
    active(ref);const written=await client.write(ref,0,value,signal);active(ref);if(written!==null)return{reference:ref,verifier:value.verifier};
   }
   throw unavailable(true);
  },
  async retire(context,signal){
   active();signal?.throwIfAborted();if(context.claim.mode!=="revoke")throw unavailable();
   // Revoking generation may differ. The SQL-persisted immutable reference is
   // authoritative; never infer a fresh credential or silently delete metadata.
   const ref=context.step.credentialRef??reference(context);if(!ref.startsWith(`${configuration.prefix}/${context.claim.ownerId}/`))throw unavailable();
   retiredRefs.add(ref);
   if(context.step.capability==="logo"&&actors){const profile=configuration.profiles.get("logo");if(!profile)throw unavailable(true);await actors.revoke({context,profile},signal);}
   for(let attempt=0;attempt<3;attempt++){
    const existing=await client.read(ref,signal);
    if(!existing){
     const written=await client.write(ref,0,{version:1,ownerId:context.claim.ownerId,generation:context.claim.generation,revision:context.claim.revision,operationKey:context.step.operationKey,capability:context.step.capability,
      retired:true,verifier:null,providerBindingRef:null,modelVerificationReceipt:null,profileFingerprint:null,secrets:null},signal);
     if(written===null)continue;return;
    }
    const value=envelopeSchema.parse(existing.data);
    if(value.ownerId!==context.claim.ownerId||value.capability!==context.step.capability||value.generation>context.claim.generation||value.revision>context.claim.revision)throw unavailable(true);
    let version=existing.version;
    if(!value.retired){const written=await client.write(ref,existing.version,{...value,retired:true,verifier:null,secrets:null},signal);if(written===null)continue;version=written;}
    if(version>101)throw unavailable(true);await client.destroy(ref,Array.from({length:version-1},(_,i)=>i+1),signal);
    const pool=pools.get(ref);if(pool){await pool.end();pools.delete(ref);}return;
   }
   throw unavailable(true);
  },
  async connections(ref:string,binding:EnrollmentHttpBinding,signal){
   active(ref);signal?.throwIfAborted();const stored=await client.read(ref,signal);active(ref);if(!stored)throw unavailable();const value=envelopeSchema.parse(stored.data);
   if(value.retired||!value.secrets||value.ownerId!==binding.ownerId||value.generation!==binding.generation||value.revision!==binding.revision
    ||value.operationKey!==binding.operationKey||value.capability!==binding.capability||ref!==binding.credentialRef)throw unavailable();
   const secret=z.strictObject({databaseUrl:z.string(),caPem:z.string()}).parse(value.secrets.database);
   // Bound live resources, not enrolled customers. Idle pools are recreated on
   // demand; an evicted owner's factory never retains a closed pool forever.
   const lazy:IdentityPoolPort={async connect(){
    active(ref);
    let pool=pools.get(ref);
    if(!pool){
     if(pools.size>=maxPools){const idle=[...pools].find(([,entry])=>entry.totalCount===entry.idleCount&&entry.waitingCount===0);if(!idle)throw unavailable();pools.delete(idle[0]);await idle[1].end();}
     active(ref);pool=pools.get(ref);if(!pool){if(pools.size>=maxPools)throw unavailable();pool=new JavaScriptPool({...restrictedOwnerPoolOptions(binding.roleName,secret,"embel-enrolled-http"),Client:JavaScriptClient});pool.on("error",()=>{});pools.set(ref,pool);}
    }else{pools.delete(ref);pools.set(ref,pool);}
    const lease=await pool.connect();try{active(ref);}catch{lease.release(true);throw unavailable();}return lease as unknown as Awaited<ReturnType<IdentityPoolPort["connect"]>>;
   }};
   return createPooledIdentityConnectionFactory([{ownerId:binding.ownerId,roleName:binding.roleName,roleOid:binding.roleOid,pool:lazy}]);
  },
  async drainConnections(ref){retiredRefs.add(ref);const pool=pools.get(ref);if(pool){pools.delete(ref);await pool.end();}},
  async renewStorageActor(context,profile,signal){
   active();signal?.throwIfAborted();if(context.claim.mode!=="enroll"||context.step.capability!=="logo"||profile.capability!=="logo"||!actors)throw unavailable();
   const ref=context.step.credentialRef;if(!ref)throw unavailable();active(ref);const stored=await client.read(ref,signal);if(!stored)throw unavailable();const value=parse(context,stored.data);
   const expected=z.object({storage:z.object({authUserId:z.uuid()})}).parse(value.secrets);
   const renewed=await actors.ensure({context,profile,expectedAuthUserId:expected.storage.authUserId},signal);if(renewed.storage.authUserId!==expected.storage.authUserId)throw unavailable(true);
  },
  async cleanupUnprovisionedActor(context,signal){
   active();signal?.throwIfAborted();if(context.claim.mode!=="revoke"||context.step.capability!=="logo"||!actors)throw unavailable();
   const profile=configuration.profiles.get("logo");if(!profile)throw unavailable();await actors.revoke({context,profile},signal);
  },
  async close(){closed=true;await Promise.all([...pools.values()].map(pool=>pool.end()));pools.clear();},
 };
}
