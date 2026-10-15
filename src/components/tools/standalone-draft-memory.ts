import type { SaveStandaloneWorkspaceInput, StandaloneImportSource, StandaloneTool, StandaloneWorkspace } from "@/domain/standalone-workspaces";

export type StandaloneAccount = { userId: string; generation: number };
export type StandaloneDraftRecord<T = unknown> = {
  workspace: StandaloneWorkspace<T> | null; payload: T; imports: StandaloneImportSource[];
  dirty: boolean; pending: SaveStandaloneWorkspaceInput | null; conflict: boolean;
  saveError?: string | null;
};
export type StandaloneDraftOperation = { account: StandaloneAccount; kind: "loading" | "importing" | "saving"; controller: AbortController };
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
/** Provider lifetime only: never private module globals or browser durable storage. */
export function createStandaloneDraftMemory() {
  let owner: string | null = null;
  let verified: StandaloneAccount | null = null;
  const records = new Map<StandaloneTool, StandaloneDraftRecord>();
  const operations = new Map<StandaloneTool, StandaloneDraftOperation>();
  const subscribers = new Set<() => void>();
  const publish = () => subscribers.forEach(notify => notify());
  const current = (account: StandaloneAccount) => verified?.userId === account.userId && verified.generation === account.generation;
  return {
    /** Root calls this synchronously when fencing/publishing the account session. */
    bind(account: StandaloneAccount | null): void {
      for (const [tool, operation] of operations) {
        if (!account || operation.account.userId !== account.userId || operation.account.generation !== account.generation) {
          operation.controller.abort(); operations.delete(tool);
        }
      }
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
    /** One request per tool across route remounts; a save may finish after navigation. */
    beginOperation(account: StandaloneAccount, tool: StandaloneTool, kind: StandaloneDraftOperation["kind"]): StandaloneDraftOperation | null {
      if (!current(account) || operations.has(tool)) return null;
      const operation = { account: { ...account }, kind, controller: new AbortController() };
      operations.set(tool, operation); publish(); return operation;
    },
    getOperation(account: StandaloneAccount, tool: StandaloneTool): StandaloneDraftOperation | null {
      return current(account) ? operations.get(tool) ?? null : null;
    },
    finishOperation(tool: StandaloneTool, operation: StandaloneDraftOperation): void {
      if (operations.get(tool) === operation) { operations.delete(tool); publish(); }
    },
    hasUnsaved: (): boolean => [...records.values()].some(record => record.dirty || record.pending !== null || record.conflict),
    clear(): void { for (const operation of operations.values()) operation.controller.abort(); operations.clear(); records.clear(); owner = null; verified = null; publish(); },
    subscribe(notify: () => void): () => void { subscribers.add(notify); return () => { subscribers.delete(notify); }; },
  };
}
export type StandaloneDraftMemory = ReturnType<typeof createStandaloneDraftMemory>;
