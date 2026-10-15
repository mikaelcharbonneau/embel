import { AccountRequestError } from "@/components/workspace/account-api";
import { createEmptyNamesWorkspace, namesWorkspaceResponseSchema, type AccountNamesWorkspace, type NamesWorkspace, type SaveNamesWorkspaceInput } from "@/domain/names-workspace";
import { createNamesStore, type NamesMutationResult, type NamesSnapshot, type NamesStore } from "./local-names";
import { namesWorkspaceRequest } from "./names-workspace-client";

type Account = { userId: string; generation: number };
export type AccountNamesSnapshot = NamesSnapshot & { saveStatus: "loading" | "saved" | "saving" | "error" | "conflict" };
type Record = { editor: NamesStore; workspace: AccountNamesWorkspace | null; loaded: boolean; dirty: boolean; pending: SaveNamesWorkspaceInput | null; status: AccountNamesSnapshot["saveStatus"]; error: string | null };
const hidden: AccountNamesSnapshot = Object.freeze({ loaded: false, data: createEmptyNamesWorkspace(), dirty: false, storage: "available", error: null, saveStatus: "loading" });
const blocked: NamesMutationResult = { ok: false, persisted: false, error: "Verify your account and load Names before making changes." };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function failure(cause: unknown): string {
  if (cause instanceof AccountRequestError) {
    if (cause.status === 409) return "Names changed in another session. Your edits are still here. Download them before loading the saved version.";
    if (cause.status === 401) return "Your session expired. Sign in to the same account to recover these unsaved edits.";
    if (cause.status === 413) return "Names could not be saved within the 4 MB limit. Your edits are still here.";
    if (cause.status === 502) return "The save response could not be verified. Your edits are still here; retry to confirm the same save.";
  }
  return "Names could not be saved to your account. Your edits are still in this tab. Retry saving or download a backup.";
}

