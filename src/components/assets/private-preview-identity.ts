import type { AssetVersionReference } from "@/domain/asset-library";

/** Private preview lifetime follows owned immutable bytes and read eligibility,
 * never the object identity of an independently parsed metadata response.
 * Callers must also bind their state/effect to the verified client instance. */
export function privatePreviewIdentity(reference: AssetVersionReference, evidence: readonly unknown[] = []): string {
  return JSON.stringify([reference.ownerId, reference.projectId, reference.assetId, reference.versionId, reference.contentHash, ...evidence]);
}
