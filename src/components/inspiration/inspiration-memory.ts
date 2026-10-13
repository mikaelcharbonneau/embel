import type { InspirationPreferences } from "@/domain/inspiration";
type Fence = { userId: string; generation: number };
export type InspirationIntent = { desired: InspirationPreferences; expectedRevision: number; expectedProjectRevision: number; checked: boolean; error: string };
const empty: ReadonlyMap<string, InspirationIntent> = new Map();
/** Owner-fenced, tab-memory-only recovery; a GET must reverify saved state. */
export function createInspirationMemory() {
  let owner: string | null = null, active: Fence | null = null;
  const projects = new Map<string, ReadonlyMap<string, InspirationIntent>>(), listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  const current = (account: Fence) => active?.userId === account.userId && active?.generation === account.generation;
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    bind(account: Fence | null) { if (account && account.userId !== owner) { projects.clear(); owner = account.userId; } active = account; notify(); },
    clear() { owner = null; active = null; projects.clear(); notify(); },
    get(account: Fence, projectId: string) { return current(account) ? projects.get(projectId) ?? empty : empty; },
    put(account: Fence, projectId: string, id: string, value: InspirationIntent | null) {
      if (!current(account)) return;
      const next = new Map(projects.get(projectId));
      if (value) next.set(id, value); else next.delete(id);
      if (next.size) projects.set(projectId, next); else projects.delete(projectId);
      notify();
    },
    hasUnsaved() { return projects.size > 0; },
  };
}
