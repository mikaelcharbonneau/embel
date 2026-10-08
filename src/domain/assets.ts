import { z } from "zod";

export const assetFormatSchema = z.enum(["svg", "png", "webp", "jpeg", "pdf", "zip", "json"]);
export const assetVersionSchema = z.strictObject({
  id: z.uuid(), assetId: z.uuid(), ownerId: z.uuid(), projectId: z.uuid(),
  inputRevision: z.number().int().positive(),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime({ offset: true }),
  source: z.enum(["user_upload", "provider_generation", "vector_pipeline", "export_pipeline"]),
  provider: z.string().max(100).optional(),
  model: z.string().max(160).optional(),
  providerRequestId: z.string().max(200).optional(),
  // Only the dedicated, independently validated pipeline may mark vector output ready.
  vectorStatus: z.enum(["not_applicable", "raster_only", "pending_validation", "validated_paths"]),
  licenseEvidenceIds: z.array(z.string().min(1).max(200)).max(50),
});

type SelectionFlags = { id: string; ownerId: string; liked: boolean; saved: boolean; used: boolean };
type VersionReference = { id: string; assetId: string; ownerId: string; inputRevision: number };

export function listSelectedAssets<T extends SelectionFlags>(assets: readonly T[], actorId: string, tab: "my_selection" | "all_generations"): T[] {
  const seen = new Set<string>();
  return assets.filter(asset => {
    if (asset.ownerId !== actorId || seen.has(asset.id)) return false;
    seen.add(asset.id);
    return tab === "all_generations" || asset.liked || asset.saved || asset.used;
  });
}

export function staleAssets<T extends { inputRevision: number }>(versions: readonly T[], currentRevision: number): T[] {
  return versions.filter(version => version.inputRevision !== currentRevision);
}

/** An append-only selection event; it never mutates an existing file or version. */
export function restoreAssetSelection(input: {
  actorId: string; asset: { id: string; ownerId: string; currentVersionId: string };
  versions: readonly VersionReference[]; versionId: string; expectedVersionId: string;
  selectionId: string; now: string;
}) {
  if (input.asset.ownerId !== input.actorId) throw new Error("Asset not found");
  if (input.asset.currentVersionId !== input.expectedVersionId) throw new Error("Selection conflict");
  const version = input.versions.find(item => item.id === input.versionId && item.assetId === input.asset.id && item.ownerId === input.actorId);
  if (!version) throw new Error("Version not found");
  return { id: input.selectionId, assetId: input.asset.id, ownerId: input.actorId, versionId: version.id, previousVersionId: input.asset.currentVersionId, action: "restore" as const, createdAt: input.now };
}
