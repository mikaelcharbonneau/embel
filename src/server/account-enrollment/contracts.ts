import "server-only";
import { z } from "zod";
import type { IdentityConnectionFactory } from "@/server/data/identity-transaction";
import { enrollmentCapabilitySchema } from "@/domain/account-enrollment";
export { enrollmentCapabilities, enrollmentCapabilitySchema, enrollmentStatusSchema } from "@/domain/account-enrollment";
export type { EnrollmentCapability, EnrollmentStatus } from "@/domain/account-enrollment";
import type { EnrollmentCapability, EnrollmentStatus } from "@/domain/account-enrollment";

const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u);
export const enrollmentStepSchema = z.strictObject({
  capability: enrollmentCapabilitySchema, operationKey: z.uuid(),
  phase: z.enum(["pending", "provisioning", "credential_reserved", "provisioned", "published", "ready", "blocked", "uncertain", "revoking", "revoked"]),
  effectsStarted: z.boolean(), credentialRef: reference.nullable(), publicationReceipt: reference.nullable(), verificationReceipt: reference.nullable(),
});
export const enrollmentClaimSchema = z.strictObject({ id: z.uuid(), ownerId: z.uuid(), generation: z.number().int().positive(),
  revision: z.number().int().positive(), leaseToken: z.uuid(), leaseUntil: z.iso.datetime({ offset: true }),
  mode: z.enum(["enroll", "revoke"]), steps: z.array(enrollmentStepSchema).length(5),
}).refine(value => new Set(value.steps.map(step => step.capability)).size === 5);
export type EnrollmentStep = z.infer<typeof enrollmentStepSchema>;
export type EnrollmentClaim = z.infer<typeof enrollmentClaimSchema>;
export type EnrollmentFailure = "adapter_unavailable" | "store_unavailable" | "publication_unavailable" | "verification_unavailable" | "provision_unavailable" | "effect_unknown";

/** Separate provisioner connection, never the web's Auth client, service role
 * or an administrator connection. Its SQL functions constrain all authority. */
export interface EnrollmentOperatorPort { query(sql: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }> }
export type EnrollmentHttpBinding = { managementVersion: 2; ownerId: string; generation: number; revision: number;
  capability: "home_attachments" | "identity_transactions"; operationKey: string; roleName: string; roleOid: number;
  managerRoleName: "embel_account_role_manager"; managerRoleOid: number; credentialRef: string };
export interface EnrollmentStore {
  readonly operator: EnrollmentOperatorPort;
  claim(): Promise<EnrollmentClaim | null>;
  read(claim: EnrollmentClaim): Promise<EnrollmentClaim>;
  record(claim: EnrollmentClaim, capability: EnrollmentCapability, phase: string, reference?: string): Promise<EnrollmentClaim>;
  provisionHttp(claim: EnrollmentClaim, capability: "home_attachments" | "identity_transactions", reservation: EnrollmentCredentialReservation): Promise<EnrollmentHttpBinding>;
  lockHttp(claim: EnrollmentClaim, capability: "home_attachments" | "identity_transactions"): Promise<void>;
  acknowledgeRevocation(claim: EnrollmentClaim, capability: EnrollmentCapability, receipt: string): Promise<void>;
  finish(claim: EnrollmentClaim, revoked?: readonly EnrollmentCapability[]): Promise<EnrollmentStatus>;
}
export type EnrollmentContext = Readonly<{ claim: EnrollmentClaim; step: EnrollmentStep; store: EnrollmentStore }>;
type EnrollmentRevocationBinding = { ownerId: string; generation: number; revision: number; operationKey: string; capability: EnrollmentCapability;
  receipt: string; observedAt: string; authorityDisabled: true; storageDenied: true };
export type EnrollmentRevocationProof = Readonly<EnrollmentRevocationBinding & (
  { runtimeStopped: true; scope?: never; authorityAbsent?: never } |
  { scope: "never_provisioned"; authorityAbsent: true; runtimeStopped?: never; capability: "strategy" | "naming" | "logo" }
)>;
/** Adapters record durable effects before issuing them. No returned boolean can
 * enroll an account: the reconciler re-reads SQL and finish recomputes all five. */
export interface EnrollmentCapabilityAdapter {
  /** Same-operation control-plane inspection only: no new role, credential,
   * job or provider dispatch. Implementations preserve observation authority
   * while closing stale admission; readiness remains independently SQL-verified. */
  maintain?(context: EnrollmentContext, signal?: AbortSignal): Promise<void>;
  reconcile(context: EnrollmentContext, signal?: AbortSignal): Promise<void>;
  revoke(context: EnrollmentContext, signal?: AbortSignal): Promise<EnrollmentRevocationProof>;
}
export type EnrollmentCredentialReservation = Readonly<{ reference: string; verifier: string }>;
/** An approved durable store must atomically reserve a stable high-entropy
 * credential for operationKey before returning its SCRAM verifier/reference.
 * No plaintext password is returned to the reconciler, SQL or public status. */
export interface EnrollmentCredentialStore {
  reserve(context: EnrollmentContext, signal?: AbortSignal): Promise<EnrollmentCredentialReservation>;
  retire(context: EnrollmentContext, signal?: AbortSignal): Promise<void>;
  connections(reference: string, binding: EnrollmentHttpBinding, signal?: AbortSignal): Promise<IdentityConnectionFactory>;
}
export type EnrollmentPublication = Readonly<{ ownerId: string; generation: number; revision: number; operationKey: string; capability: EnrollmentCapability; receipt: string }>;
/** Implementation must enforce monotonic enrollment generation/revision,
 * withdraw stale publications and independently confirm runtime visibility.
 * Missing approved store/launcher/Storage revocation proof must fail closed. */
export interface EnrollmentBindingPublisher {
  publish(context: EnrollmentContext, binding: EnrollmentHttpBinding, signal?: AbortSignal): Promise<EnrollmentPublication>;
  verify(context: EnrollmentContext, binding: EnrollmentHttpBinding, publication: EnrollmentPublication, signal?: AbortSignal): Promise<EnrollmentPublication>;
  revoke(context: EnrollmentContext, signal?: AbortSignal): Promise<EnrollmentRevocationProof>;
}

export class EnrollmentEffectUnavailable extends Error {
  constructor(readonly reason: EnrollmentFailure, readonly uncertain = false) { super("Account enrollment effect is unavailable"); }
}
