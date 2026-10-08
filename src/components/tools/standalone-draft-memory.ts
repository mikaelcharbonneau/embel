import type { SaveStandaloneWorkspaceInput, StandaloneImportSource, StandaloneTool, StandaloneWorkspace } from "@/domain/standalone-workspaces";

export type StandaloneAccount = { userId: string; generation: number };
export type StandaloneDraftRecord<T = unknown> = {
  workspace: StandaloneWorkspace<T> | null; payload: T; imports: StandaloneImportSource[];
  dirty: boolean; pending: SaveStandaloneWorkspaceInput | null; conflict: boolean;
};
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
/** Provider lifetime only: never private module globals or browser durable storage. */
export function createStandaloneDraftMemory() {
  let owner: string | null = null;
  let verified: StandaloneAccount | null = null;
  const records = new Map<StandaloneTool, StandaloneDraftRecord>();
  const subscribers = new Set<() => void>();
  const publish = () => subscribers.forEach(notify => notify());
  const current = (account: StandaloneAccount) => verified?.userId === account.userId && verified.generation === account.generation;
  return {
    /** Root calls this synchronously when fencing/publishing the account session. */
    bind(account: StandaloneAccount | null): void {
      if (account && owner !== null && account.userId !== owner) records.clear();
      if (account) owner = account.userId;
      verified = account ? { ...account } : null;
      publish();
    },
    isCurrent: current,
    get(account: StandaloneAccount, tool: StandaloneTool): StandaloneDraftRecord | null {
      return current(account) ? records.get(tool) ?? null : null;
    },
    set(account: StandaloneAccount, tool: StandaloneTool, record: StandaloneDraftRecord): boolean {
      if (!current(account)) return false;
      if (record.workspace && (record.workspace.ownerId !== account.userId.toLowerCase() || record.workspace.tool !== tool)) throw new Error("Workspace owner mismatch");
      records.set(tool, freeze(structuredClone(record))); publish(); return true;
    },
    hasUnsaved: (): boolean => [...records.values()].some(record => record.dirty || record.pending !== null || record.conflict),
    clear(): void { records.clear(); owner = null; verified = null; publish(); },
    subscribe(notify: () => void): () => void { subscribers.add(notify); return () => { subscribers.delete(notify); }; },
  };
}
export type StandaloneDraftMemory = ReturnType<typeof createStandaloneDraftMemory>;
