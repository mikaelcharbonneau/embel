import "server-only";
import { z } from "zod";
import { EnrollmentEffectUnavailable,type EnrollmentCapabilityAdapter,type EnrollmentContext,type EnrollmentCredentialReservation,
 type EnrollmentPublication,type EnrollmentRevocationProof } from "../../src/server/account-enrollment/contracts";
import { approvedWorkerProfileSchema,ownerWorkerRole,workerEnrollmentCapabilitySchema,workerProfileFingerprint,
 type ApprovedWorkerProfile,type WorkerEnrollmentCapability } from "./configuration";

const reference=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u);
const bound={ownerId:z.uuid(),generation:z.number().int().positive(),revision:z.number().int().positive(),operationKey:z.uuid(),capability:workerEnrollmentCapabilitySchema};
export const ownerWorkerBindingSchema=z.strictObject({...bound,roleName:z.string().max(63),roleOid:z.number().int().min(1).max(4_294_967_295),credentialRef:reference,
 workerId:z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/u),deploymentId:z.string().regex(/^dpl_[A-Za-z0-9_-]{1,196}$/u),profileFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),
 storageAuthUserId:z.uuid().nullable()});
export type OwnerWorkerBinding=z.infer<typeof ownerWorkerBindingSchema>;
export type OwnerWorkerProcessDescriptor=Readonly<{version:1;binding:OwnerWorkerBinding;profile:ApprovedWorkerProfile}>;
const publicationSchema=z.strictObject({...bound,receipt:reference});
const runtimeProofSchema=z.strictObject({...bound,receipt:reference,observedAt:z.iso.datetime({offset:true}),
 profileFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),roleOid:z.number().int().positive(),workerId:z.string(),
 sourceRevision:z.string().regex(/^[a-f0-9]{40}$/u),artifactSha256:z.string().regex(/^[a-f0-9]{64}$/u),
 storageSessionId:z.uuid().nullable()});
export type OwnerWorkerRuntimeProof=z.infer<typeof runtimeProofSchema>;
export interface OwnerWorkerCredentialStore {
 reserve(context:EnrollmentContext,signal?:AbortSignal):Promise<EnrollmentCredentialReservation>;
 retire(context:EnrollmentContext,signal?:AbortSignal):Promise<void>;
 renewStorageActor?(context:EnrollmentContext,profile:ApprovedWorkerProfile,signal?:AbortSignal):Promise<void>;
 cleanupUnprovisionedActor?(context:EnrollmentContext,signal?:AbortSignal):Promise<void>;
}
/** An approved configured process controller provisions only the descriptor's
 * per-owner role/policies and starts that exact reviewed artifact. It must keep
 * credentials in its dedicated secret store and preserve hosted job authority.
 * The ordinary hardcoded production bootstrap is NOT a per-owner launcher. */
export interface OwnerWorkerProcessController {
 prepare(context:EnrollmentContext,profile:ApprovedWorkerProfile,reservation:EnrollmentCredentialReservation,signal?:AbortSignal):Promise<OwnerWorkerBinding>;
 publish(context:EnrollmentContext,descriptor:OwnerWorkerProcessDescriptor,signal?:AbortSignal):Promise<EnrollmentPublication>;
 inspect(context:EnrollmentContext,descriptor:OwnerWorkerProcessDescriptor,publication:EnrollmentPublication,signal?:AbortSignal):Promise<OwnerWorkerRuntimeProof>;
 revoke(context:EnrollmentContext,signal?:AbortSignal):Promise<EnrollmentRevocationProof>;
 maintain?(context:EnrollmentContext,signal?:AbortSignal):Promise<OwnerWorkerRuntimeProof>;
 suspend?(context:EnrollmentContext,signal?:AbortSignal):Promise<void>;
 hasObservedRuntime?(context:EnrollmentContext):boolean;
}
const unavailable=(reason:"adapter_unavailable"|"store_unavailable"|"provision_unavailable"|"publication_unavailable"|"verification_unavailable"="adapter_unavailable")=>new EnrollmentEffectUnavailable(reason);
function active(signal?:AbortSignal){if(signal?.aborted)throw unavailable();}
function same(context:EnrollmentContext,value:{ownerId:string;generation:number;operationKey:string;capability:string}) {
 const {claim,step}=context;
 if(value.ownerId!==claim.ownerId||value.generation!==claim.generation||("revision" in value&&value.revision!==claim.revision)||value.operationKey!==step.operationKey||value.capability!==step.capability)throw unavailable("verification_unavailable");
}
async function contextNow(context:EnrollmentContext,signal?:AbortSignal):Promise<EnrollmentContext> {
 active(signal);const claim=await context.store.read(context.claim);active(signal);
 const step=claim.steps.find(s=>s.capability===context.step.capability);
 if(claim.ownerId!==context.claim.ownerId||claim.generation!==context.claim.generation||claim.revision!==context.claim.revision||claim.mode!==context.claim.mode||!step||step.operationKey!==context.step.operationKey)throw unavailable();
 return{claim,step,store:context.store};
}
/** Concrete SQL adoption/proof adapter around an explicitly configured controller.
 * No role is inferred from a browser owner, no local-prototype authority is used,
 * and no returned controller 'ready' flag changes enrollment. SQL independently
 * checks live principal/bindings/heartbeat/session before recording readiness.
 * Installing these sources does not configure the required process controller. */
