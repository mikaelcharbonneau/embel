/** TEST ONLY. Synthetic inputs, never a provider, upload, save or rights receipt. */
import { contextSnapshotSchema, type ContextSnapshot } from "../../src/domain/projects";
import type { LogoBriefDraft, LogoType } from "../../src/domain/logo-workspace";

export const syntheticLogoTypes: LogoType[] = [
  "wordmark", "lettermark_monogram", "pictorial", "abstract", "combination", "emblem", "mascot",
];
export function syntheticLogoContext(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return contextSnapshotSchema.parse({
    activity: "Tea shop", knownAudience: "Local readers", selectedName: "Élan & Co",
    ...overrides,
  });
}
export function syntheticLogoBrief(overrides: Partial<LogoBriefDraft> = {}): LogoBriefDraft {
  return { name: "Élan & Co", activity: "Tea shop", audience: "Local readers", personality: "Warm and curious", logoTypes: ["wordmark"], ...overrides };
}

import { logoWorkspaceV2Schema, logoReferenceRegistrationSchema } from "../../src/domain/logo-workspace";
import { logoConceptBatchSchema, logoCostQuoteSchema, type LogoConceptAttempt } from "../../src/domain/logo-jobs";

export const LOGO_TEST_FIXTURE_LABEL = "Test fixture — no live uploads, generation, saving or charges.";
const fixtureId = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const fixtureScope = { ownerId: fixtureId(1), projectId: fixtureId(2) };
const fixtureTime = "2026-10-06T00:00:00Z";
const fixtureHeads = { projectRevision: 1, referenceRevision: 0, preferencesRevision: 0, workspaceRevision: 0,
  stageRevisions: { brief_references: 0, concepts: 0, vector: 0, refinements: 0, directions: 0, deliverables: 0 } };
