import { z } from "zod";
import { moneySchema, type ClaimedJob } from "../src/domain/jobs";
import { logoOperationSchema, logoDirectionsSubscriptionPolicySchema } from "../src/domain/logo-jobs";
import { logoHashSchema, logoIdentifierSchema } from "../src/domain/logo-vector";
import type { LogoWorkerConnection } from "../src/server/data/logo-jobs";
import { canonicalIdentityInput } from "../src/features/identity-directions/model/font-check-binding";
import { logoVectorProposalTextPolicySchema, logoVectorProposalJobInputSchema } from "../src/domain/logo-vector-proposal-jobs";
import { qualifiedLogoVectorProposalCapability } from "./logo-vector-proposal-capability";
import { NotDispatchedError } from "./runner";

const capabilitySchema = z.strictObject({
  operation: logoOperationSchema.or(z.literal("identity.logo_vector_propose")),
  policyIdentity: logoHashSchema,
  handlerVersion: logoIdentifierSchema,
  provider: logoIdentifierSchema.nullable(),
  model: logoIdentifierSchema.nullable(),
  engine: z.strictObject({ id: logoIdentifierSchema, version: logoIdentifierSchema, artifactHash: logoHashSchema }).nullable(),
  maxCostMicrousd: moneySchema,
  billingMode: z.literal("chatgpt_subscription").optional(),
  policy: logoDirectionsSubscriptionPolicySchema.optional(),
  textPolicy: logoVectorProposalTextPolicySchema.optional(),
}).superRefine((value,ctx)=>{
  if (value.operation === "identity.logo_vector_propose" ? !qualifiedLogoVectorProposalCapability(value) : value.textPolicy !== undefined) ctx.addIssue({ code: "custom", message: "Only the exact vector proposal operation may carry its required text policy" });
  if((value.billingMode===undefined)!==(value.policy===undefined)||value.policy&&(value.operation!=="identity.logo_directions"||value.handlerVersion!==value.policy.handlerVersion||value.model!==value.policy.model||value.provider!=="openai"||value.engine!==null||value.maxCostMicrousd!==0))ctx.addIssue({code:"custom",message:"Subscription readiness requires the exact paired zero-API directions policy"});
}).refine(value => (value.provider === null) === (value.model === null), "Provider and model must match");
export type LogoWorkerCapability = Readonly<Omit<z.infer<typeof capabilitySchema>, "engine"> & {
  engine: Readonly<NonNullable<z.infer<typeof capabilitySchema>["engine"]>> | null;
}>;

/** Descriptors are trusted injected configuration, never evidence of live access.
 * SQL separately verifies the exact enabled owner-bound policy on every report. */
export function freezeLogoWorkerManifest(input: unknown): readonly LogoWorkerCapability[] {
  const entries = z.array(capabilitySchema).max(6).refine(values => new Set(values.map(value => value.operation)).size === values.length, "Duplicate operation").parse(input);
  return Object.freeze(entries.map(entry => Object.freeze({ ...entry, engine: entry.engine === null ? null : Object.freeze(entry.engine), ...(entry.textPolicy ? { textPolicy: Object.freeze(entry.textPolicy) } : {}), ...(entry.policy ? {policy: Object.freeze({...entry.policy,limits:Object.freeze(entry.policy.limits)})} : {}) })));
}

export type LogoReadinessInput = {
  connection: LogoWorkerConnection;
  workerId: string;
  manifest: readonly LogoWorkerCapability[];
  readinessSeconds?: number;
};
export function createLogoReadiness(input: LogoReadinessInput) {
  const workerId = z.string().min(1).max(200).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value)).parse(input.workerId);
  const seconds = z.number().int().min(1).max(90).parse(input.readinessSeconds ?? 60);
  const manifest = freezeLogoWorkerManifest(input.manifest), serialized = JSON.stringify(manifest);
  const connection = input.connection;
  if (!connection || typeof connection.query !== "function") throw new Error("Logo worker connection is required");
  let readyUntil = 0, closed = false, pending: Promise<boolean> | undefined;
  const isReady = () => !closed && readyUntil > performance.now();
  function unavailable(): never { throw new NotDispatchedError("Logo runtime is unavailable"); }
  const accepted = (rows: { value: unknown }[]) => rows.length === 1 && rows[0]?.value === true;
  function refresh(): Promise<boolean> {
    if (closed) return Promise.resolve(false);
    if (pending) return pending;
    // A pending/failed acknowledgement cannot authorize a subsequent claim.
    readyUntil = 0;
    const started = performance.now();
    pending = (async () => {
      try {
        const result = await connection.query<{ value: unknown }>("select public.report_logo_worker_ready($1,$2,$3) value", [workerId, serialized, seconds]);
        if (!closed && accepted(result.rows)) readyUntil = started + seconds * 1000;
        return isReady();
      } catch { return false; }
    })().finally(() => { pending = undefined; });
    return pending;
  }
  async function assertReady(job: ClaimedJob): Promise<void> {
    if (!isReady()) unavailable();
    const capability = manifest.find(value => value.operation === job.operation);
    const frozen = job.input as Record<string, unknown> | null;
    if (!capability || !frozen || frozen.operation !== job.operation || frozen.ownerId !== job.ownerId || frozen.projectId !== job.projectId
      || frozen.policyIdentity !== capability.policyIdentity || frozen.handlerVersion !== capability.handlerVersion
      || !moneySchema.safeParse(job.reservedCostMicrousd).success || job.reservedCostMicrousd > capability.maxCostMicrousd) unavailable();
    if (capability.policy ? frozen.billingMode !== "chatgpt_subscription" || !frozen.policy || canonicalIdentityInput(frozen.policy) !== canonicalIdentityInput(capability.policy) || job.actualCostMicrousd !== 0 : frozen.billingMode !== undefined || frozen.policy !== undefined) unavailable();
    if (capability.textPolicy) {
      const proposal = logoVectorProposalJobInputSchema.safeParse(frozen);
      if (!proposal.success || canonicalIdentityInput(proposal.data.textPolicy) !== canonicalIdentityInput(capability.textPolicy)
        || job.reservedCostMicrousd !== capability.maxCostMicrousd || job.actualCostMicrousd !== 0) unavailable();
    } else if (frozen.textPolicy !== undefined) unavailable();
    if (capability.engine !== null) {
      const engine = frozen.engine as Record<string, unknown> | null;
      if (!engine || engine.id !== capability.engine.id || engine.version !== capability.engine.version || engine.artifactHash !== capability.engine.artifactHash) unavailable();
    }
    try {
      const result = await connection.query<{ value: unknown }>("select public.read_leased_logo_record($1,$2,'runtime_readiness',null) value", [job.id, job.leaseToken]);
      if (!accepted(result.rows) || !isReady()) unavailable();
    } catch {
      readyUntil = 0;
      unavailable();
    }
  }
  return Object.freeze({ manifest, isReady, refresh, assertReady,
    close(): Promise<void> {
      closed = true; readyUntil = 0;
      // Fence synchronously, then let the caller drain an already-started report.
      // Closing never starts new I/O and its drain promise cannot reject.
      return pending?.then(() => {}, () => {}) ?? Promise.resolve();
    },
  });
}
