import type { ScreeningRecordInput } from "@/domain/project-screening";
import type { HandlePlatform } from "@/features/handles-workspace/domain";

export type ScreeningDraft = {
  tool: "domains" | "handles" | "trademarks"; domain: string; handle: string; platform: HandlePlatform;
  jurisdictions: string; niceClasses: string; notes: string; sources: string; observedAt: string;
  acknowledged: boolean; dirty: boolean; pendingInput: ScreeningRecordInput | null;
};
type Account = { userId: string; generation: number };
/** Root-session lifetime only; temporary unverification hides every draft. */
export function createProjectScreeningMemory() {
  let owner: string | null = null, active: Account | null = null;
  const drafts = new Map<string, ScreeningDraft>(), listeners = new Set<() => void>();
  const current = (account: Account) => active?.userId === account.userId && active?.generation === account.generation;
  const key = (projectId: string, selectionId: string, revision: number) => `${projectId}:${selectionId}:${revision}`;
  const notify = () => listeners.forEach(listener => listener());
  return {
    bind(account: Account | null) { if (account && account.userId !== owner) { drafts.clear(); owner = account.userId; } active = account; notify(); },
    clear() { owner = null; active = null; drafts.clear(); notify(); },
    hasUnsaved() { return drafts.size > 0; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get(account: Account, projectId: string, selectionId: string, revision: number) { return current(account) ? drafts.get(key(projectId, selectionId, revision)) ?? null : null; },
    previous(account: Account, projectId: string, selectionId: string, revision: number) {
      if (!current(account)) return [];
      return [...drafts].filter(([id]) => id.startsWith(`${projectId}:`) && id !== key(projectId, selectionId, revision)).map(([id, draft]) => {
        const [, priorSelection, priorRevision] = id.split(":");
        return { selectionId: priorSelection!, revision: Number(priorRevision), draft };
      });
    },
    put(account: Account, projectId: string, selectionId: string, revision: number, draft: ScreeningDraft | null) {
      if (!current(account)) return;
      if (draft?.pendingInput && (draft.pendingInput.selectionId !== selectionId || draft.pendingInput.expectedProjectRevision !== revision)) return;
      const id = key(projectId, selectionId, revision);
      if (draft && (draft.dirty || draft.pendingInput)) drafts.set(id, structuredClone(draft)); else drafts.delete(id);
      notify();
    },
  };
}
