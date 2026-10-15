import type { z } from "zod";
import type { AccountProject, updateProjectInputSchema } from "@/domain/project-api";
import type { ContextSnapshot } from "@/domain/projects";
import type { LocalDraft } from "./local-drafts";
import { accountProjectDraft } from "./project-draft-adapter";

export type AccountWorkspace = { generation: number; ownerId: string; saved: AccountProject; draft: LocalDraft; conflict: boolean; pendingGuidedContext?: ContextSnapshot; pendingDraftSave?: { body: z.infer<typeof updateProjectInputSchema>; draft: LocalDraft } };
export function accountDraftChanged(workspace: AccountWorkspace) { return Boolean(workspace.pendingGuidedContext || workspace.pendingDraftSave) || JSON.stringify(workspace.draft) !== JSON.stringify(accountProjectDraft(workspace.saved)); }

/** An owned head can acknowledge one exact pending append without appending again. */
export function reconcilePendingDraftSave(workspace: AccountWorkspace, project: AccountProject): AccountWorkspace | null {
  const pending = workspace.pendingDraftSave;
  if (!pending || project.owner_id !== workspace.ownerId || project.id !== workspace.saved.id || project.scope !== workspace.saved.scope || project.current_revision !== pending.body.expectedRevision + 1 || project.title !== (pending.body.title ?? workspace.saved.title) || JSON.stringify(project.context) !== JSON.stringify(pending.body.context)) return null;
  return { ...workspace, saved: project, draft: JSON.stringify(workspace.draft) === JSON.stringify(pending.draft) ? accountProjectDraft(project) : workspace.draft, pendingDraftSave: undefined, conflict: false };
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
        const clean = [...entries.entries()].find(([, entry]) => !accountDraftChanged(entry));
        if (!clean) return false;
        entries.delete(clean[0]);
      }
      entries.set(workspace.saved.id, workspace); notify(); return true;
    },
    clear: () => { entries.clear(); notify(); },
    hasUnsaved: () => [...entries.values()].some(accountDraftChanged),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
