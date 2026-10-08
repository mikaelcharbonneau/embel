import "server-only";
import { createHash } from "node:crypto";
import type { ClaimedJob } from "../../domain/jobs";
import { logoConceptJobInputSchema, logoRefinementJobInputSchema } from "../../domain/logo-jobs";
import { logoReferenceSnapshotSchema, type LogoReferenceSnapshot } from "../../domain/logo-workspace";
import { verifiedAssetBytesSchema, type VerifiedAssetBytes } from "../../domain/logo-deliverables";
import type { IdentityAssetStore } from "../data/identity-asset-store";
import { inspectIdentityRaster } from "../../features/logo-vector/server/converter";
import { IMAGE_INPUT_LIMITS } from "./openai-image-transport";

const active = (signal: AbortSignal) => { if (signal.aborted) throw new Error("Reference read cancelled"); };
/** Snapshot IDs are source provenance, not proof of rights. readLeasedAsset's
 * reviewed backend resolves the ACTUAL immutable job/snapshot and current rights
 * evidence for this exact version under the lease. A source note or external URL
 * never substitutes for that capability, and no rejected reference is omitted. */
export async function resolveLogoReferenceInputs(job: ClaimedJob, raw: LogoReferenceSnapshot, store: IdentityAssetStore, signal: AbortSignal): Promise<readonly VerifiedAssetBytes[]> {
  active(signal);
  const snapshot = logoReferenceSnapshotSchema.parse(raw);
  const input = job.operation === "identity.logo_concept" ? logoConceptJobInputSchema.parse(job.input) : logoRefinementJobInputSchema.parse(job.input);
  if (input.operation !== job.operation || input.ownerId !== job.ownerId || input.projectId !== job.projectId || snapshot.ownerId !== job.ownerId || snapshot.projectId !== job.projectId || snapshot.id !== input.referenceSnapshotId
    || input.operation === "identity.logo_concept" && JSON.stringify(input.references) !== JSON.stringify(snapshot.references.map(ref => ref.asset))) throw new Error("Reference source mismatch");
  if (snapshot.references.length > IMAGE_INPUT_LIMITS.images - (input.operation === "identity.logo_refine" ? 1 : 0)) throw new Error("Reference input count exceeds admitted image limits");
  const output: VerifiedAssetBytes[] = []; let size = 0;
  for (const reference of snapshot.references) {
    active(signal);
    const file = verifiedAssetBytesSchema.parse(await store.readLeasedAsset(job, reference.asset, signal)); active(signal);
    if (["ownerId", "projectId", "assetId", "versionId", "contentHash"].some(key => file.reference[key as keyof typeof file.reference] !== reference.asset[key as keyof typeof reference.asset])
      || createHash("sha256").update(file.bytes).digest("hex") !== reference.asset.contentHash) throw new Error("Reference bytes mismatch");
    size += file.bytes.byteLength; if (size > IMAGE_INPUT_LIMITS.inputBytes) throw new Error("Reference input bytes exceed admitted image limits");
    const bytes = Uint8Array.from(file.bytes);
    await inspectIdentityRaster(bytes, file.mimeType, signal); active(signal);
    output.push({ ...file, bytes });
  }
  return output;
}
