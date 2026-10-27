import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { IMAGE_MODEL } from "../../src/domain/providers";
import { HOSTED_APPLICATION_ORIGIN } from "../../src/server/runtime/hosted-application";

const reference=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u);
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
export const workerEnrollmentCapabilitySchema=z.enum(["strategy","naming","logo"]);
export type WorkerEnrollmentCapability=z.infer<typeof workerEnrollmentCapabilitySchema>;
export const ownerWorkerRuntimeSchema=z.strictObject({node:z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/u),icu:z.string().min(1).max(20),unicode:z.string().min(1).max(20),platform:z.literal("linux"),arch:z.literal("x64")});
const base={profileId:reference,providerBindingRef:reference,modelVerificationReceipt:reference,
 applicationOrigin:z.literal(HOSTED_APPLICATION_ORIGIN),supabaseOrigin:z.literal("https://fricsfwqibyhemknqgyf.supabase.co"),
 projectId:z.string().regex(/^prj_[A-Za-z0-9]{10,100}$/u),deploymentId:z.string().regex(/^dpl_[A-Za-z0-9_-]{1,196}$/u),
 sourceRevision:z.string().regex(/^[a-f0-9]{40}$/u),artifactSha256:hash,managedProofSha256:hash,runtime:ownerWorkerRuntimeSchema,dispatchApproved:z.literal(true)};
const strategyOperations=["strategy.reformulate","strategy.competitors","strategy.audience","strategy.personality"] as const;
const strategyPolicies=z.strictObject({"strategy.reformulate":hash,"strategy.competitors":hash,"strategy.audience":hash,"strategy.personality":hash});
export const approvedWorkerProfileSchema=z.discriminatedUnion("capability",[
 z.strictObject({...base,capability:z.literal("strategy"),model:z.literal("gpt-6.1-sol"),admissionContract:z.literal("hosted_strategy_owner_uncapped_v1"),spendControl:z.literal("uncapped"),policyIdentities:strategyPolicies}),
 z.strictObject({...base,capability:z.literal("naming"),model:z.literal("gpt-6-luna"),admissionContract:z.literal("hosted_owner_v1"),
  providerBudgetVersion:z.literal(2),spendControl:z.literal("uncapped"),policyIdentity:hash}),
 z.strictObject({...base,capability:z.literal("logo"),model:z.literal(IMAGE_MODEL),admissionContract:z.literal("account_logo_operation"),spendControl:z.literal("uncapped"),
  policyIdentities:z.strictObject({"identity.logo_concept":hash,"identity.logo_refine":hash}),storageIdentityRef:reference}),
]).refine(profile=>profile.capability!=="logo"||profile.policyIdentities["identity.logo_concept"]===profile.policyIdentities["identity.logo_refine"],"Uploaded concept and saved-preview refinement must share the exact approved policy identity");
export type ApprovedWorkerProfile=z.infer<typeof approvedWorkerProfileSchema>;
export const workerRolePrefixes=Object.freeze({strategy:"fluid_api_text_worker_",naming:"fluid_naming_brain_worker_",logo:"fluid_logo_worker_"});
export function ownerWorkerRole(capability:WorkerEnrollmentCapability,ownerId:string) {
 return workerRolePrefixes[capability]+z.uuid().parse(ownerId).toLowerCase().replaceAll("-","");
}
/** Explicit trusted operator configuration only. No default model, provider
 * credential, spending policy, existing-owner enrollment or launcher is inferred. */
export function readApprovedWorkerProfiles(raw:unknown):ReadonlyMap<WorkerEnrollmentCapability,ApprovedWorkerProfile> {
 const parsed=z.array(approvedWorkerProfileSchema).max(3).safeParse(raw);
 if(!parsed.success||new Set(parsed.data.map(p=>p.capability)).size!==parsed.data.length) throw Error("Worker enrollment configuration is unavailable");
 return new Map(parsed.data.map(profile=>[profile.capability,Object.freeze(profile)]));
}
export function workerProfileFingerprint(profile:ApprovedWorkerProfile) {
 // Source descriptor identity only. Existing SQL computes its own jsonb policy
 // identities; this fingerprint never substitutes for that authority.
 function sorted(value:unknown):unknown {return value&&typeof value==="object"&&!Array.isArray(value)
  ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,sorted(v)])):value;}
 return createHash("sha256").update(JSON.stringify(sorted(approvedWorkerProfileSchema.parse(profile)))).digest("hex");
}
export {strategyOperations};