/** One instance per account-session provider. No private data is written to browser storage. */
export function createAccountNamesMemory(options: { request?: typeof namesWorkspaceRequest; createId?: () => string; debounceMs?: number } = {}) {
  const request = options.request ?? namesWorkspaceRequest;
  let owner: string | null = null;
  let verified: Account | null = null;
  let record: Record | null = null;
  let snapshot = hidden;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: AbortController | null = null;
  let unsubscribe: (() => void) | null = null;
  let unauthorized: ((account: Account) => void) | null = null;
  const listeners = new Set<() => void>();
  const current = (account: Account) => verified?.userId === account.userId && verified.generation === account.generation;
  const publish = () => {
    snapshot = verified && record ? Object.freeze({ loaded: record.loaded, data: record.editor.getSnapshot().data, dirty: record.dirty, storage: record.status === "conflict" ? "conflict" : record.status === "error" ? "unavailable" : "available", saveStatus: record.status, error: record.error ?? record.editor.getSnapshot().error }) : hidden;
    listeners.forEach(listener => listener());
  };
  function stop() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    active?.abort(); active = null;
  }
  function install(payload: NamesWorkspace, workspace: AccountNamesWorkspace | null) {
    unsubscribe?.();
    const editor = createNamesStore({ storage: () => null, memoryOnly: true, initialData: payload, createId: options.createId });
    editor.hydrate();
    record = { editor, workspace, loaded: true, dirty: false, pending: null, status: "saved", error: null };
    let previous = editor.getSnapshot().data;
    unsubscribe = editor.subscribe(() => {
      if (record?.editor !== editor) return;
      const next = editor.getSnapshot().data;
      if (next !== previous) {
        previous = next; record.dirty = true;
        if (record.status !== "error" && record.status !== "conflict") { record.status = "saving"; schedule(); }
      }
      publish();
    });
  }
  function schedule() {
    if (timer !== null) clearTimeout(timer);
    if (!verified || !record?.loaded || !record.dirty || active || record.status === "error" || record.status === "conflict") return;
    const account = { ...verified };
    timer = setTimeout(() => { timer = null; void save(account); }, options.debounceMs ?? 450);
  }
  async function read(account: Account, replace = false) {
    if (!current(account) || active) return;
    const controller = new AbortController(); active = controller;
    const previous = record, before = previous?.editor.getSnapshot().data;
    if (previous) { previous.status = "loading"; previous.error = null; }
    publish();
    try {
      const reply = await request("/api/names/workspace", namesWorkspaceResponseSchema, { signal: controller.signal });
      if (!current(account) || active !== controller) return;
      if (reply.ownerId !== account.userId.toLowerCase()) throw new AccountRequestError(502);
      if (replace && previous?.editor.getSnapshot().data !== before) throw new AccountRequestError(409);
      install(reply.workspace?.payload ?? createEmptyNamesWorkspace(), reply.workspace);
    } catch (cause) {
      if (!current(account) || active !== controller) return;
      if (!record) {
        install(createEmptyNamesWorkspace(), null);
        record!.loaded = false;
      }
      record!.status = cause instanceof AccountRequestError && cause.status === 409 ? "conflict" : "error";
      record!.error = record!.loaded ? failure(cause) : "Your saved Names could not be loaded. Check your connection and try again.";
      if (cause instanceof AccountRequestError && cause.status === 401) unauthorized?.(account);
    } finally {
      if (active === controller) { active = null; publish(); }
    }
  }
  async function save(account: Account) {
    if (!current(account) || !record?.loaded || active || (!record.dirty && !record.pending)) return;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const target = record;
    target.pending ??= { requestKey: options.createId?.() ?? crypto.randomUUID(), expectedRevision: target.workspace?.revision ?? 0, payload: target.editor.getSnapshot().data };
    const pending = target.pending;
    const controller = new AbortController(); active = controller;
    target.status = "saving"; target.error = null; publish();
    try {
      const reply = await request("/api/names/workspace", namesWorkspaceResponseSchema, { signal: controller.signal, method: "PUT", body: pending, expectedOwnerId: account.userId });
      if (!current(account) || active !== controller || record !== target) return;
      if (reply.ownerId !== account.userId.toLowerCase() || !reply.workspace || reply.workspace.revision !== pending.expectedRevision + 1 || !equal(reply.workspace.payload, pending.payload)) throw new AccountRequestError(502);
      target.workspace = reply.workspace; target.pending = null;
      target.dirty = target.editor.getSnapshot().data !== pending.payload;
      target.status = target.dirty ? "saving" : "saved";
    } catch (cause) {
      if (!current(account) || active !== controller || record !== target) return;
      // A definitive rejection cannot have committed. Let an explicit retry use
      // corrected edits; uncertain acknowledgements retain their exact request.
      if (cause instanceof AccountRequestError && [400, 401, 403, 413, 422, 429].includes(cause.status)) target.pending = null;
      target.status = cause instanceof AccountRequestError && cause.status === 409 ? "conflict" : "error";
      target.error = failure(cause);
      if (cause instanceof AccountRequestError && cause.status === 401) unauthorized?.(account);
    } finally {
      if (active === controller) { active = null; publish(); schedule(); }
    }
  }
  function edit<K extends "addManual" | "runWorkshop" | "retainGuidedResult" | "useGuidedWordList" | "updateUi" | "updateForm" | "updateContext" | "useAsSeed" | "togglePreference" | "toggleComparison" | "clearComparison" | "importBackup">(account: Account | null, name: K, args: Parameters<NamesStore[K]>): NamesMutationResult {
    if (!account || !current(account) || !record?.loaded) return blocked;
    const method = record.editor[name] as (...values: Parameters<NamesStore[K]>) => NamesMutationResult;
    return method(...args);
  }
  return {
    bind(account: Account | null) {
      if (account && current(account)) return;
      stop();
      if (account && owner !== null && owner !== account.userId) { unsubscribe?.(); unsubscribe = null; record = null; }
      if (account) owner = account.userId;
      verified = account ? { ...account } : null;
      publish();
      if (account) {
        if (!record?.loaded && listeners.size) void read(account);
        else schedule();
      }
    },
    setUnauthorized(handler: (account: Account) => void) { unauthorized = handler; },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => hidden,
    isCurrent: current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (verified && !record?.loaded) void read({ ...verified });
      return () => { listeners.delete(listener); };
    },
    hasUnsaved: () => Boolean(record?.dirty || record?.pending),
    clear() { stop(); unsubscribe?.(); unsubscribe = null; record = null; owner = null; verified = null; publish(); },
    actions(account: Account | null) {
      return {
        addManual: (...args: Parameters<NamesStore["addManual"]>) => edit(account, "addManual", args),
        runWorkshop: (...args: Parameters<NamesStore["runWorkshop"]>) => edit(account, "runWorkshop", args),
        retainGuidedResult: (...args: Parameters<NamesStore["retainGuidedResult"]>) => edit(account, "retainGuidedResult", args),
        useGuidedWordList: (...args: Parameters<NamesStore["useGuidedWordList"]>) => edit(account, "useGuidedWordList", args),
        updateUi: (...args: Parameters<NamesStore["updateUi"]>) => edit(account, "updateUi", args),
        updateForm: (...args: Parameters<NamesStore["updateForm"]>) => edit(account, "updateForm", args),
        updateContext: (...args: Parameters<NamesStore["updateContext"]>) => edit(account, "updateContext", args),
        useAsSeed: (...args: Parameters<NamesStore["useAsSeed"]>) => edit(account, "useAsSeed", args),
        togglePreference: (...args: Parameters<NamesStore["togglePreference"]>) => edit(account, "togglePreference", args),
        toggleComparison: (...args: Parameters<NamesStore["toggleComparison"]>) => edit(account, "toggleComparison", args),
        clearComparison: () => edit(account, "clearComparison", []),
        importBackup: (...args: Parameters<NamesStore["importBackup"]>) => edit(account, "importBackup", args),
        retrySave: () => account && current(account) ? record?.loaded ? save(account) : read(account) : Promise.resolve(),
        loadSaved: () => account && current(account) ? read(account, true) : Promise.resolve(),
      };
    },
  };
}
