import { sameVisualGuidance, type VisualDirectionGuidance, type VisualDirectionOverview } from "@/domain/visual-direction";
type Account = { userId: string; generation: number };
export type VisualDirectionDraft = { base: VisualDirectionOverview; guidance: VisualDirectionGuidance; latest: VisualDirectionOverview | null; mustReload: boolean };
export const visualDirectionHasEdits = (draft: VisualDirectionDraft) => draft.mustReload || !draft.base.current || draft.base.stale ||
  !sameVisualGuidance(draft.guidance, draft.base.current.guidance);
/** A root-session lifetime, private tab memory. Never localStorage or a singleton. */
export function createVisualDirectionMemory() {
  let owner: string | null = null, active: Account | null = null;
  const projects = new Map<string, VisualDirectionDraft>(), listeners = new Set<() => void>();
  const current = (account: Account) => active?.userId === account.userId && active?.generation === account.generation;
  const notify = () => listeners.forEach(listener => listener());
  return {
    bind(account: Account | null) { if (account && owner !== account.userId) { projects.clear(); owner = account.userId; } active = account; notify(); },
    clear() { owner = null; active = null; projects.clear(); notify(); },
    get(account: Account, projectId: string) { return current(account) ? projects.get(projectId) ?? null : null; },
    put(account: Account, projectId: string, draft: VisualDirectionDraft | null) {
      if (!current(account)) return;
      if (draft) {
        if ([draft.base, draft.latest].some(row => row && (row.inspiration.ownerId !== account.userId || row.inspiration.projectId !== projectId))) return;
        projects.set(projectId, draft);
      } else projects.delete(projectId);
      notify();
    },
    hasUnsaved() { return projects.size > 0; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
