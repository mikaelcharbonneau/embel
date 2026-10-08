import { LOGO_EXPORT_POLICY_IDENTITY } from "../../../worker/handlers/logo-exports";
import type { ClaimedJob } from "../../../src/domain/jobs";
import type { ApprovedDeliverableSnapshot, IdentityAssetReceipt } from "../../../src/domain/logo-deliverables";
import type { LogoExportPublicationReceipt } from "../../../src/domain/logo-jobs";
import { createIdentityAssetStore, type IdentityAssetReservation } from "../../../src/server/data/identity-asset-store";
import { validateLogoExportAssetBytes } from "../../../src/features/identity-deliverables/server/validate-assets";
import type { ExportPublicationDetails } from "../../../src/features/identity-deliverables/server/export-types";
import { id, at } from "./fixtures";
/** Synthetic in-memory capabilities only. No hosted Storage, DB or concurrency claim. */
export function publicationFixture(snapshot: ApprovedDeliverableSnapshot) {
  const job: ClaimedJob = { id: id(700), ownerId: snapshot.ownerId, projectId: snapshot.projectId, operation: "identity.logo_export", inputRevision: 1, leaseToken: id(701), status: "running", reservedCostMicrousd: 0, actualCostMicrousd: 0,
    input: { version: 2, ownerId: snapshot.ownerId, projectId: snapshot.projectId, requestKey: id(702), policyIdentity: LOGO_EXPORT_POLICY_IDENTITY, handlerVersion: "logo-export-v1", inputHash: "c".repeat(64), operation: "identity.logo_export", approvedLogoId: snapshot.logoApproval.id, directionApprovalId: snapshot.directionApproval.id, variantSetId: snapshot.variants.id, variantReviewId: snapshot.variantReview.id, sourceSnapshotHash: snapshot.sourceSnapshotHash } };
  const rows = new Map<string, IdentityAssetReservation>(), storage = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  let calls = 0, stages = 0, writes = 0, lease = true, corrupt = false, loseStageAcknowledgement = false;
  const assertCurrentLease = async () => { calls++; if (!lease) throw new Error("Synthetic lost lease"); };
  const assets = createIdentityAssetStore({ validateBytes: async (write, bytes, signal) => { const mime = write.kind === "stage" ? write.publication.mimeType : write.intent.mimeType; if (["application/pdf", "application/zip"].includes(mime)) await validateLogoExportAssetBytes(write, bytes, signal); }, now: () => new Date(at), backend: {
    async prepare(access, write) {
      await assertCurrentLease(); if (access.kind !== "leased" || write.kind !== "stage") throw new Error("Synthetic fixture only supports leased staging");
      const previous = rows.get(write.publication.requestKey); if (previous) return previous;
      const n = 800 + rows.size * 4, reference = { ownerId: access.ownerId, projectId: access.projectId, assetId: id(n + 1), versionId: id(n + 2), contentHash: write.publication.contentHash };
      const row: IdentityAssetReservation = { id: id(n), requestKey: write.publication.requestKey, reference, storagePath: `${reference.ownerId}/${reference.projectId}/${reference.assetId}/${reference.versionId}`, mimeType: write.publication.mimeType, byteLength: write.publication.byteLength, purpose: "brand_asset", sourceReceiptId: job.id, rightsEvidenceId: null, publicationState: "staged" };
      rows.set(row.requestKey, row); return row;
    },
    async resolve(_, reference) { await assertCurrentLease(); const row = [...rows.values()].find(r => r.reference.versionId === reference.versionId); if (!row) throw new Error("Synthetic missing asset"); return row; },
    async observe(_, receiptId, verification) { await assertCurrentLease(); const row = [...rows.values()].find(r => r.id === receiptId)!; return { id: row.id, reference: row.reference, verification, purpose: row.purpose, sourceReceiptId: row.sourceReceiptId, rightsEvidenceId: row.rightsEvidenceId, publicationState: row.publicationState }; },
  }, storage: {
    async putIfAbsent(path, bytes, mimeType) { if (!storage.has(path)) { writes++; storage.set(path, { bytes: bytes.slice(), mimeType }); } },
    async read(path) { const file = storage.get(path); if (!file) throw new Error("Synthetic missing bytes"); return { ...file, bytes: corrupt ? new Uint8Array([0]) : file.bytes.slice() }; },
  } });
  let details: ExportPublicationDetails | undefined;
  const stage = async (_: ClaimedJob, input: ApprovedDeliverableSnapshot, receipts: readonly IdentityAssetReceipt[], _signal: AbortSignal, published: ExportPublicationDetails): Promise<LogoExportPublicationReceipt> => {
    await assertCurrentLease(); stages++; details = structuredClone(published);
    if (loseStageAcknowledgement) throw new Error("Synthetic unknown commit acknowledgement");
    return { id: id(750), ownerId: input.ownerId, projectId: input.projectId, jobId: job.id, sourceSnapshotHash: input.sourceSnapshotHash, assetReceiptIds: receipts.map(r => r.id), publicationState: "staged" };
  };
  return { job, details: () => details, dependencies: { assets, assertCurrentLease, stage }, rows, storage, counters: () => ({ calls, stages, writes }), loseLease: () => { lease = false; }, corruptReadback: () => { corrupt = true; }, loseStageAcknowledgement: () => { loseStageAcknowledgement = true; } };
}
