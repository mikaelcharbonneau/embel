import { IMAGE_INPUT_LIMITS } from "../../domain/logo-image-limits";
import type { LogoQuoteRequest } from "../../domain/logo-jobs";
import type { AccountLogoClient } from "../identity/account-logo-client";
import { AccountRequestError } from "../workspace/account-api";
import { readLogoCandidate } from "./candidate-review";

export class LogoReferenceLimitError extends Error {
  constructor(count: number, refinement: boolean) {
    super(refinement
      ? `This saved logo uses ${count} reference images. Refinement allows at most ${IMAGE_INPUT_LIMITS.images - 1} references plus the original logo image. Its original references are kept. To refine with fewer references, save a new reference selection and generate a new concept first.`
      : `This saved source uses ${count} reference images. Concept generation allows at most ${IMAGE_INPUT_LIMITS.images}. Keep up to ${IMAGE_INPUT_LIMITS.images} selected references and save them before requesting new concepts. Previous versions and their references are kept.`);
    this.name = "LogoReferenceLimitError";
  }
}

/** Read the immutable source's snapshot, never the currently open draft. This is
 * a cost-review preflight; the server and worker still enforce their own bounds. */
export async function checkLogoQuoteReferences({ client, ownerId, projectId, request, signal }: {
  client: Pick<AccountLogoClient, "readLogoConceptBatch" | "readLogoRasterRefinement" | "getLogoStageRevision" | "readLogoReferenceSnapshot">;
  ownerId: string; projectId: string; request: LogoQuoteRequest; signal: AbortSignal;
}): Promise<void> {
  if (!["concepts", "more_concepts", "retry_failed", "refine_preview"].includes(request.operation)) return;
  const active = () => { if (signal.aborted) throw new AccountRequestError(503); };
  const owned = (value: { ownerId: string; projectId: string }) => value.ownerId === ownerId && value.projectId === projectId;
  active();
  let briefId: string, snapshotId: string | null = null;
  if (request.operation === "concepts" || request.operation === "more_concepts") {
    briefId = request.briefRevisionId; snapshotId = request.referenceSnapshotId;
  } else if (request.operation === "retry_failed") {
    const batch = await client.readLogoConceptBatch(request.sourceBatchId, signal); active();
    if (!batch || !owned(batch) || batch.id !== request.sourceBatchId) throw new AccountRequestError(502);
    briefId = batch.briefRevisionId; snapshotId = batch.referenceSnapshotId;
  } else if (request.operation === "refine_preview") {
    const candidate = await readLogoCandidate({ client, ownerId, projectId, source: request.source, signal }); active();
    if (!candidate?.briefRevisionId) throw new AccountRequestError(502);
    briefId = candidate.briefRevisionId; snapshotId = candidate.referenceSnapshotId;
  } else return;
  const brief = await client.getLogoStageRevision("brief_references", briefId, signal); active();
  if (!brief || !owned(brief) || brief.id !== briefId || brief.stage !== "brief_references"
    || snapshotId && brief.payload.referenceSnapshotId !== snapshotId) throw new AccountRequestError(502);
  snapshotId = brief.payload.referenceSnapshotId;
  const snapshot = await client.readLogoReferenceSnapshot(snapshotId, signal); active();
  if (!snapshot || !owned(snapshot) || snapshot.id !== snapshotId) throw new AccountRequestError(502);
  const refinement = request.operation === "refine_preview";
  if (snapshot.references.length > IMAGE_INPUT_LIMITS.images - (refinement ? 1 : 0)) throw new LogoReferenceLimitError(snapshot.references.length, refinement);
}
