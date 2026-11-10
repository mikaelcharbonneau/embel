import { createHash } from "node:crypto";
import { identityAssetReceiptSchema, type IdentityAssetReceipt } from "../../src/domain/logo-deliverables";
import { logoVectorizeJobInputSchema, logoVectorStepOutputSchema } from "../../src/domain/logo-jobs";
import type { ClaimedJob, StepOutcome } from "../../src/domain/jobs";
import { LogoVectorError } from "../../src/features/logo-vector/model/errors";
import { assertLogoConversionNotAborted, convertLogoRaster, type LogoVectorWorkInput, type LogoVectorConversionResult } from "../../src/features/logo-vector/server/converter";
import type { JobHandler } from "../runner";
import { QUALIFIED_VTRACER } from "../../src/server/image-process/engine";

export const LOGO_VECTOR_HANDLER_VERSION = "1";
export type LogoVectorHandlerDependencies = {
  assertReady: (job: ClaimedJob) => Promise<void>;
  loadInput: (job: ClaimedJob, signal: AbortSignal) => Promise<LogoVectorWorkInput>;
  publish: (job: ClaimedJob, result: LogoVectorConversionResult, signal: AbortSignal) => Promise<IdentityAssetReceipt>;
};
/** The injected adapters resolve frozen sources/current lease and commit the whole publication group. */
export function createLogoVectorHandler(deps: LogoVectorHandlerDependencies): JobHandler {
  return { steps(job) {
    const frozen = logoVectorizeJobInputSchema.parse(job.input);
    if (frozen.handlerVersion !== LOGO_VECTOR_HANDLER_VERSION || job.operation !== frozen.operation || job.ownerId !== frozen.ownerId || job.projectId !== frozen.projectId || frozen.engine.id !== "vtracer" ||
      frozen.engine.version !== QUALIFIED_VTRACER.version || frozen.engine.artifactHash !== QUALIFIED_VTRACER.wasm) throw new LogoVectorError("engine_unavailable", "The job does not bind the qualified conversion engine.");
    return [{ key: "convert-vector", maximumCostMicrousd: 0, timeoutMs: 75_000,
      async execute({ job: current, signal }): Promise<StepOutcome> {
        let publishing = false;
        try {
          assertLogoConversionNotAborted(signal);
          if (current.id !== job.id || current.leaseToken !== job.leaseToken || current.ownerId !== job.ownerId || current.projectId !== job.projectId) throw new LogoVectorError("source_mismatch", "The conversion lease does not match the frozen job.");
          const input = await deps.loadInput(current, signal);
          assertLogoConversionNotAborted(signal);
          if (input.source.reference.ownerId !== current.ownerId || input.source.reference.projectId !== current.projectId ||
            input.settings.preset !== frozen.settings.preset || input.settings.simplify !== frozen.settings.simplify || input.settings.filterSpeckle !== frozen.settings.filterSpeckle || input.settings.maxColors !== frozen.settings.maxColors) throw new LogoVectorError("source_mismatch", "The loaded conversion source or settings differ from the frozen job.");
          try { await deps.assertReady(current); }
          catch { return { status: "failed", code: "not_dispatched", costMicrousd: 0, providerRequestId: null }; }
          assertLogoConversionNotAborted(signal);
          const result = await convertLogoRaster(input, signal);
          assertLogoConversionNotAborted(signal);
          publishing = true;
          const receipt = identityAssetReceiptSchema.parse(await deps.publish(current, result, signal));
          // This adapter never accepts a logo. Central publication retains review_required.
          if (receipt.reference.ownerId !== current.ownerId || receipt.reference.projectId !== current.projectId || receipt.purpose !== "brand_asset" ||
            receipt.verification.mimeType !== "image/svg+xml" || receipt.verification.byteLength !== result.svg.length || receipt.reference.contentHash !== createHash("sha256").update(result.svg).digest("hex")) throw new Error("Invalid publication result");
          assertLogoConversionNotAborted(signal);
          return { status: "succeeded", costMicrousd: 0, providerRequestId: null, result: logoVectorStepOutputSchema.parse({ version: 2, kind: "logo_vector", publicationId: receipt.id }) };
        } catch (error) {
          if (publishing) return { status: "needs_reconciliation", code: "logo_publication_unknown", costMicrousd: 0, providerRequestId: null };
          return { status: "failed", code: error instanceof LogoVectorError ? error.code : "logo_conversion_unavailable", costMicrousd: 0, providerRequestId: null };
        }
      },
    }];
  } };
}
