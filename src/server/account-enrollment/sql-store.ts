import "server-only";
import { z } from "zod";
import { enrollmentClaimSchema, enrollmentStatusSchema, EnrollmentEffectUnavailable,
  type EnrollmentClaim, type EnrollmentHttpBinding, type EnrollmentOperatorPort, type EnrollmentStore } from "./contracts";

/** A stale/foreign/expired lease stops the owner workflow, not a fresh retry. */
export class EnrollmentLeaseUnavailable extends Error {
  constructor() { super("Account enrollment lease is unavailable"); }
}
const bindingSchema = z.strictObject({
  managementVersion: z.literal(2), ownerId: z.uuid(), generation: z.number().int().positive(), revision: z.number().int().positive(),
  capability: z.enum(["home_attachments", "identity_transactions"]), operationKey: z.uuid(),
  roleName: z.string().regex(/^(?:embel_home_web_|embel_identity_web_)[a-z0-9_]+$/u).max(63), roleOid: z.number().int().positive().max(4_294_967_295),
  managerRoleName: z.literal("embel_account_role_manager"), managerRoleOid: z.number().int().positive().max(4_294_967_295),
  credentialRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u),
});
function sameLease(expected: EnrollmentClaim, actual: EnrollmentClaim) {
  if (actual.id !== expected.id || actual.ownerId !== expected.ownerId || actual.generation !== expected.generation ||
    actual.revision !== expected.revision || actual.leaseToken !== expected.leaseToken || actual.mode !== expected.mode ||
    expected.steps.some(step => {
      const next = actual.steps.find(candidate => candidate.capability === step.capability);
      return !next || next.operationKey !== step.operationKey || step.credentialRef !== null && next.credentialRef !== step.credentialRef ||
        step.publicationReceipt !== null && next.publicationReceipt !== step.publicationReceipt ||
        step.verificationReceipt !== null && next.verificationReceipt !== step.verificationReceipt;
    })) throw new EnrollmentLeaseUnavailable();
  return actual;
}

/** Every SQL name and parameter position is fixed. No caller-provided owner,
 * namespace, SQL fragment, role/grant list or credentials are serialized in errors. */
export function createSqlEnrollmentStore(operator: EnrollmentOperatorPort): EnrollmentStore {
  async function invoke<T>(text: string, values: readonly unknown[], schema: z.ZodType<T>): Promise<T> {
    let rows: unknown[];
    try { rows = (await operator.query(text, values)).rows; }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "42501") throw new EnrollmentLeaseUnavailable();
      throw new EnrollmentEffectUnavailable("effect_unknown", true);
    }
    const row = z.strictObject({ value: z.unknown() }).safeParse(rows[0]);
    if (rows.length !== 1 || !row.success) throw new EnrollmentEffectUnavailable("effect_unknown", true);
    const result = schema.safeParse(row.data.value);
    if (!result.success) throw new EnrollmentEffectUnavailable("effect_unknown", true);
    return result.data;
  }
  const bound = async (claim: EnrollmentClaim, text: string, values: readonly unknown[]) =>
    sameLease(claim, await invoke(text, values, enrollmentClaimSchema));
  return {
    operator,
    claim: () => invoke("SELECT public.claim_account_service_enrollment($1::integer) AS value", [120], enrollmentClaimSchema.nullable()),
    read: claim => bound(claim, "SELECT public.read_account_service_enrollment_claim($1::uuid,$2::uuid) AS value", [claim.id, claim.leaseToken]),
    record: (claim, capability, phase, reference) => bound(claim,
      "SELECT public.record_account_service_enrollment($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS value",
      [claim.id, claim.leaseToken, capability, phase, reference ?? null]),
    async provisionHttp(claim, capability, reservation): Promise<EnrollmentHttpBinding> {
      const binding = await invoke("SELECT public.provision_account_enrollment_http($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS value",
        [claim.id, claim.leaseToken, capability, reservation.reference, reservation.verifier], bindingSchema);
      const step = claim.steps.find(candidate => candidate.capability === capability);
      if (!step || binding.ownerId !== claim.ownerId || binding.generation !== claim.generation || binding.revision !== claim.revision ||
        binding.capability !== capability || binding.operationKey !== step.operationKey || binding.credentialRef !== reservation.reference ||
        (capability === "home_attachments" ? !binding.roleName.startsWith("embel_home_web_") : !binding.roleName.startsWith("embel_identity_web_"))) {
        throw new EnrollmentLeaseUnavailable();
      }
      return binding;
    },
    async lockHttp(claim, capability) {
      const result = await invoke("SELECT public.revoke_account_enrollment_http($1::uuid,$2::uuid,$3::text) AS value",
        [claim.id, claim.leaseToken, capability], z.strictObject({ ownerId: z.uuid(), generation: z.number().int().positive(),
          capability: z.enum(["home_attachments", "identity_transactions"]), locked: z.literal(true) }));
      if (result.ownerId !== claim.ownerId || result.generation !== claim.generation || result.capability !== capability) throw new EnrollmentLeaseUnavailable();
    },
    async acknowledgeRevocation(claim, capability, receipt) {
      const result = await invoke("SELECT public.acknowledge_account_enrollment_revocation($1::uuid,$2::uuid,$3::text,$4::text) AS value",
        [claim.id, claim.leaseToken, capability, receipt], z.strictObject({ ownerId: z.uuid(), generation: z.number().int().positive(),
          capability: z.enum(["home_attachments", "identity_transactions", "strategy", "naming", "logo"]), acknowledged: z.literal(true) }));
      if (result.ownerId !== claim.ownerId || result.generation !== claim.generation || result.capability !== capability) throw new EnrollmentLeaseUnavailable();
    },
    async finish(claim, revoked = []) {
      const result = await invoke("SELECT public.finish_account_service_enrollment($1::uuid,$2::uuid,$3::text[]) AS value",
        [claim.id, claim.leaseToken, [...revoked]], enrollmentStatusSchema);
      if (result.ownerId !== claim.ownerId || result.generation < claim.generation || result.generation > claim.generation + 1) throw new EnrollmentLeaseUnavailable();
      return result;
    },
  };
}
