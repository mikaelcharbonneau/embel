import type { z } from "zod";
import type { AccountProject, updateProjectInputSchema } from "@/domain/project-api";
import type { ContextSnapshot } from "@/domain/projects";
import type { LocalDraft } from "./local-drafts";
import { accountProjectDraft } from "./project-draft-adapter";

export type GuidedInterviewInput = { prompt: string; selection: { turnId: string; ids: string[] } | null; competitorDraft?: { name: string; website: string } };
export type AccountWorkspace = { generation: number; ownerId: string; saved: AccountProject; draft: LocalDraft; conflict: boolean; guidedInput?: GuidedInterviewInput; pendingGuidedContext?: ContextSnapshot; pendingDraftSave?: { body: z.infer<typeof updateProjectInputSchema>; draft: LocalDraft; submittedInput?: Partial<GuidedInterviewInput> } };
export function accountDraftChanged(workspace: AccountWorkspace) { return Boolean(workspace.pendingGuidedContext || workspace.pendingDraftSave) || JSON.stringify(workspace.draft) !== JSON.stringify(accountProjectDraft(workspace.saved)); }
function hasUnsaved(workspace: AccountWorkspace) { return accountDraftChanged(workspace) || Boolean(workspace.guidedInput?.prompt || workspace.guidedInput?.selection?.ids.length || workspace.guidedInput?.competitorDraft?.name || workspace.guidedInput?.competitorDraft?.website); }

export function needsStrategyRecovery(workspace: AccountWorkspace | null | undefined) {
  return Boolean(workspace && (workspace.conflict || hasUnsaved(workspace)));
}

/** An owned head can acknowledge one exact pending append without appending again. */
export function reconcilePendingDraftSave(workspace: AccountWorkspace, project: AccountProject): AccountWorkspace | null {
  const pending = workspace.pendingDraftSave;
  if (!pending || project.owner_id !== workspace.ownerId || project.id !== workspace.saved.id || project.scope !== workspace.saved.scope || project.current_revision !== pending.body.expectedRevision + 1 || project.title !== (pending.body.title ?? workspace.saved.title) || JSON.stringify(project.context) !== JSON.stringify(pending.body.context)) return null;
  const pendingGuidedContext = JSON.stringify(workspace.pendingGuidedContext) === JSON.stringify(pending.body.context) ? undefined : workspace.pendingGuidedContext;
  const guidedInput = workspace.guidedInput && {
    ...workspace.guidedInput,
    competitorDraft: pending.submittedInput?.competitorDraft && JSON.stringify(workspace.guidedInput.competitorDraft) === JSON.stringify(pending.submittedInput.competitorDraft) ? undefined : workspace.guidedInput.competitorDraft,
    prompt: pending.submittedInput?.prompt !== undefined && workspace.guidedInput.prompt === pending.submittedInput.prompt ? "" : workspace.guidedInput.prompt,
    selection: pending.submittedInput?.selection && JSON.stringify(workspace.guidedInput.selection) === JSON.stringify(pending.submittedInput.selection) ? null : workspace.guidedInput.selection,
  };
  return { ...workspace, saved: project, draft: JSON.stringify(workspace.draft) === JSON.stringify(pending.draft) ? accountProjectDraft(project) : workspace.draft, guidedInput, pendingDraftSave: undefined, pendingGuidedContext, conflict: Boolean(pendingGuidedContext) };
}

/** Both readers preserve the same owner's branch, independent of read ordering. */
export function reconcileAccountWorkspace(previous: AccountWorkspace | null, project: AccountProject, generation: number): AccountWorkspace {
  if (previous?.ownerId === project.owner_id && previous.saved.id === project.id) {
    if (project.current_revision < previous.saved.current_revision) return { ...previous, generation };
    const confirmed = reconcilePendingDraftSave(previous, project);
    if (confirmed) return { ...confirmed, generation };
    if (accountDraftChanged(previous) || previous.conflict) return { ...previous, generation, conflict: previous.conflict || previous.saved.current_revision !== project.current_revision };
    return { ...previous, generation, saved: project, draft: accountProjectDraft(project), conflict: false };
  }
  return { generation, ownerId: project.owner_id, saved: project, draft: accountProjectDraft(project), conflict: false };
}

/** Lives only in the mounted session provider. Never writes browser storage. */
export function createAccountDraftMemory() {
  const entries = new Map<string, AccountWorkspace>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    get: (projectId: string) => entries.get(projectId) ?? null,
    set: (workspace: AccountWorkspace) => {
      if (!entries.has(workspace.saved.id) && entries.size >= 20) {
        const clean = [...entries.entries()].find(([, entry]) => !hasUnsaved(entry));
        if (!clean) return false;
        entries.delete(clean[0]);
      }
      entries.set(workspace.saved.id, workspace); notify(); return true;
    },
    clear: () => { entries.clear(); notify(); },
    hasUnsaved: () => [...entries.values()].some(hasUnsaved),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
