import type { IdentityAssetReceipt } from "@/domain/logo-deliverables";
import type { LogoStage, LogoStageRevision } from "@/domain/logo-workspace";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import { readLogoCandidate } from "@/components/logo-creation/candidate-review";
import { AccountRequestError } from "./account-api";

export type ProjectCardPreview = { name: string | null; receipt: IdentityAssetReceipt | null };
type PreviewReader = Pick<AccountLogoClient, "getLogoWorkspace" | "getLogoStageRevision" | "readLogoConceptBatch" | "readLogoRasterRefinement">;

/** Read the persisted selection, never a recent attempt, like, approval or usage
 * flag. The existing client enforces the owner and account generation; image
 * bytes still pass its separate hash/MIME-verified previewAsset path. */
export async function readProjectCardPreview({ client, ownerId, projectId, signal }: {
  client: PreviewReader; ownerId: string; projectId: string; signal: AbortSignal;
}): Promise<ProjectCardPreview | null> {
  if (signal.aborted) return null;
  const workspace = await client.getLogoWorkspace(signal);
  if (!workspace || signal.aborted) return null;
  const owned = (value: { ownerId: string; projectId: string }) => value.ownerId === ownerId && value.projectId === projectId;
  if (!owned(workspace)) throw new AccountRequestError(502);
  async function stage<S extends LogoStage>(kind: S): Promise<LogoStageRevision<S> | null> {
    const head = workspace!.stages[kind];
    if (!head || signal.aborted) return null;
    const revision = await client.getLogoStageRevision(kind, head.id, signal);
    if (signal.aborted) return null;
    if (!revision) throw new AccountRequestError(502);
    if (!owned(revision) || revision.stage !== kind || revision.id !== head.id || revision.revision !== head.revision) throw new AccountRequestError(502);
    return revision as LogoStageRevision<S>;
  }
  // Sequential reads avoid competing with the project listing on large grids.
  const brief = await stage("brief_references");
  if (signal.aborted) return null;
  const concepts = await stage("concepts");
  if (signal.aborted) return null;
  const name = brief?.payload.name ?? null;
  if (!concepts?.payload.selected) return { name, receipt: null };
  const candidate = await readLogoCandidate({ client, ownerId, projectId, source: concepts.payload.selected, signal });
  return !candidate || signal.aborted ? null : { name, receipt: candidate.preview };
}