export function syntheticLogoWorkspace() {
  const unavailable = { status: "unavailable", reason: "Test fixture has no live service." };
  return logoWorkspaceV2Schema.parse({ version: 2, ...fixtureScope, heads: fixtureHeads,
    stages: { brief_references: null, concepts: null, vector: null, refinements: null, directions: null, deliverables: null },
    approvedLogo: null, staleStages: [], capabilities: { save: unavailable, upload: unavailable, generate: unavailable, convert: unavailable, export: unavailable } });
}
export function syntheticLogoReferences() {
  return (["curated", "upload"] as const).map((sourceKind, index) => logoReferenceRegistrationSchema.parse({
    referenceId: fixtureId(20 + index), sourceKind, aspects: ["shape"], rightsEvidenceId: fixtureId(30 + index),
    asset: { ...fixtureScope, assetId: fixtureId(40 + index), versionId: fixtureId(50 + index), contentHash: "a".repeat(64) },
    workspace: syntheticLogoWorkspace(),
  }));
}
export function syntheticLogoBatch(states: LogoConceptAttempt["state"][] = ["succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "failed"]) {
  const directions = ["open_geometry", "compact_structure", "organic_motion", "angular_energy", "negative_space", "expressive_detail"];
  const plan = { version: 1, targetCount: 6, requestedTypes: syntheticLogoTypes,
    slots: directions.map((directionId, ordinal) => ({ ordinal, type: syntheticLogoTypes[ordinal], directionId })),
    coveredTypes: syntheticLogoTypes.slice(0, 6), uncoveredTypes: ["mascot"] };
  return logoConceptBatchSchema.parse({ version: 2, id: fixtureId(60), ...fixtureScope, requestKey: fixtureId(61),
    briefRevisionId: fixtureId(62), referenceSnapshotId: fixtureId(63), targetCount: 6, plan, createdAt: fixtureTime,
    slots: plan.slots.map((slot, index) => {
      const state = states[index] ?? "queued";
      const contentHash = String(index + 1).repeat(64);
      const preview = state === "succeeded" ? { id: fixtureId(70 + index),
        reference: { ...fixtureScope, assetId: fixtureId(80 + index), versionId: fixtureId(90 + index), contentHash },
        verification: { status: "verified", contentHash, mimeType: "image/png", byteLength: 100, checkedAt: fixtureTime },
        purpose: "brand_asset", sourceReceiptId: fixtureId(100 + index), rightsEvidenceId: null, publicationState: "committed" } : null;
      return { ...slot, id: fixtureId(110 + index), acceptedPreview: preview, attempts: [{
        id: fixtureId(120 + index), jobId: fixtureId(130 + index), slotId: fixtureId(110 + index), requestKey: fixtureId(61),
        previousAttemptId: null, attemptNumber: 1, inputHash: "b".repeat(64), reservedCostMicrousd: 200000,
        preview, providerResponseReceiptId: preview ? fixtureId(140 + index) : null, state,
        billing: state === "succeeded" || state === "failed" ? { status: "recorded", confirmedMicrousd: 100000 } : { status: "unknown", confirmedMicrousd: null },
        reason: state === "needs_reconciliation" ? "outcome_unknown" : null,
      }] };
    }),
  });
}
export function syntheticLogoQuote() {
  const batch = syntheticLogoBatch();
  return logoCostQuoteSchema.parse({ id: fixtureId(150), ...fixtureScope,
    request: { operation: "concepts", expected: fixtureHeads, briefRevisionId: batch.briefRevisionId, referenceSnapshotId: batch.referenceSnapshotId },
    inputHash: "b".repeat(64), expected: fixtureHeads, policyIdentity: "c".repeat(64), handlerVersion: "fixture-v1",
    provider: "fixture", model: "fixture", engine: null, estimatedCostMicrousd: 600000, maxCostMicrousd: 1200000,
    externalProviderCostMicrousd: 600000, expiresAt: "2026-10-06T12:00:00Z", conceptPlan: batch.plan, targetSlotIds: batch.slots.map(slot => slot.id),
  });
}

import { logoConceptJobInputSchema, logoResolvedConceptInputSchema, logoResolvedRefinementInputSchema } from "../../src/domain/logo-jobs";
import { logoBriefRevisionSchema, logoReferenceSnapshotSchema } from "../../src/domain/logo-workspace";
import type { ClaimedJob } from "../../src/domain/jobs";
export const logoFixtureId = fixtureId;
export function syntheticResolvedLogoConcept() {
  const batch = syntheticLogoBatch(), slot = batch.slots[0]!, attempt = slot.attempts[0]!;
  const input = logoConceptJobInputSchema.parse({ version: 2, ...fixtureScope, requestKey: batch.requestKey, quoteId: fixtureId(150), policyIdentity: "c".repeat(64), handlerVersion: "logo-image-v1", inputHash: "b".repeat(64),
    operation: "identity.logo_concept", batchId: batch.id, slotId: slot.id, attemptId: attempt.id, attemptNumber: 1, previousAttemptId: null,
    directionId: slot.directionId, plan: batch.plan, ordinal: slot.ordinal, briefRevisionId: batch.briefRevisionId, referenceSnapshotId: batch.referenceSnapshotId, references: [] });
  const brief = logoBriefRevisionSchema.parse({ version: 2, id: batch.briefRevisionId, ...fixtureScope, revision: 1, parentRevisionId: null, inputRevisions: [], inputHash: "b".repeat(64), createdAt: fixtureTime,
    stage: "brief_references", payload: { ...syntheticLogoBrief({ logoTypes: syntheticLogoTypes }), referenceSnapshotId: batch.referenceSnapshotId, sourceProjectRevision: 1 } });
  const referenceSnapshot = logoReferenceSnapshotSchema.parse({ version: 2, id: batch.referenceSnapshotId, ...fixtureScope, revision: 1, references: [] });
  return logoResolvedConceptInputSchema.parse({ input, brief, referenceSnapshot, inputRevisions: [{ stage: "brief_references", id: brief.id, revision: brief.revision }] });
}
export function syntheticResolvedLogoRefinement() {
  const concept = syntheticResolvedLogoConcept();
  const preview = syntheticLogoBatch().slots[0]!.acceptedPreview!;
  return logoResolvedRefinementInputSchema.parse({ brief: concept.brief, referenceSnapshot: concept.referenceSnapshot, basePreview: preview.reference, inputRevisions: concept.inputRevisions,
    input: { version: 2, ...fixtureScope, requestKey: fixtureId(501), quoteId: fixtureId(502), policyIdentity: "c".repeat(64), handlerVersion: "logo-image-v1", inputHash: "b".repeat(64),
      operation: "identity.logo_refine", rasterRevisionId: fixtureId(503), instruction: "Simplify the silhouette", briefRevisionId: concept.brief.id, referenceSnapshotId: concept.referenceSnapshot.id,
      source: { kind: "preview", raster: { kind: "concept", batchId: concept.input.batchId, slotId: concept.input.slotId, attemptId: concept.input.attemptId } } } });
}
export function syntheticLogoJob(input: ClaimedJob["input"] = syntheticResolvedLogoConcept().input): ClaimedJob {
  return { id: fixtureId(600), ...fixtureScope, operation: (input as { operation: string }).operation, input, inputRevision: 1, leaseToken: fixtureId(601), status: "running", reservedCostMicrousd: 2000, actualCostMicrousd: 0 };
}
