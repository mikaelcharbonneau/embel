import { createHash } from "node:crypto";
import { moneySchema, type ClaimedJob, type StepOutcome } from "../../src/domain/jobs";
import { IMAGE_MODEL } from "../../src/domain/providers";
import { LOGO_CONCEPT_OPERATION, logoConceptJobInputSchema, logoResolvedConceptInputSchema, logoProviderObservationSchema, logoProviderResponseReceiptSchema, logoConceptStepOutputSchema,
  type LogoProviderObservation, type LogoProviderResponseReceipt, type LogoResolvedConceptInput, type LogoResolvedRefinementInput,
} from "../../src/domain/logo-jobs";
import { identityAssetReceiptSchema, type VerifiedAssetBytes } from "../../src/domain/logo-deliverables";
import type { IdentityAssetStore } from "../../src/server/data/identity-asset-store";
import { inspectIdentityRaster } from "../../src/features/logo-vector/server/converter";
import { resolveLogoReferenceInputs } from "../../src/server/logo-creation/reference-inputs";
import { IMAGE_INPUT_LIMITS } from "../../src/server/logo-creation/openai-image-transport";
import { LOGO_IMAGE_HANDLER_VERSION, type LogoImageProducer, type LogoImageProductionResult } from "../../src/server/logo-creation/openai-logo-provider";
import type { JobHandler } from "../runner";

