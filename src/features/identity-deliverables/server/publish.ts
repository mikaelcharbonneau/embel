import "server-only";
import type { ClaimedJob } from "../../../domain/jobs";
import { approvedDeliverableSnapshotSchema, identityAssetReceiptSchema, type ApprovedDeliverableSnapshot, type IdentityAssetReceipt } from "../../../domain/logo-deliverables";
import { logoExportJobInputSchema, logoExportPublicationReceiptSchema, type LogoExportPublicationReceipt } from "../../../domain/logo-jobs";
import type { IdentityAssetStore } from "../../../server/data/identity-asset-store";
import { validateVariantReview } from "../model/variants";
import { assertFileBytes, sha256, LogoFileError } from "./render-policy";
import { LogoExportPreparationError, type ExportPublicationDetails, type PreparedExportFile, type PreparedLogoExport } from "./export-types";
import { inspectLogoExportArchive } from "./validate-assets";
import { assertPublicLogoExportManifest, createPublicLogoExportManifest } from "./public-manifest";
import { LOGO_SOCIAL_PRESETS } from "./social";

export type ExportPublicationDependencies = {
  assets: IdentityAssetStore;
  assertCurrentLease(job: ClaimedJob): Promise<void>;
  stage(job: ClaimedJob, input: ApprovedDeliverableSnapshot, receipts: readonly IdentityAssetReceipt[], signal: AbortSignal, details: ExportPublicationDetails): Promise<LogoExportPublicationReceipt>;
};
function invalid(): never { throw new LogoFileError("verification_failed", "Export bytes, membership or source no longer match the frozen approved snapshot."); }
export function assertExportJobSnapshot(job: ClaimedJob, raw: ApprovedDeliverableSnapshot): ApprovedDeliverableSnapshot {
  const input = logoExportJobInputSchema.parse(job.input), snapshot = approvedDeliverableSnapshotSchema.parse(raw);
  if (job.operation !== "identity.logo_export" || input.operation !== job.operation || input.ownerId !== job.ownerId || input.projectId !== job.projectId || snapshot.ownerId !== job.ownerId || snapshot.projectId !== job.projectId
    || input.approvedLogoId !== snapshot.logoApproval.id || input.directionApprovalId !== snapshot.directionApproval.id || input.variantSetId !== snapshot.variants.id || input.variantReviewId !== snapshot.variantReview.id || input.sourceSnapshotHash !== snapshot.sourceSnapshotHash) return invalid();
  validateVariantReview(snapshot.resolvedVariants, snapshot.variantReview);
  return snapshot;
}
function expectedFiles(input: ApprovedDeliverableSnapshot) {
  const reviewed = validateVariantReview(input.resolvedVariants, input.variantReview);
  const expected = new Map<string, { mimeType: string; variantId: string | null; role: string; logoFormat: "svg" | "pdf" | "png" | null }>();
  for (const source of reviewed) for (const [format, mimeType] of [["svg", "image/svg+xml"], ["pdf", "application/pdf"], ["png", "image/png"]] as const) expected.set(`${source.variant.role}-${source.variant.colorway}-${source.variant.id}.${format}`, { mimeType, variantId: source.variant.id, role: `${source.variant.role}.${source.variant.colorway}`, logoFormat: format });
  expected.set("brand-guidelines.pdf", { mimeType: "application/pdf", variantId: null, role: "guidelines", logoFormat: null });
  const primary = reviewed.find(item => item.variant.role === "primary" && item.variant.colorway === "color")!;
  for (const selection of input.socialSelections) {
    const preset = LOGO_SOCIAL_PRESETS[selection.presetId as keyof typeof LOGO_SOCIAL_PRESETS];
    if (!preset || preset.kind !== selection.kind) return invalid();
    expected.set(`${selection.kind}-${selection.presetId}-${primary.variant.id}.png`, { mimeType: "image/png", variantId: primary.variant.id, role: selection.kind, logoFormat: null });
  }
  return { expected, reviewed };
}
function assertFiles(input: ApprovedDeliverableSnapshot, files: readonly PreparedExportFile[], complete: boolean): void {
  const { expected, reviewed } = expectedFiles(input);
  if (!files.length || files.length > expected.size || (complete && files.length !== expected.size) || new Set(files.map(file => file.name)).size !== files.length) return invalid();
  for (const file of files) {
    assertFileBytes(file.bytes); if (sha256(file.bytes) !== file.contentHash) return invalid();
    const member = expected.get(file.name);
    if (!member || member.mimeType !== file.mimeType || member.variantId !== file.sourceVariantId || member.role !== file.role) return invalid();
    if (member.logoFormat !== null) {
      const source = reviewed.find(item => item.variant.id === file.sourceVariantId), format = member.logoFormat;
      if (!source || !file.verification || file.verification.sourceVariantHash !== source.variant.renderHash || file.verification[format].contentHash !== file.contentHash || file.verification[format].byteLength !== file.bytes.byteLength || file.verification[format].mimeType !== file.mimeType) return invalid();
    }
  }
 }
