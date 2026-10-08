import type { LogoDraftMemory, LogoDraftRecord } from "../identity/logo-draft-memory";
import type { LogoWorkspaceReloadResult } from "../identity/use-logo-workspace";
const protectedWork = (draft: LogoDraftRecord) => draft.dirty || !!draft.vectorDraft || !!draft.directionDraft || draft.conflict
  || !!draft.pendingMutation || !!draft.pendingExport || !!draft.pendingIntent || !!draft.pendingCreation;

/** Refresh the actual shared workspace without clearing a draft, replacing an
 * unresolved request, or creating another feature-local copy of account state. */
export async function refreshLogoCreationWorkspace(input: {
  memory: LogoDraftMemory; projectId: string; isCurrent(): boolean;
  reload(discard: boolean): Promise<LogoWorkspaceReloadResult>;
}): Promise<LogoWorkspaceReloadResult> {
  if (!input.isCurrent()) return "unavailable";
  const before = input.memory.get(input.projectId);
  if (!before?.workspace) return "unavailable";
  if (protectedWork(before)) return "draft_blocked";
  let result: LogoWorkspaceReloadResult;
  try { result = await input.reload(false); } catch { result = "unavailable"; }
  if (!input.isCurrent()) return "unavailable";
  const after = input.memory.get(input.projectId);
  if (!after?.workspace) return "unavailable";
  // A new edit while bytes were being read wins over the stale refresh result.
  if (protectedWork(after)) return "draft_blocked";
  return result;
}
