import type { IdentityAssetReceipt } from "@/domain/logo-deliverables";
import type { LogoRasterSource, LogoStage, LogoStageRevision, LogoWorkspaceV2 } from "@/domain/logo-workspace";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import { readLogoCandidate } from "@/components/logo-creation/candidate-review";
import { AccountRequestError } from "./account-api";

export type ProjectCardPreview = { name: string | null; receipt: IdentityAssetReceipt | null };
type PreviewReader = Pick<AccountLogoClient, "getLogoWorkspace" | "getLogoStageRevision" | "readLogoConceptBatch" | "readLogoRasterRefinement">;

export type ProjectLogoProgress = { workspace: LogoWorkspaceV2; selected: LogoRasterSource | null };

async function readStage<S extends LogoStage>(client: PreviewReader, workspace: LogoWorkspaceV2, kind: S, signal: AbortSignal) {
  const head = workspace.stages[kind];
  if (!head || signal.aborted) return null;
  const value = await client.getLogoStageRevision(kind, head.id, signal);
  if (signal.aborted) return null;
  if (!value || value.ownerId !== workspace.ownerId || value.projectId !== workspace.projectId ||
    value.stage !== kind || value.id !== head.id || value.revision !== head.revision) throw new AccountRequestError(502);
  return value as LogoStageRevision<S>;
}

export async function readProjectLogoProgress(client: PreviewReader, ownerId: string, projectId: string, signal: AbortSignal): Promise<ProjectLogoProgress | null> {
  if (signal.aborted) return null;
  const workspace = await client.getLogoWorkspace(signal);
  if (!workspace || signal.aborted) return null;
  if (workspace.ownerId !== ownerId || workspace.projectId !== projectId) throw new AccountRequestError(502);
  const concepts = await readStage(client, workspace, "concepts", signal);
  return signal.aborted ? null : { workspace, selected: concepts?.payload.selected ?? null };
}

/** Read the persisted selection, never a recent attempt, like, approval or usage
 * flag. The existing client enforces the owner and account generation; image
 * bytes still pass its separate hash/MIME-verified previewAsset path. */
export async function readProjectCardPreview({ client, ownerId, projectId, signal, progress }: {
  client: PreviewReader; ownerId: string; projectId: string; signal: AbortSignal; progress?: ProjectLogoProgress;
}): Promise<ProjectCardPreview | null> {
  const state = progress ?? await readProjectLogoProgress(client, ownerId, projectId, signal);
  if (!state || signal.aborted) return null;
  if (state.workspace.ownerId !== ownerId || state.workspace.projectId !== projectId) throw new AccountRequestError(502);
  const brief = await readStage(client, state.workspace, "brief_references", signal);
  if (signal.aborted) return null;
  const name = brief?.payload.name ?? null;
  if (!state.selected) return { name, receipt: null };
  const candidate = await readLogoCandidate({ client, ownerId, projectId, source: state.selected, signal });
  return !candidate || signal.aborted ? null : { name, receipt: candidate.preview };
}