export type LogoConceptHandlerDependencies = {
  producer: LogoImageProducer; assets: IdentityAssetStore; assertPolicyReady(job: ClaimedJob): Promise<void>;
  resolveInputs(job: ClaimedJob): Promise<LogoResolvedConceptInput>;
  recordProviderResponse(job: ClaimedJob, observation: LogoProviderObservation): Promise<LogoProviderResponseReceipt>;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const logoDiagnosticRequestId = (job: ClaimedJob, stepKey: string) => createHash("sha256").update(`${job.id}:${stepKey}`).digest("hex");
const inactive = (signal: AbortSignal) => { if (signal.aborted) throw new Error("Cancelled"); };
const unknownOutcome = (code: string, result?: LogoImageProductionResult): StepOutcome => ({ status: "needs_reconciliation", code,
  costMicrousd: result?.billing.status === "recorded" ? result.billing.confirmedMicrousd : 0, providerRequestId: result?.providerRequestId ?? null });

/** Shared image-step mechanics for concept and raster refinement. Immutable input
 * resolution and before-dispatch checks belong to the operation-specific step.
 * This stages bytes only; shared leased completion alone commits an output. */
export async function executeLogoRasterAttempt(options: {
  deps: Pick<LogoConceptHandlerDependencies, "producer" | "assets" | "recordProviderResponse">;
  job: ClaimedJob; input: LogoResolvedConceptInput | LogoResolvedRefinementInput; images: readonly VerifiedAssetBytes[]; stepKey: string; publicationRequestKey: string;
  signal: AbortSignal; output(publicationId: string, providerResponseReceiptId: string): Extract<StepOutcome, { status: "succeeded" }>["result"];
}): Promise<StepOutcome> {
  const { deps, job, input, images, stepKey, signal } = options;
  let result: LogoImageProductionResult;
  try { result = await deps.producer.produce(input, images, logoDiagnosticRequestId(job, stepKey), signal); }
  catch { return unknownOutcome("provider_outcome_unknown"); }
  if (result.status === "not_dispatched") return { status: "failed", code: "not_dispatched", costMicrousd: 0, providerRequestId: null };
  let artifactHash: string | null = null, normalizedPixelHash: string | undefined, invalidOutput: string | null = null;
  if (result.status === "completed") {
    try {
      if (!(result.bytes instanceof Uint8Array) || result.mimeType !== "image/png" || !result.bytes.length || result.bytes.length > IMAGE_INPUT_LIMITS.outputBytes) throw new Error("Invalid output");
      result = { ...result, bytes: Uint8Array.from(result.bytes) }; artifactHash = sha256(result.bytes);
      const raster = await inspectIdentityRaster(result.bytes, result.mimeType, signal);
      normalizedPixelHash = raster.pixelHash;
      if (raster.width !== 1024 || raster.height !== 1024) invalidOutput = "invalid_dimensions";
      else if (!raster.isMonochrome) invalidOutput = "chromatic_output";
    } catch { invalidOutput = signal.aborted ? "cancelled_after_dispatch" : "invalid_output"; }
  }
  let receipt: LogoProviderResponseReceipt;
  try {
    const observation = logoProviderObservationSchema.parse({ provider: "openai", model: IMAGE_MODEL, providerRequestId: result.providerRequestId, responseHash: result.responseHash,
      observedAt: new Date().toISOString(), billing: result.billing, artifactHash, ...(normalizedPixelHash ? { normalizedPixelHash } : {}) });
    receipt = logoProviderResponseReceiptSchema.parse(await deps.recordProviderResponse(job, observation));
    if ("version" in receipt || receipt.ownerId !== job.ownerId || receipt.projectId !== job.projectId || receipt.jobId !== job.id || receipt.leaseToken !== job.leaseToken
      || !same(logoProviderObservationSchema.parse({ provider: receipt.provider, model: receipt.model, providerRequestId: receipt.providerRequestId, responseHash: receipt.responseHash,
        observedAt: receipt.observedAt, billing: receipt.billing, artifactHash: receipt.artifactHash, ...(receipt.normalizedPixelHash ? { normalizedPixelHash: receipt.normalizedPixelHash } : {}) }), observation)) throw new Error("Receipt binding mismatch");
  } catch { return unknownOutcome("provider_evidence_unconfirmed", result); }
  const common = { costMicrousd: result.billing.status === "recorded" ? result.billing.confirmedMicrousd : 0, providerRequestId: result.providerRequestId };
  if (result.status !== "completed") {
    return result.status === "needs_reconciliation" || result.billing.status === "unknown"
      ? { status: "needs_reconciliation", code: result.billing.status === "unknown" ? "billing_unknown" : result.code, ...common }
      : { status: "failed", code: result.code, ...common };
  }
  if (invalidOutput) return result.billing.status === "unknown" || signal.aborted
    ? { status: "needs_reconciliation", code: result.billing.status === "unknown" ? "billing_unknown" : invalidOutput, ...common }
    : { status: "failed", code: invalidOutput, ...common };
  try {
    inactive(signal);
    const publication = { requestKey: options.publicationRequestKey, inputRevisions: input.inputRevisions,
      mimeType: "image/png", contentHash: artifactHash!, byteLength: result.bytes.length, source: { kind: "concept" as const, sourceId: options.publicationRequestKey } };
    const asset = identityAssetReceiptSchema.parse(await deps.assets.publishLeasedAsset(job, publication, result.bytes, signal)); inactive(signal);
    if (asset.publicationState !== "staged" || asset.reference.ownerId !== job.ownerId || asset.reference.projectId !== job.projectId || asset.reference.contentHash !== artifactHash
      || asset.verification.mimeType !== "image/png" || asset.verification.byteLength !== result.bytes.length || asset.purpose !== "brand_asset" || asset.sourceReceiptId !== options.publicationRequestKey) throw new Error("Publication binding mismatch");
    const output = options.output(asset.id, receipt.id);
    return result.billing.status === "unknown" ? { status: "needs_reconciliation", code: "billing_unknown", result: output, ...common } : { status: "succeeded", result: output, ...common };
  } catch { return unknownOutcome("publication_unknown", result); }
}

export function createLogoConceptHandler(deps: LogoConceptHandlerDependencies): JobHandler {
  return { steps(job) {
    const input = logoConceptJobInputSchema.parse(job.input);
    if (job.operation !== LOGO_CONCEPT_OPERATION || input.ownerId !== job.ownerId || input.projectId !== job.projectId || input.handlerVersion !== LOGO_IMAGE_HANDLER_VERSION) throw new Error("Invalid concept job binding");
    moneySchema.parse(job.reservedCostMicrousd);
    const key = `logo-preview-v1:${input.slotId}:${input.attemptId}`;
    return [{ key, maximumCostMicrousd: job.reservedCostMicrousd, timeoutMs: 300_000,
      async execute({ job: claimed, signal }) {
        let resolved: LogoResolvedConceptInput, images: readonly VerifiedAssetBytes[];
        try {
          inactive(signal);
          if (claimed.id !== job.id || claimed.leaseToken !== job.leaseToken || claimed.ownerId !== job.ownerId || claimed.projectId !== job.projectId) throw new Error("Claim changed");
          resolved = logoResolvedConceptInputSchema.parse(await deps.resolveInputs(claimed)); inactive(signal);
          if (!same(resolved.input, input) || !resolved.inputRevisions.some(ref => ref.stage === "brief_references" && ref.id === resolved.brief.id && ref.revision === resolved.brief.revision)) throw new Error("Frozen inputs changed");
          images = await resolveLogoReferenceInputs(claimed, resolved.referenceSnapshot, deps.assets, signal);
          await deps.assertPolicyReady(claimed); inactive(signal);
        } catch { return { status: "failed", code: "not_dispatched", costMicrousd: 0, providerRequestId: null }; }
        return executeLogoRasterAttempt({ deps, job: claimed, input: resolved, images, stepKey: key, publicationRequestKey: input.attemptId, signal,
          output: (publicationId, providerResponseReceiptId) => logoConceptStepOutputSchema.parse({ version: 2, kind: "logo_concept", batchId: input.batchId, slotId: input.slotId, attemptId: input.attemptId, publicationId, providerResponseReceiptId }) });
      },
    }];
  } };
}
