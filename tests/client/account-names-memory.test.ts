import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountNamesMemory } from "@/components/naming/account-names-memory";
import { createNamesStore, NAMES_STORAGE_KEY } from "@/components/naming/local-names";
import { emptyGuidedUi } from "@/domain/names-guided";
import { namesWorkspaceResponseSchema, type AccountNamesWorkspace, type SaveNamesWorkspaceInput } from "@/domain/names-workspace";
import { namesWorkspaceRequest } from "@/components/naming/names-workspace-client";

const account = { userId: "aaaaaaaa-1111-4111-8111-111111111111", generation: 1 };
const other = { userId: "bbbbbbbb-1111-4111-8111-111111111111", generation: 2 };
const timestamp = "2026-10-15T12:00:00Z";
let fetcher: ReturnType<typeof vi.fn>, stored: AccountNamesWorkspace | null, lost: boolean, denied: boolean;
const receipts = new Map<string, AccountNamesWorkspace>();
const memories: ReturnType<typeof createAccountNamesMemory>[] = [];
function memory() {
  const result = createAccountNamesMemory({ createId: randomUUID, debounceMs: 100 });
  memories.push(result); result.subscribe(() => {}); return result;
}
async function load(result = memory(), owner = account) { result.bind(owner); await vi.advanceTimersByTimeAsync(0); return result; }
async function save() { await vi.advanceTimersByTimeAsync(100); }
function puts() { return fetcher.mock.calls.filter(([, init]) => init.method === "PUT").map(([, init]) => JSON.parse(init.body) as SaveNamesWorkspaceInput); }