export function createOwnerWorkerEnrollmentAdapter(dependencies:{profiles:ReadonlyMap<WorkerEnrollmentCapability,ApprovedWorkerProfile>;
 credentials:OwnerWorkerCredentialStore|null;controller:OwnerWorkerProcessController|null;now?:()=>number}):EnrollmentCapabilityAdapter {
 const now=dependencies.now??Date.now;
 return{
  async maintain(initial,signal){
   const context=await contextNow(initial,signal),capability=workerEnrollmentCapabilitySchema.parse(context.step.capability),profile=dependencies.profiles.get(capability);
   try{
    if(!profile||!dependencies.controller?.maintain||!dependencies.credentials)throw unavailable("verification_unavailable");
    if(capability==="logo"){
     if(!dependencies.credentials.renewStorageActor)throw unavailable("store_unavailable");
     await dependencies.credentials.renewStorageActor(context,profile,signal);
    }
    const proof=runtimeProofSchema.parse(await dependencies.controller.maintain(context,signal));same(context,proof);active(signal);
    const age=now()-Date.parse(proof.observedAt);
    if(age<0||age>30_000||proof.profileFingerprint!==workerProfileFingerprint(profile)||proof.sourceRevision!==profile.sourceRevision||proof.artifactSha256!==profile.artifactSha256
     ||(capability==="logo"?proof.storageSessionId===null:proof.storageSessionId!==null))throw unavailable("verification_unavailable");
    const result=await context.store.operator.query("SELECT public.verify_account_worker_enrollment($1,$2,$3,$4::jsonb) AS value",[context.claim.id,context.claim.leaseToken,capability,JSON.stringify(proof)]);
    if(result.rows.length!==1||(result.rows[0] as{value?:unknown}).value!==true)throw unavailable("verification_unavailable");
   }catch{
    if(!signal?.aborted){
     if(dependencies.controller?.suspend)await dependencies.controller.suspend(context,signal);
     else await context.store.operator.query("SELECT public.suspend_account_worker_enrollment($1,$2,$3,$4) AS value",[context.claim.id,context.claim.leaseToken,capability,"verification_unavailable"]);
    }
    throw unavailable("verification_unavailable");
   }
  },
  async reconcile(initial,signal){
   let context=await contextNow(initial,signal);
   const capability=workerEnrollmentCapabilitySchema.safeParse(context.step.capability);
   const profile=capability.success?dependencies.profiles.get(capability.data):undefined;
   if(!profile||!dependencies.credentials||!dependencies.controller){await context.store.record(context.claim,context.step.capability,"blocked",!dependencies.credentials?"store_unavailable":"adapter_unavailable");return;}
   const approved=approvedWorkerProfileSchema.parse(profile);
   if(approved.capability!==context.step.capability)throw unavailable();
   if(!context.step.effectsStarted){await context.store.record(context.claim,context.step.capability,"provisioning");context=await contextNow(context,signal);}
   if(!context.step.effectsStarted)throw unavailable("provision_unavailable");
   active(signal);const reservation=await dependencies.credentials.reserve(context,signal);active(signal);
   if(!reference.safeParse(reservation.reference).success||!/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/u.test(reservation.verifier)
    ||context.step.credentialRef!==null&&context.step.credentialRef!==reservation.reference)throw unavailable("store_unavailable");
   const binding=ownerWorkerBindingSchema.parse(await dependencies.controller.prepare(context,approved,reservation,signal));active(signal);same(context,binding);
   const fingerprint=workerProfileFingerprint(approved);
   const storageBinding=approved.capability==="logo"?binding.storageAuthUserId!==null&&binding.storageAuthUserId!==context.claim.ownerId:binding.storageAuthUserId===null;
   if(binding.roleName!==ownerWorkerRole(approved.capability,context.claim.ownerId)||binding.credentialRef!==reservation.reference||binding.profileFingerprint!==fingerprint
    ||binding.deploymentId!==approved.deploymentId||!storageBinding) {
    throw unavailable("provision_unavailable");
   }
   const adoption=await context.store.operator.query("SELECT public.adopt_account_worker_enrollment($1,$2,$3,$4::jsonb,$5::jsonb) AS value",
    [context.claim.id,context.claim.leaseToken,approved.capability,JSON.stringify(approved),JSON.stringify(binding)]);active(signal);
   if(adoption.rows.length!==1)throw unavailable("provision_unavailable");
   const adopted=ownerWorkerBindingSchema.parse((adoption.rows[0] as{value:unknown}).value);same(context,adopted);
   if(JSON.stringify(adopted)!==JSON.stringify(binding))throw unavailable("provision_unavailable");
   context=await contextNow(context,signal);
   const descriptor:OwnerWorkerProcessDescriptor={version:1,binding,profile:approved};
   const publication=publicationSchema.parse(await dependencies.controller.publish(context,descriptor,signal));active(signal);same(context,publication);
   const proof=runtimeProofSchema.parse(await dependencies.controller.inspect(context,descriptor,publication,signal));active(signal);same(context,proof);
   const age=now()-Date.parse(proof.observedAt);
   if(age<0||age>30_000||proof.profileFingerprint!==fingerprint||proof.roleOid!==binding.roleOid||proof.workerId!==binding.workerId||proof.sourceRevision!==approved.sourceRevision
    ||proof.artifactSha256!==approved.artifactSha256||(approved.capability==="logo"?proof.storageSessionId===null:proof.storageSessionId!==null))throw unavailable("verification_unavailable");
   const published=await context.store.operator.query("SELECT public.publish_account_worker_enrollment($1,$2,$3,$4) AS value",
    [context.claim.id,context.claim.leaseToken,approved.capability,proof.receipt]);active(signal);
   if(published.rows.length!==1||(published.rows[0] as{value?:unknown}).value!==true)throw unavailable("publication_unavailable");
   context=await contextNow(context,signal);
   // The operator's lease-locked SQL proof, not inspect()'s return value, records ready.
   const result=await context.store.operator.query("SELECT public.verify_account_worker_enrollment($1,$2,$3,$4::jsonb) AS value",
    [context.claim.id,context.claim.leaseToken,approved.capability,JSON.stringify(proof)]);active(signal);
   if(result.rows.length!==1||!(result.rows[0] as{value?:unknown}).value)throw unavailable("verification_unavailable");
  },
  async revoke(initial,signal){
   const context=await contextNow(initial,signal);if(context.claim.mode!=="revoke"||!dependencies.controller||!dependencies.credentials)throw unavailable();
   await context.store.operator.query("SELECT public.disable_account_worker_enrollment($1,$2,$3) AS value",[context.claim.id,context.claim.leaseToken,context.step.capability]);active(signal);
   if(context.step.capability==="logo"&&dependencies.controller.hasObservedRuntime?.(context)===false){
    if(!dependencies.credentials.cleanupUnprovisionedActor)throw unavailable("verification_unavailable");
    // Its own lease-bound SQL absence proof must authorize Auth cleanup first.
    // An unknown supervisor's existing binding cannot pass this path.
    await dependencies.credentials.cleanupUnprovisionedActor(context,signal);
   }
   const proof=await dependencies.controller.revoke(context,signal);active(signal);same(context,proof);
   const age=now()-Date.parse(proof.observedAt);
   const stopped="runtimeStopped" in proof&&proof.runtimeStopped===true;
   const absent="scope" in proof&&proof.scope==="never_provisioned"&&"authorityAbsent" in proof&&proof.authorityAbsent===true&&!("runtimeStopped" in proof);
   if(proof.authorityDisabled!==true||!stopped&&!absent||proof.storageDenied!==true||!reference.safeParse(proof.receipt).success||age<0||age>30_000)throw unavailable("verification_unavailable");
   await dependencies.credentials.retire(context,signal);active(signal);return proof;
  },
 };
}
