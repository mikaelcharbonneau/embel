import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ClaimedJob, StepOutcome } from "../../src/domain/jobs";
import { logoStyleNoteJobInputSchema, logoStyleNoteObservationSchema, logoStyleNoteResponseReceiptSchema, logoStyleNoteStagedSchema,
 type LogoStyleNoteObservation } from "../../src/domain/logo-jobs";
import { logoAssetReferenceSchema } from "../../src/domain/logo-vector";
import { logoStyleNoteSchema, type LogoStyleNote } from "../../src/domain/logo-style-notes";
import type { IdentityAssetStore } from "../../src/server/data/identity-asset-store";
import type { StyleNoteImage, StyleNoteProvider } from "../shared-lanes/logo-style-notes-api";
import type { JobHandler } from "../runner";

export type LogoStyleNoteDependencies = {
 provider: StyleNoteProvider; assets: IdentityAssetStore;
 /** The frozen job input and its one reference, read back under the lease. */
 loadInput(job: ClaimedJob): Promise<unknown>;
 /** The upload decoded in the isolated raster child and placed on white. */
 onWhite(bytes: Uint8Array, mimeType: string, signal: AbortSignal): Promise<StyleNoteImage>;
 assertReady(job: ClaimedJob): Promise<void>;
 recordResponse(job: ClaimedJob, observation: LogoStyleNoteObservation): Promise<unknown>;
 stage(job: ClaimedJob, note: LogoStyleNote, receiptId: string): Promise<unknown>;
};
const loadedSchema = z.strictObject({ input: z.unknown(), reference: z.strictObject({ referenceId: z.uuid(), asset: logoAssetReferenceSchema,
 sourceKind: z.literal("upload"), rightsEvidenceId: z.uuid() }) });

/** One step: read the exact frozen upload, describe it once, record the actual
 * usage, then store the note. Proven non-dispatch is free; an unclear outcome is
 * left for review and never repeated. */
export function createLogoStyleNoteHandler(deps: LogoStyleNoteDependencies): JobHandler {
 return { steps(job) {
  const input = logoStyleNoteJobInputSchema.parse(job.input);
  if (job.operation !== input.operation || input.ownerId !== job.ownerId || input.projectId !== job.projectId || job.reservedCostMicrousd !== 0) throw new Error("Style note job binding is invalid.");
  return [{ key: "write-style-note", maximumCostMicrousd: 0, timeoutMs: input.apiPolicy.deadlineMs + 60_000,
   async execute({ job: claimed, signal }): Promise<StepOutcome> {
    let image: StyleNoteImage;
    try {
     signal.throwIfAborted();
     if (claimed.id !== job.id || claimed.leaseToken !== job.leaseToken || !isDeepStrictEqual(claimed.input, job.input)) throw new Error("Claim changed.");
     const loaded = loadedSchema.parse(await deps.loadInput(claimed));
     if (!isDeepStrictEqual(loaded.input, claimed.input) || loaded.reference.referenceId !== input.referenceId || !isDeepStrictEqual(loaded.reference.asset, input.asset)) throw new Error("Input changed.");
     const file = await deps.assets.readLeasedAsset(claimed, input.asset, signal);
     if (!isDeepStrictEqual(file.reference, input.asset)) throw new Error("Reference changed.");
     image = await deps.onWhite(file.bytes, file.mimeType, signal);
     await deps.assertReady(claimed); signal.throwIfAborted();
    } catch { return { status: "failed", code: "not_dispatched", costMicrousd: 0, providerRequestId: null }; }
    let outcome: StepOutcome, observation: LogoStyleNoteObservation;
    try {
     const result = await deps.provider.describe(image, signal, { job: claimed, beforeDispatch: async current => {
      if (!isDeepStrictEqual(current, claimed)) throw new Error("Dispatch claim changed."); await deps.assertReady(current); signal.throwIfAborted(); } });
     outcome = result.outcome; observation = logoStyleNoteObservationSchema.parse(result.observation);
     if (!isDeepStrictEqual(observation.apiPolicy, input.apiPolicy)) throw new Error("Observation policy mismatch.");
    } catch { return { status: "needs_reconciliation", code: "provider_outcome_unknown", costMicrousd: 0, providerRequestId: null }; }
    // Proven non-dispatch has no provider response to record.
    if (outcome.status === "failed" && outcome.code === "not_dispatched" && observation.providerRequestId === null && observation.responseHash === null
     && observation.responseId === null && observation.billing.status === "unknown") return outcome;
    const common = { costMicrousd: observation.billing.status === "recorded" ? observation.billing.confirmedMicrousd : 0, providerRequestId: observation.providerRequestId };
    let receiptId: string;
    try {
     const receipt = logoStyleNoteResponseReceiptSchema.parse(await deps.recordResponse(claimed, observation));
     const { id, ownerId, projectId, jobId, leaseToken, ...recorded } = receipt;
     if (ownerId !== claimed.ownerId || projectId !== claimed.projectId || jobId !== claimed.id || leaseToken !== claimed.leaseToken || !isDeepStrictEqual(recorded, observation)) throw new Error("Receipt mismatch.");
     receiptId = id;
    } catch { return { status: "needs_reconciliation", code: "provider_outcome_unknown", costMicrousd: 0, providerRequestId: null }; }
    if (outcome.status === "needs_reconciliation" || observation.billing.status === "unknown") return { status: "needs_reconciliation", code: "provider_outcome_unknown", ...common };
    if (outcome.status !== "succeeded") return { status: "failed", code: outcome.code, ...common };
    try {
     const note = logoStyleNoteSchema.parse(outcome.result);
     const staged = logoStyleNoteStagedSchema.parse(await deps.stage(claimed, note, receiptId));
     if (staged.providerResponseReceiptId !== receiptId) throw new Error("Staged receipt mismatch.");
     return { status: "succeeded", result: { version: 1, kind: "logo_style_note", noteId: staged.noteId, providerResponseReceiptId: receiptId }, ...common };
    } catch { return { status: "needs_reconciliation", code: "publication_unknown", ...common }; }
   } }];
 } };
}
