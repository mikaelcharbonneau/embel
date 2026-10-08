import "server-only";
import { zipSync } from "fflate";
import { approvedDeliverableSnapshotSchema, type ApprovedDeliverableSnapshot } from "../../../domain/logo-deliverables";
import { validateVariantReview } from "../model/variants";
import { renderLogoFiles } from "./render-logo";
import { verifyLogoFiles } from "./verify-output";
import { renderBrandGuidelines, type GuidelinesDependencies } from "./guidelines";
import { renderSelectedSocial } from "./social";
import { LOGO_MAX_FILE_BYTES, sha256 } from "./render-policy";
import { inspectLogoExportArchive } from "./validate-assets";
import { createPublicLogoExportManifest, serializePublicLogoExportManifest } from "./public-manifest";
import { LogoExportPreparationError, type PreparedExportFile, type PreparedLogoExport } from "./export-types";
export { LogoExportPreparationError, type PreparedExportFile, type PreparedLogoExport } from "./export-types";

export async function buildLogoExport(input: ApprovedDeliverableSnapshot, signal: AbortSignal, dependencies: GuidelinesDependencies = {}): Promise<PreparedLogoExport> {
  signal.throwIfAborted();
  const snapshot = approvedDeliverableSnapshotSchema.parse(input), reviewed = validateVariantReview(snapshot.resolvedVariants, snapshot.variantReview);
  const files: PreparedExportFile[] = [], options = { pngLongEdge: snapshot.pngLongEdge };
  try {
    for (const source of reviewed) {
      const rendered = await renderLogoFiles(source, options, signal), verification = await verifyLogoFiles(rendered, source, options, signal);
      for (const format of ["svg", "pdf", "png"] as const) files.push({ name: `${source.variant.role}-${source.variant.colorway}-${source.variant.id}.${format}`, role: `${source.variant.role}.${source.variant.colorway}`, mimeType: verification[format].mimeType, bytes: rendered[format], contentHash: verification[format].contentHash, sourceVariantId: source.variant.id, verification });
    }
    const guidelines = await renderBrandGuidelines(snapshot, signal, dependencies);
    files.push({ name: "brand-guidelines.pdf", role: "guidelines", mimeType: "application/pdf", bytes: guidelines, contentHash: sha256(guidelines), sourceVariantId: null, verification: null });
    files.push(...await renderSelectedSocial(snapshot, signal));
  } catch (cause) { signal.throwIfAborted(); throw new LogoExportPreparationError("file_failed", files, { cause }); }
  const manifest = createPublicLogoExportManifest(snapshot, files), licenseOmissions = manifest.licenseOmissions;
  const entries: Record<string, Uint8Array> = { "manifest.json": serializePublicLogoExportManifest(manifest) };
  let total = entries["manifest.json"]!.byteLength;
  for (const file of files) {
    if (!/^[A-Za-z0-9._-]+$/.test(file.name) || entries[file.name] || sha256(file.bytes) !== file.contentHash) throw new LogoExportPreparationError("file_failed", files);
    entries[file.name] = file.bytes; total += file.bytes.byteLength;
  }
  // Keep deterministic ZIP times; avoid emitting private filesystem or creation metadata.
  const archiveBytes = zipSync(Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, [bytes, { mtime: new Date("2000-01-01T00:00:00Z") }]])), { level: 6 });
  if (archiveBytes.byteLength > LOGO_MAX_FILE_BYTES || total > LOGO_MAX_FILE_BYTES * 4) throw new LogoExportPreparationError("package_too_large", files);
  const unpacked = inspectLogoExportArchive(archiveBytes);
  if (Object.keys(unpacked).length !== Object.keys(entries).length || Object.entries(entries).some(([name, bytes]) => !unpacked[name] || sha256(unpacked[name]) !== sha256(bytes))) throw new LogoExportPreparationError("file_failed", files);
  signal.throwIfAborted();
  return { files, archive: { name: `logo-pack-${snapshot.logoApproval.id}.zip`, role: "pack", mimeType: "application/zip", bytes: archiveBytes, contentHash: sha256(archiveBytes), sourceVariantId: null, verification: null }, licenseOmissions, sourceSnapshotHash: snapshot.sourceSnapshotHash };
}
