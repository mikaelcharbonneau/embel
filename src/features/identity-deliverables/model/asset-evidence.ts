import type { AssetVersionDetail } from "@/domain/asset-library";
import { logoExportManifestSchema, type LogoExportManifest } from "@/domain/logo-deliverables";
export type LogoAssetEvidence = { origin: string; vector: string; rights: string; approvedExportId: string | null };
/** Manifest evidence is a separate owner-checked projection. It never mutates
 * legacy metadata, current file availability, retention or an Identity approval. */
export function describeAssetEvidence(
  version: AssetVersionDetail,
  manifests: readonly LogoExportManifest[] = [],
): LogoAssetEvidence {
  const legacy = {
    origin: "Legacy record · provider unverified",
    vector: "Vector origin unverified",
    rights: "License unverified",
    approvedExportId: null,
  };
  for (const raw of manifests) {
    const parsed = logoExportManifestSchema.safeParse(raw);
    if (!parsed.success) continue;
    const manifest = parsed.data;
    if (manifest.ownerId !== version.ownerId || manifest.projectId !== version.projectId) continue;
    const file = manifest.files.find((file) => {
      const ref = file.asset.reference;
      return (
        ref.ownerId === version.ownerId &&
        ref.projectId === version.projectId &&
        ref.assetId === version.assetId &&
        ref.versionId === version.versionId &&
        ref.contentHash === version.contentHash &&
        file.asset.verification.mimeType === version.mimeType &&
        file.format === version.format
      );
    });
    if (!file) continue;
    const vector =
      (file.format === "svg" || file.format === "pdf") &&
      /^(primary|horizontal|stacked|symbol_only)\.(black|white|color)$/.test(file.role);
    return {
      origin: "Approved logo export · immutable source version",
      vector: vector
        ? "Verified vector logo geometry"
        : file.format === "png"
          ? "Raster export · not an editable vector"
          : "Pack or guidelines · see individual logo files",
      rights: "Source permissions retained; no exclusivity or trademark guarantee",
      approvedExportId: manifest.id,
    };
  }
  return legacy;
}
