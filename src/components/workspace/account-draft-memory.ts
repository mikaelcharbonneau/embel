import type { AccountProject } from "@/domain/project-api";
import type { ContextSnapshot } from "@/domain/projects";
import type { LocalDraft } from "./local-drafts";
import { accountProjectDraft } from "./project-draft-adapter";

export type AccountWorkspace = { generation: number; ownerId: string; saved: AccountProject; draft: LocalDraft; conflict: boolean; pendingGuidedContext?: ContextSnapshot };
export function accountDraftChanged(workspace: AccountWorkspace) { return Boolean(workspace.pendingGuidedContext) || JSON.stringify(workspace.draft) !== JSON.stringify(accountProjectDraft(workspace.saved)); }

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