function assertPrepared(input: ApprovedDeliverableSnapshot, prepared: PreparedLogoExport): readonly PreparedExportFile[] {
  if (prepared.sourceSnapshotHash !== input.sourceSnapshotHash) return invalid();
  assertFiles(input, prepared.files, true);
  if (prepared.archive.name !== `logo-pack-${input.logoApproval.id}.zip` || prepared.archive.mimeType !== "application/zip" || prepared.archive.role !== "pack" || prepared.archive.sourceVariantId !== null || sha256(prepared.archive.bytes) !== prepared.archive.contentHash) return invalid();
  assertFileBytes(prepared.archive.bytes);
  const { expected } = expectedFiles(input);
  let entries: Record<string, Uint8Array>;
  try { entries = inspectLogoExportArchive(prepared.archive.bytes); } catch { return invalid(); }
  if (Object.keys(entries).length !== expected.size + 1 || !entries["manifest.json"] || prepared.files.some(file => !entries[file.name] || sha256(entries[file.name]!) !== file.contentHash)) return invalid();
  try {
    const expectedManifest = createPublicLogoExportManifest(input, prepared.files);
    assertPublicLogoExportManifest(entries["manifest.json"], expectedManifest);
    if (JSON.stringify(prepared.licenseOmissions) !== JSON.stringify(expectedManifest.licenseOmissions)) return invalid();
  } catch { return invalid(); }
  return [...prepared.files, prepared.archive];
}
/** Stable same-job/bytes UUID. Retry never chooses a new object or overwrites an earlier version. */
export function logoExportFileRequestKey(jobId: string, sourceSnapshotHash: string, file: Pick<PreparedExportFile, "name" | "contentHash">): string {
  const hex = sha256(JSON.stringify({ jobId, sourceSnapshotHash, name: file.name, hash: file.contentHash })).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** Only stages verified bytes. The shared leased completeStep transaction alone commits a manifest. */
export async function publishPreparedLogoExport(job: ClaimedJob, rawInput: ApprovedDeliverableSnapshot, prepared: PreparedLogoExport, dependencies: ExportPublicationDependencies, signal: AbortSignal): Promise<LogoExportPublicationReceipt> {
  signal.throwIfAborted();
  const input = assertExportJobSnapshot(job, rawInput), files = assertPrepared(input, prepared).map(file => ({ ...file, bytes: new Uint8Array(file.bytes) }));
  return publishFiles(job, input, files, dependencies, signal, { completeness: "complete", failure: null, files: descriptors(files) });
}
function descriptors(files: readonly PreparedExportFile[]): ExportPublicationDetails["files"] {
  return files.map(file => ({ name: file.name, role: file.role, mimeType: file.mimeType, contentHash: file.contentHash, sourceVariantId: file.sourceVariantId, byteLength: file.bytes.byteLength }));
}
/** Earlier verified files may be retained, but an incomplete group never gains a pack manifest. */
export async function publishPartialLogoExport(job: ClaimedJob, rawInput: ApprovedDeliverableSnapshot, partial: LogoExportPreparationError, dependencies: ExportPublicationDependencies, signal: AbortSignal): Promise<LogoExportPublicationReceipt> {
  signal.throwIfAborted();
  const input = assertExportJobSnapshot(job, rawInput);
  assertFiles(input, partial.files, false);
  const files = partial.files.map(file => ({ ...file, bytes: new Uint8Array(file.bytes) }));
  return publishFiles(job, input, files, dependencies, signal, { completeness: "partial", failure: partial.code, files: descriptors(files) });
}
async function publishFiles(job: ClaimedJob, input: ApprovedDeliverableSnapshot, files: readonly PreparedExportFile[], dependencies: ExportPublicationDependencies, signal: AbortSignal, details: ExportPublicationDetails): Promise<LogoExportPublicationReceipt> {
  const receipts: IdentityAssetReceipt[] = [];
  for (const file of files) {
    signal.throwIfAborted(); await dependencies.assertCurrentLease(job);
    const receipt = identityAssetReceiptSchema.parse(await dependencies.assets.publishLeasedAsset(job, { requestKey: logoExportFileRequestKey(job.id, input.sourceSnapshotHash, file), inputRevisions: input.inputRevisions, mimeType: file.mimeType, contentHash: file.contentHash, byteLength: file.bytes.byteLength, source: { kind: "export", sourceId: job.id } }, file.bytes, signal));
    if (receipt.reference.ownerId !== job.ownerId || receipt.reference.projectId !== job.projectId || receipt.reference.contentHash !== file.contentHash || receipt.purpose !== "brand_asset" || receipt.verification.mimeType !== file.mimeType || receipt.verification.byteLength !== file.bytes.byteLength) return invalid();
    const readback = await dependencies.assets.readLeasedAsset(job, receipt.reference, signal);
    if (JSON.stringify(readback.reference) !== JSON.stringify(receipt.reference) || readback.mimeType !== file.mimeType || readback.verification.contentHash !== file.contentHash || readback.bytes.byteLength !== file.bytes.byteLength || sha256(readback.bytes) !== file.contentHash) return invalid();
    receipts.push(receipt);
  }
  signal.throwIfAborted(); await dependencies.assertCurrentLease(job);
  const staged = logoExportPublicationReceiptSchema.parse(await dependencies.stage(job, input, receipts, signal, details));
  if (staged.ownerId !== job.ownerId || staged.projectId !== job.projectId || staged.jobId !== job.id || staged.sourceSnapshotHash !== input.sourceSnapshotHash || staged.assetReceiptIds.length !== receipts.length || staged.assetReceiptIds.some((id, index) => id !== receipts[index]?.id)) return invalid();
  return staged;
}
