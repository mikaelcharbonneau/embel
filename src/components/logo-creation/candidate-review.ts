import type { IdentityAssetReceipt } from "../../domain/logo-deliverables";
import { logoRasterSourceSchema, type LogoRasterSource, type LogoType } from "../../domain/logo-workspace";
import type { AccountLogoClient } from "../identity/account-logo-client";
import { AccountRequestError } from "../workspace/account-api";

export type LogoCandidateReview = {
  source: LogoRasterSource;
  title: string;
  logoType: LogoType;
  preview: IdentityAssetReceipt;
  briefRevisionId: string | null;
  referenceSnapshotId: string | null;
  parent: LogoRasterSource | null;
};

export function logoCandidateKey(source: LogoRasterSource): string {
  return source.kind === "concept"
    ? `concept:${source.batchId}:${source.slotId}:${source.attemptId}`
    : `refinement:${source.rasterRevisionId}`;
}

/** Resolve the exact retained version, independently of the open history page.
 * This only reads metadata; private image bytes still pass previewAsset checks. */
export async function readLogoCandidate({
  client,
  ownerId,
  projectId,
  source: raw,
  signal,
}: {
  client: Pick<AccountLogoClient, "readLogoConceptBatch" | "readLogoRasterRefinement">;
  ownerId: string;
  projectId: string;
  source: LogoRasterSource;
  signal: AbortSignal;
}): Promise<LogoCandidateReview | null> {
  if (signal.aborted) return null;
  const source = logoRasterSourceSchema.parse(raw);
  const owned = (value: { ownerId: string; projectId: string }) =>
    value.ownerId === ownerId && value.projectId === projectId;
  const previewValid = (preview: IdentityAssetReceipt | null): preview is IdentityAssetReceipt =>
    Boolean(
      preview &&
      owned(preview.reference) &&
      preview.publicationState === "committed" &&
      preview.verification.status === "verified" &&
      preview.reference.contentHash === preview.verification.contentHash,
    );
  if (source.kind === "concept") {
    const batch = await client.readLogoConceptBatch(source.batchId, signal);
    if (signal.aborted) return null;
    if (!batch || !owned(batch) || batch.id !== source.batchId) throw new AccountRequestError(502);
    const slot = batch.slots.find((row) => row.id === source.slotId);
    const attempt = slot?.attempts.find((row) => row.id === source.attemptId);
    if (
      !slot ||
      !attempt ||
      attempt.slotId !== slot.id ||
      attempt.state !== "succeeded" ||
      attempt.billing.status !== "recorded" ||
      !previewValid(attempt.preview)
    )
      throw new AccountRequestError(502);
    return {
      source,
      title: `Concept ${slot.ordinal + 1}`,
      logoType: slot.type,
      preview: attempt.preview,
      briefRevisionId: batch.briefRevisionId,
      referenceSnapshotId: batch.referenceSnapshotId,
      parent: null,
    };
  }
  const record = await client.readLogoRasterRefinement(source.rasterRevisionId, signal);
  if (signal.aborted) return null;
  if (
    !record ||
    !owned(record) ||
    record.id !== source.rasterRevisionId ||
    record.state !== "succeeded" ||
    record.billing.status !== "recorded" ||
    !previewValid(record.preview)
  )
    throw new AccountRequestError(502);
  return {
    source,
    title: "Image refinement",
    logoType: record.logoType,
    preview: record.preview,
    briefRevisionId: record.inputRevisions.find((row) => row.stage === "brief_references")?.id ?? null,
    referenceSnapshotId: null,
    parent: record.source.kind === "vector" ? null : record.source,
  };
}
