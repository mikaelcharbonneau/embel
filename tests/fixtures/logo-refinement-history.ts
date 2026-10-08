/** TEST ONLY. Durable synthetic refinement metadata; no provider or storage calls. */
import { logoRasterRefinementSchema, type LogoRasterRefinement } from "../../src/domain/logo-jobs";
import { syntheticLogoBatch, syntheticResolvedLogoConcept, logoFixtureId as id } from "./logo-creation";
export function syntheticRasterRefinement(overrides: Partial<LogoRasterRefinement> = {}): LogoRasterRefinement {
  const batch = syntheticLogoBatch(), slot = batch.slots[0]!, original = slot.acceptedPreview!;
  return logoRasterRefinementSchema.parse({ version: 2, id: id(503), ownerId: batch.ownerId, projectId: batch.projectId,
    requestKey: id(501), jobId: id(504), source: { kind: "concept", batchId: batch.id, slotId: slot.id, attemptId: slot.attempts[0]!.id }, logoType: slot.type,
    preview: { ...original, id: id(505), reference: { ...original.reference, assetId: id(506), versionId: id(507), contentHash: "a".repeat(64) }, verification: { ...original.verification, contentHash: "a".repeat(64) } },
    providerResponseReceiptId: id(508), state: "succeeded", billing: { status: "recorded", confirmedMicrousd: 100000 }, reason: null,
    inputRevisions: syntheticResolvedLogoConcept().inputRevisions, createdAt: "2026-10-06T12:00:00Z", ...overrides });
}
