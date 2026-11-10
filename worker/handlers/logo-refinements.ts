import { moneySchema, type ClaimedJob } from "../../src/domain/jobs";
import { logoRefinementJobInputSchema, logoResolvedRefinementInputSchema, logoRefinementStepOutputSchema, type LogoResolvedRefinementInput } from "../../src/domain/logo-jobs";
import type { VerifiedAssetBytes } from "../../src/domain/logo-deliverables";
import { LOGO_IMAGE_HANDLER_VERSION } from "../../src/server/logo-creation/openai-logo-provider";
import { resolveLogoReferenceInputs } from "../../src/server/logo-creation/reference-inputs";
import { inspectIdentityRaster, verifyLogoRasterSource } from "../../src/features/logo-vector/server/converter";
import { executeLogoRasterAttempt, LOGO_IMAGE_STEP_TIMEOUT_MS, type LogoConceptHandlerDependencies } from "./logo-concepts";
import type { JobHandler } from "../runner";

/** The reviewed raster adapter cannot preserve component locks. Vector-source
 * refinement remains unavailable until P3's candidate facade is implemented and
 * independently reviewed. No raster-only substitute or automatic conversion. */
export type LogoRefinementHandlerDependencies = Omit<LogoConceptHandlerDependencies, "resolveInputs"> & {
  resolveInputs(job: ClaimedJob): Promise<LogoResolvedRefinementInput>;
  loadGeneratedRaster(job: ClaimedJob, signal: AbortSignal): Promise<VerifiedAssetBytes>;
  vectorRefinement: null;
};
const inactive = (signal: AbortSignal) => { if (signal.aborted) throw new Error("Cancelled"); };
export function createLogoRefinementHandler(deps: LogoRefinementHandlerDependencies): JobHandler {
  return { steps(job) {
    const input = logoRefinementJobInputSchema.parse(job.input);
    if (job.operation !== "identity.logo_refine" || input.ownerId !== job.ownerId || input.projectId !== job.projectId || input.handlerVersion !== LOGO_IMAGE_HANDLER_VERSION) throw new Error("Invalid refinement job binding");
    if (input.source.kind !== "preview") throw new Error("Vector refinement unavailable");
    moneySchema.parse(job.reservedCostMicrousd);
    return [{ key: "generate-refinement", maximumCostMicrousd: job.reservedCostMicrousd, timeoutMs: LOGO_IMAGE_STEP_TIMEOUT_MS,
      async execute({ job: claimed, signal }) {
        let resolved: LogoResolvedRefinementInput, images: readonly VerifiedAssetBytes[];
        try {
          inactive(signal);
          if (claimed.id !== job.id || claimed.leaseToken !== job.leaseToken || claimed.ownerId !== job.ownerId || claimed.projectId !== job.projectId) throw new Error("Claim changed");
          resolved = logoResolvedRefinementInputSchema.parse(await deps.resolveInputs(claimed)); inactive(signal);
          if (JSON.stringify(resolved.input) !== JSON.stringify(input) || !resolved.inputRevisions.some(ref => ref.stage === "brief_references" && ref.id === resolved.brief.id && ref.revision === resolved.brief.revision)) throw new Error("Frozen inputs changed");
          const read = await deps.assets.readLeasedAsset(claimed, resolved.basePreview, signal); inactive(signal);
          const base = { ...read, reference: { ...read.reference }, verification: { ...read.verification }, bytes: Uint8Array.from(read.bytes) };
          if (["ownerId", "projectId", "assetId", "versionId", "contentHash"].some(key => base.reference[key as keyof typeof base.reference] !== resolved.basePreview[key as keyof typeof resolved.basePreview])) throw new Error("Base preview changed");
          verifyLogoRasterSource(base); await inspectIdentityRaster(base.bytes, base.mimeType, signal); inactive(signal);
          images = [{ ...base, bytes: Uint8Array.from(base.bytes) }, ...await resolveLogoReferenceInputs(claimed, resolved.referenceSnapshot, deps.assets, signal)];
          await deps.assertPolicyReady(claimed); inactive(signal);
        } catch { return { status: "failed", code: "not_dispatched", costMicrousd: 0, providerRequestId: null }; }
        return executeLogoRasterAttempt({ deps, job: claimed, input: resolved, images, stepKey: "generate-refinement", publicationRequestKey: input.rasterRevisionId, signal,
          output: (publicationId, providerResponseReceiptId) => logoRefinementStepOutputSchema.parse({ version: 2, kind: "logo_refinement_raster", rasterRevisionId: input.rasterRevisionId, publicationId, providerResponseReceiptId }) });
      },
    }];
  } };
}
