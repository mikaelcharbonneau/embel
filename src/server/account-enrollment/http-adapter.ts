import "server-only";
import { z } from "zod";
import { qualifyIdentityConnection } from "@/server/runtime/identity-qualification";
import { qualifyHomeAttachmentConnection } from "@/server/runtime/home-attachment-qualification";
import type { IdentityConnectionFactory } from "@/server/data/identity-transaction";
import type { ManagedQualification } from "@/server/runtime/managed-principal";
import { EnrollmentEffectUnavailable, type EnrollmentBindingPublisher, type EnrollmentCapabilityAdapter,
  type EnrollmentContext, type EnrollmentCredentialStore, type EnrollmentPublication } from "./contracts";
import { EnrollmentLeaseUnavailable } from "./sql-store";

const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u);
const reservationSchema = z.strictObject({ reference, verifier: z.string().regex(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/u) });
const publicationSchema = z.strictObject({ ownerId: z.uuid(), generation: z.number().int().positive(), revision: z.number().int().positive(), operationKey: z.uuid(),
  capability: z.enum(["home_attachments", "identity_transactions", "strategy", "naming", "logo"]), receipt: reference });
type Qualify = (factory: IdentityConnectionFactory, ownerId: string, roleName: string, roleOid: number, signal?: AbortSignal, managed?: ManagedQualification) => Promise<void>;

function active(signal?: AbortSignal) { if (signal?.aborted) throw new EnrollmentLeaseUnavailable(); }
function boundPublication(context: EnrollmentContext, value: unknown): EnrollmentPublication {
  const parsed = publicationSchema.safeParse(value);
  if (!parsed.success || parsed.data.ownerId !== context.claim.ownerId || parsed.data.generation !== context.claim.generation ||
    parsed.data.revision !== context.claim.revision ||
    parsed.data.operationKey !== context.step.operationKey || parsed.data.capability !== context.step.capability) {
    throw new EnrollmentEffectUnavailable("publication_unavailable", true);
  }
  return parsed.data;
}
async function current(context: EnrollmentContext, signal?: AbortSignal): Promise<EnrollmentContext> {
  active(signal);
  const claim = await context.store.read(context.claim);
  const step = claim.steps.find(candidate => candidate.capability === context.step.capability)!;
  if (claim.mode !== context.claim.mode || step.operationKey !== context.step.operationKey) throw new EnrollmentLeaseUnavailable();
  return { claim, step, store: context.store };
}

/** Concrete SQL/helper workflow with explicit approved durable secret-store and
 * publication ports. Missing ports stop before effects; there is no fabricated
 * store, plaintext password, administrator connection, or service-role fallback. */
export function createHttpEnrollmentAdapter(dependencies: {
  credentials: EnrollmentCredentialStore | null;
  publisher: EnrollmentBindingPublisher | null;
}): EnrollmentCapabilityAdapter {
  return {
    async reconcile(initial, signal) {
      if (!dependencies.credentials) throw new EnrollmentEffectUnavailable("store_unavailable");
      if (!dependencies.publisher) throw new EnrollmentEffectUnavailable("publication_unavailable");
      let context = await current(initial, signal);
      if (context.claim.mode !== "enroll" || !["home_attachments", "identity_transactions"].includes(context.step.capability)) throw new EnrollmentLeaseUnavailable();
      if (context.step.phase === "ready") return;
      const capability = context.step.capability as "home_attachments" | "identity_transactions";
      if (["pending", "provisioning", "credential_reserved", "blocked", "uncertain"].includes(context.step.phase)) {
        // The durable operation identity exists before contacting the external
        // store. Its reservation must be atomic and stable across this key.
        await context.store.record(context.claim, capability, "provisioning");
        context = await current(context, signal);
      }
      let reserved;
      try { reserved = reservationSchema.parse(await dependencies.credentials.reserve(context, signal)); }
      catch (error) {
        if (error instanceof EnrollmentEffectUnavailable || error instanceof EnrollmentLeaseUnavailable) throw error;
        throw new EnrollmentEffectUnavailable("store_unavailable", true);
      }
      context = await current(context, signal);
      if (context.step.credentialRef && context.step.credentialRef !== reserved.reference) throw new EnrollmentEffectUnavailable("store_unavailable", true);
      if (!["provisioned", "published"].includes(context.step.phase)) {
        await context.store.record(context.claim, capability, "credential_reserved", reserved.reference);
        context = await current(context, signal);
      }
      const binding = await context.store.provisionHttp(context.claim, capability, reserved);
      context = await current(context, signal);
      let publication: EnrollmentPublication;
      try {
        publication = boundPublication(context, await dependencies.publisher.publish(context, binding, signal));
      } catch (error) {
        if (error instanceof EnrollmentEffectUnavailable || error instanceof EnrollmentLeaseUnavailable) throw error;
        throw new EnrollmentEffectUnavailable("publication_unavailable", true);
      }
      context = await current(context, signal);
      await context.store.record(context.claim, capability, "published", publication.receipt);
      context = await current(context, signal);
      try {
        const factory = await dependencies.credentials.connections(reserved.reference, binding, signal);
        active(signal);
        const qualifier: Qualify = capability === "home_attachments" ? qualifyHomeAttachmentConnection : qualifyIdentityConnection;
        await qualifier(factory, binding.ownerId, binding.roleName, binding.roleOid, signal, {
          managementVersion: 2, generation: binding.generation, revision: binding.revision, operationKey: binding.operationKey,
          capability, managerRoleName: binding.managerRoleName, managerRoleOid: binding.managerRoleOid,
        });
        context = await current(context, signal);
        const observed = boundPublication(context, await dependencies.publisher.verify(context, binding, publication, signal));
        if (observed.receipt !== publication.receipt) throw new EnrollmentEffectUnavailable("verification_unavailable", true);
      } catch (error) {
        if (error instanceof EnrollmentEffectUnavailable || error instanceof EnrollmentLeaseUnavailable) throw error;
        throw new EnrollmentEffectUnavailable("verification_unavailable", true);
      }
      context = await current(context, signal);
      await context.store.record(context.claim, capability, "ready", `qualified:${context.step.operationKey}`);
    },
    async revoke(initial, signal) {
      const context = await current(initial, signal);
      if (context.claim.mode !== "revoke" || !["home_attachments", "identity_transactions"].includes(context.step.capability)) throw new EnrollmentLeaseUnavailable();
      // SQL NOLOGIN acknowledgement precedes the independent runtime/Storage
      // withdrawal proof. A provider Auth403 is never converted into that proof.
      await context.store.lockHttp(context.claim, context.step.capability as "home_attachments" | "identity_transactions");
      if (!dependencies.credentials || !dependencies.publisher) throw new EnrollmentEffectUnavailable("verification_unavailable", true);
      const locked = await current(context, signal);
      const proof = await dependencies.publisher.revoke(locked, signal);
      await current(locked, signal);
      await dependencies.credentials.retire(locked, signal);
      await current(locked, signal);
      return proof;
    },
  };
}
