import "server-only";
import { z } from "zod";
import { enrollmentCapabilities, EnrollmentEffectUnavailable, type EnrollmentCapability, type EnrollmentCapabilityAdapter,
  type EnrollmentClaim, type EnrollmentContext, type EnrollmentRevocationProof, type EnrollmentStore } from "./contracts";
import { EnrollmentLeaseUnavailable } from "./sql-store";

const proofFields = { ownerId: z.uuid(), generation: z.number().int().positive(), revision: z.number().int().positive(), operationKey: z.uuid(),
  capability: z.enum(enrollmentCapabilities), receipt: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u),
  observedAt: z.iso.datetime({ offset: true }), authorityDisabled: z.literal(true), storageDenied: z.literal(true) };
const proofSchema = z.union([
  z.strictObject({ ...proofFields, runtimeStopped: z.literal(true) }),
  // Exact SQL absence is a separate scope, never an invented stopped process.
  z.strictObject({ ...proofFields, capability: z.enum(["strategy", "naming", "logo"]), scope: z.literal("never_provisioned"), authorityAbsent: z.literal(true) }),
]);

/** Only fresh independent authority/process/Storage observations authorize a
 * revocation acknowledgement. A denied Auth request alone is not such proof. */
export function validateEnrollmentRevocation(context: EnrollmentContext, value: unknown, now = Date.now()): EnrollmentRevocationProof {
  const proof = proofSchema.safeParse(value);
  const observed = proof.success ? Date.parse(proof.data.observedAt) : NaN;
  if (!proof.success || proof.data.ownerId !== context.claim.ownerId || proof.data.generation !== context.claim.generation ||
    proof.data.revision !== context.claim.revision ||
    proof.data.operationKey !== context.step.operationKey || proof.data.capability !== context.step.capability ||
    !Number.isFinite(observed) || observed > now + 5000 || observed < now - 30_000 || observed > Date.parse(context.claim.leaseUntil)) {
    throw new EnrollmentEffectUnavailable("verification_unavailable", true);
  }
  return proof.data;
}

async function bounded<T>(signal: AbortSignal, effect: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new EnrollmentLeaseUnavailable();
  let rejectAborted!: (reason: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const stop = () => rejectAborted(new EnrollmentLeaseUnavailable());
  signal.addEventListener("abort", stop, { once: true });
  try { return await Promise.race([Promise.resolve().then(() => { if (signal.aborted) throw new EnrollmentLeaseUnavailable(); return effect(); }), aborted]); }
  finally { signal.removeEventListener("abort", stop); }
}

/** One leased owner per invocation. No paid work, fresh operation identity,
 * provider retry, credential discovery or automatic activation is performed. */
export async function reconcileAccountEnrollmentOnce(store: EnrollmentStore,
  adapters: Readonly<Partial<Record<EnrollmentCapability, EnrollmentCapabilityAdapter>>>, options: { signal?: AbortSignal; now?: () => number } = {}) {
  if (options.signal?.aborted) return { status: "stopped" } as const;
  const initial = await store.claim();
  if (!initial) return { status: "idle" } as const;
  const now = options.now ?? Date.now;
  const remaining = Date.parse(initial.leaseUntil) - now();
  if (!Number.isFinite(remaining) || remaining <= 0) return { status: "stopped" } as const;
  const expires = new AbortController(), timer = setTimeout(() => expires.abort(), Math.min(remaining, 120_000));
  const signal = options.signal ? AbortSignal.any([options.signal, expires.signal]) : expires.signal;
  let claim: EnrollmentClaim = initial;
  const revoked: EnrollmentCapability[] = [];
  try {
    for (const capability of enrollmentCapabilities) {
      claim = await store.read(claim);
      if (signal.aborted) throw new EnrollmentLeaseUnavailable();
      const step = claim.steps.find(candidate => candidate.capability === capability)!;
      const context: EnrollmentContext = { claim, step, store };
      if (claim.mode === "revoke") {
        if (step.phase === "revoked") continue;
        const adapter = adapters[capability];
        if (!step.effectsStarted && !step.credentialRef && !step.publicationReceipt && !step.verificationReceipt) {
          // SQL proves that no effect was begun for this operation. finish still
          // independently rejects a managed HTTP role that remains LOGIN.
          await store.acknowledgeRevocation(claim, capability, `no-effects:${step.operationKey}`);
          claim = await store.read(claim); revoked.push(capability); continue;
        }
        if (!adapter) continue;
        try {
          const proof = await bounded(signal, () => adapter.revoke(context, signal));
          const verified = validateEnrollmentRevocation(context, proof, now());
          claim = await store.read(claim);
          await store.acknowledgeRevocation(claim, capability, verified.receipt);
          claim = await store.read(claim); revoked.push(capability);
        } catch (error) { if (error instanceof EnrollmentLeaseUnavailable || signal.aborted) throw new EnrollmentLeaseUnavailable(); }
        continue;
      }
      const adapter = adapters[capability];
      if (step.phase === "ready") {
        if (!adapter?.maintain) continue;
        try {
          await bounded(signal, () => adapter.maintain!(context, signal));
          claim = await store.read(claim);
        } catch (error) {
          if (error instanceof EnrollmentLeaseUnavailable || signal.aborted) throw new EnrollmentLeaseUnavailable();
          // The adapter's narrow SQL guard closes stale admission separately.
          // Never overwrite a ready phase here: existing observation/receipt
          // authority may still be needed for an issued provider request.
          claim = await store.read(claim);
        }
        continue;
      }
      if (!adapter) { claim = await store.record(claim, capability, "blocked", "adapter_unavailable"); continue; }
      try {
        await bounded(signal, () => adapter.reconcile(context, signal));
        // The adapter's return is not a capability acknowledgement. SQL is read
        // again even if a buggy adapter reports success without durable phases.
        claim = await store.read(claim);
      } catch (error) {
        if (error instanceof EnrollmentLeaseUnavailable || signal.aborted) throw new EnrollmentLeaseUnavailable();
        const reason = error instanceof EnrollmentEffectUnavailable ? error.reason : "effect_unknown";
        const uncertain = !(error instanceof EnrollmentEffectUnavailable) || error.uncertain;
        claim = await store.read(claim);
        const latest = claim.steps.find(candidate => candidate.capability === capability)!;
        if (latest.phase !== "ready") claim = await store.record(claim, capability, uncertain ? "uncertain" : "blocked", reason);
      }
    }
    claim = await store.read(claim);
    if (signal.aborted) throw new EnrollmentLeaseUnavailable();
    return { status: "processed", enrollment: await store.finish(claim, revoked) } as const;
  } catch (error) {
    if (error instanceof EnrollmentLeaseUnavailable || signal.aborted) return { status: "stopped" } as const;
    throw new EnrollmentEffectUnavailable("effect_unknown", true);
  } finally { clearTimeout(timer); }
}