beforeEach(() => {
  vi.useFakeTimers(); stored = null; lost = false; denied = false; receipts.clear();
  fetcher = vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method === "PUT") {
      if (denied) return Response.json({}, { status: 503 });
      const body = JSON.parse(String(init.body)) as SaveNamesWorkspaceInput;
      const receipt = receipts.get(body.requestKey);
      if (receipt) return Response.json({ ownerId: account.userId, workspace: receipt });
      if (body.expectedRevision !== (stored?.revision ?? 0)) return Response.json({}, { status: 409 });
      stored = { id: randomUUID(), ownerId: account.userId, revision: body.expectedRevision + 1, payload: body.payload, createdAt: timestamp, updatedAt: timestamp };
      receipts.set(body.requestKey, stored);
      if (lost) { lost = false; throw new Error("Lost acknowledgement after commit"); }
    }
    return Response.json({ ownerId: account.userId, workspace: stored });
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { memories.splice(0).forEach(item => item.clear()); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("account Names autosave", () => {
  it("does not request, edit, or import unowned browser data before account verification", async () => {
    const getItem = vi.fn(() => "private legacy browser data"), setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem, setItem });
    const result = memory();
    expect(result.actions(null).addManual("Anonymous").ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    await load(result); result.actions(account).addManual("Owned"); await save();
    expect(getItem).not.toHaveBeenCalled(); expect(setItem).not.toHaveBeenCalled();
    expect(stored!.payload.candidates[0]!.source.value).toBe("Owned");
    expect(fetcher.mock.calls.find(([, init]) => init.method === "PUT")![1].headers).toMatchObject({ "X-Embel-Account": account.userId });
  });

  it("debounces complete manual, workshop, context, favorite and saved-list edits and reloads from the account", async () => {
    const result = await load(), actions = result.actions(account);
    actions.updateContext({ description: "A lighting studio", knownAudience: "Small homes", namingNotes: "Warm" });
    actions.addManual("Lumi"); const id = result.getSnapshot().data.candidates[0]!.source.id;
    actions.togglePreference(id, "favorite"); actions.useAsSeed(id);
    actions.runWorkshop({ kind: "affixes", seed: "Lumi", prefixes: [], suffixes: ["na"], separator: "" });
    actions.updateUi({ guided: { ...emptyGuidedUi(), words: [{ value: "Lumi", candidateId: id }], savedLists: [{ id: randomUUID(), words: [{ value: "Lumi", candidateId: id }], context: result.getSnapshot().data.ui.context, createdAt: timestamp }] } });
    expect(puts()).toHaveLength(0); expect(result.getSnapshot().saveStatus).toBe("saving");
    await save(); expect(puts()).toHaveLength(1); expect(result.getSnapshot().saveStatus).toBe("saved"); expect(result.hasUnsaved()).toBe(false);
    const reloaded = await load(); expect(reloaded.getSnapshot().data).toEqual(result.getSnapshot().data);
    expect(reloaded.getSnapshot().data.candidates[0]).toMatchObject({ favorite: true, saved: true, context: { description: "A lighting studio" } });
    expect(reloaded.getSnapshot().data.runs).toHaveLength(1); expect(reloaded.getSnapshot().data.ui.guided!.savedLists).toHaveLength(1);
  });

  it("retries the identical lost acknowledgement before saving subsequent buffered edits", async () => {
    const result = await load(), actions = result.actions(account);
    lost = true; actions.addManual("First"); await save();
    expect(result.getSnapshot().saveStatus).toBe("error"); expect(result.hasUnsaved()).toBe(true);
    actions.addManual("Later"); await save(); expect(puts()).toHaveLength(1);
    await actions.retrySave(); expect(puts()).toHaveLength(2); expect(puts()[1]).toEqual(puts()[0]);
    expect(result.getSnapshot().saveStatus).toBe("saving"); await save();
    expect(puts()[2]!.expectedRevision).toBe(1); expect(puts()[2]!.requestKey).not.toBe(puts()[0]!.requestKey);
    expect(stored!.payload.candidates.map(entry => entry.source.value)).toEqual(["First", "Later"]);
    expect(result.getSnapshot().saveStatus).toBe("saved");
  });

  it("keeps newer edits while a save is in flight and never sends parallel writes", async () => {
    const result = await load(), actions = result.actions(account);
    let finish!: () => void; const original = fetcher.getMockImplementation() as (path: string, init: RequestInit) => Promise<Response>;
    fetcher.mockImplementationOnce((_path, init) => new Promise<Response>(resolve => { finish = () => { void Promise.resolve(original(_path, init)).then(resolve); }; }));
    actions.addManual("First"); await save(); actions.addManual("Second"); await save(); expect(puts()).toHaveLength(1);
    finish(); await vi.advanceTimersByTimeAsync(0); expect(result.getSnapshot().data.candidates).toHaveLength(2); expect(result.getSnapshot().dirty).toBe(true);
    await save(); expect(puts()).toHaveLength(2); expect(stored!.payload.candidates).toHaveLength(2);
  });

  it("uses corrected edits after a definitive validation rejection", async () => {
    const result = await load(), actions = result.actions(account);
    fetcher.mockResolvedValueOnce(Response.json({}, { status: 422 }));
    actions.updateContext({ description: "Rejected details" }); await save();
    actions.updateContext({ description: "Corrected details" }); await actions.retrySave();
    expect(puts()).toHaveLength(2); expect(puts()[1]!.requestKey).not.toBe(puts()[0]!.requestKey);
    expect(stored!.payload.ui.context.description).toBe("Corrected details"); expect(result.getSnapshot().saveStatus).toBe("saved");
  });

  it("retains failed saves through same-owner reverification and rejects stale action closures", async () => {
    const result = await load(), actions = result.actions(account);
    denied = true; actions.addManual("Keep me"); await save();
    result.bind(null); expect(result.getSnapshot().data.candidates).toHaveLength(0); expect(result.hasUnsaved()).toBe(true);
    const newer = { ...account, generation: 3 }; result.bind(newer);
    expect(result.getSnapshot().data.candidates[0]!.source.value).toBe("Keep me");
    expect(actions.addManual("Stale").ok).toBe(false); expect(result.getSnapshot().saveStatus).toBe("error");
    denied = false; await result.actions(newer).retrySave(); expect(result.getSnapshot().saveStatus).toBe("saved");
  });

  it("fences late writes and clears the prior account's edits on an owner switch", async () => {
    const result = await load(), actions = result.actions(account);
    let finish!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    actions.addManual("Private A"); await save(); const first = puts()[0]!;
    fetcher.mockImplementation(async () => Response.json({ ownerId: other.userId, workspace: null }));
    result.bind(other); await vi.advanceTimersByTimeAsync(0);
    finish(Response.json({ ownerId: account.userId, workspace: { id: randomUUID(), ownerId: account.userId, revision: 1, payload: first.payload, createdAt: timestamp, updatedAt: timestamp } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.getSnapshot().data.candidates).toHaveLength(0); expect(actions.addManual("Leak").ok).toBe(false); expect(result.hasUnsaved()).toBe(false);
  });

  it("fences a cookie-only owner change at the mutation request, before any response is accepted", async () => {
    const result = await load(); const expired = vi.fn(() => result.bind(null)); result.setUnauthorized(expired);
    fetcher.mockImplementationOnce(async (_path, init) => {
      expect(new Headers(init.headers).get("X-Embel-Account")).toBe(account.userId);
      // The API compares this expected account to its authenticated cookie owner.
      return Response.json({}, { status: 401 });
    });
    result.actions(account).addManual("Private A"); await save();
    expect(expired).toHaveBeenCalledWith(account); expect(stored).toBeNull();
    expect(result.getSnapshot().data.candidates).toHaveLength(0); expect(result.hasUnsaved()).toBe(true);
  });

  it("preserves both branches on a conflict until explicitly loading the saved version", async () => {
    const first = await load(), second = await load();
    first.actions(account).addManual("Saved elsewhere"); await save();
    second.actions(account).addManual("Keep my branch"); await save();
    expect(second.getSnapshot().saveStatus).toBe("conflict"); expect(second.getSnapshot().data.candidates[0]!.source.value).toBe("Keep my branch");
    expect(stored!.payload.candidates[0]!.source.value).toBe("Saved elsewhere");
    await second.actions(account).loadSaved(); expect(second.getSnapshot().data.candidates[0]!.source.value).toBe("Saved elsewhere"); expect(second.hasUnsaved()).toBe(false);
  });

  it("does not replace intervening edits with a delayed explicit recovery read", async () => {
    const result = await load(); result.actions(account).addManual("Initial"); await save();
    let finish!: (response: Response) => void; fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    const reading = result.actions(account).loadSaved(); result.actions(account).addManual("While loading");
    finish(Response.json({ ownerId: account.userId, workspace: stored })); await reading;
    expect(result.getSnapshot().data.candidates).toHaveLength(2); expect(result.getSnapshot().saveStatus).toBe("conflict");
  });

  it("requires a new account read after failures and never starts an empty overwrite", async () => {
    fetcher.mockResolvedValueOnce(Response.json({}, { status: 503 })); const result = await load();
    expect(result.getSnapshot().loaded).toBe(false); expect(result.actions(account).addManual("Blocked").ok).toBe(false); expect(puts()).toHaveLength(0);
    await result.actions(account).retrySave(); expect(result.getSnapshot().loaded).toBe(true);
  });

  it("merges explicit legacy imports without deleting or duplicating names and history", async () => {
    let raw: string | null = null;
    const legacy = createNamesStore({ storage: () => ({ getItem: key => key === NAMES_STORAGE_KEY ? raw : null, setItem: (_key, value) => { raw = value; } }), createId: randomUUID });
    legacy.addManual("Legacy"); legacy.useAsSeed(legacy.getSnapshot().data.candidates[0]!.source.id);
    legacy.runWorkshop({ kind: "affixes", seed: "Legacy", prefixes: [], suffixes: ["One"], separator: "" }); const original = raw!;
    const result = await load(), actions = result.actions(account); actions.addManual("Account name"); await save();
    expect(actions.importBackup(original, result.getSnapshot().data).ok).toBe(true); await save();
    expect(actions.importBackup(original, result.getSnapshot().data).ok).toBe(true); await save();
    expect(result.getSnapshot().data.candidates).toHaveLength(3); expect(result.getSnapshot().data.runs).toHaveLength(1); expect(raw).toBe(original);
    expect(stored!.payload.candidates.map(candidate => candidate.source.value)).toEqual(["Account name", "Legacy", "LegacyOne"]);
  });

  it("rejects wrong-owner acknowledgements and bounded transport timeouts without claiming persistence", async () => {
    const result = await load(); fetcher.mockResolvedValueOnce(Response.json({ ownerId: other.userId, workspace: null }));
    result.actions(account).addManual("Private"); await save(); expect(result.getSnapshot().saveStatus).toBe("error"); expect(result.hasUnsaved()).toBe(true);
    fetcher.mockImplementationOnce(() => new Promise(() => {})); const retry = result.actions(account).retrySave();
    await vi.advanceTimersByTimeAsync(30000); await retry; expect(result.getSnapshot().saveStatus).toBe("error");
  });

  it("bounds response streams independently of content-length", async () => {
    fetcher.mockResolvedValueOnce(new Response(" ".repeat(4_002_000), { headers: { "content-type": "application/json" } }));
    await expect(namesWorkspaceRequest("/api/names/workspace", namesWorkspaceResponseSchema, { signal: new AbortController().signal })).rejects.toMatchObject({ status: 502 });
  });
});
