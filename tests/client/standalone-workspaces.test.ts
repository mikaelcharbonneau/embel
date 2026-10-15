import { afterEach, describe, expect, it, vi } from "vitest";
import { createStandaloneDraftMemory } from "../../src/components/tools/standalone-draft-memory";
import { getStandaloneWorkspace, saveStandaloneWorkspace, getStandaloneImport, standaloneErrorMessage } from "../../src/components/tools/account-standalone-client";
import { domainDraftSchema } from "../../src/features/domain-workspace/draft";
import type { StandalonePayloadCodec } from "../../src/domain/standalone-workspaces";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const account = { userId: owner, generation: 1 }, payload = { version: 1 as const, input: "Cedar", extensions: ["com"], candidates: [] as string[] };
const codec = { tool: "domains", schema: domainDraftSchema } satisfies StandalonePayloadCodec;
const input = { requestKey: id, expectedRevision: 0, payload, imports: [] };
const workspace = () => ({ id, ownerId: owner, tool: "domains" as const, revision: 1, payload, imports: [], createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z" });
const record = () => ({ workspace: null, payload, imports: [], dirty: true, pending: null, conflict: false });
const response = () => ({ ownerId: owner, workspace: workspace() });
const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());

describe("standalone owner-bound provider memory", () => {
  it("hides while unverified, retains same-owner pending intent and fences old generations", () => {
    const store = createStandaloneDraftMemory(); store.bind(account);
    store.set(account, "domains", { ...record(), pending: input }); const original = store.get(account, "domains");
    store.bind(null); expect(store.get(account, "domains")).toBeNull(); expect(store.hasUnsaved()).toBe(true);
    expect(store.set(account, "domains", { ...record(), dirty: false })).toBe(false);
    const next = { ...account, generation: 3 }; store.bind(next);
    expect(store.get(next, "domains")).toBe(original); expect(store.get(next, "domains")?.pending).toEqual(input);
    expect(store.get(account, "domains")).toBeNull(); expect(store.set(account, "domains", { ...record(), dirty: false })).toBe(false);
  });
  it("clears private memory on verified owner switch and confirmed logout", () => {
    const store = createStandaloneDraftMemory(); store.bind(account); store.set(account, "domains", record());
    store.bind({ userId: other, generation: 2 }); expect(store.hasUnsaved()).toBe(false); expect(store.get(account, "domains")).toBeNull();
    store.bind(account); expect(store.get(account, "domains")).toBeNull();
    store.set(account, "domains", record()); store.clear(); expect(store.hasUnsaved()).toBe(false); expect(store.isCurrent(account)).toBe(false);
  });
  it("counts conflicts/uncertain commits as unsaved and rejects foreign workspaces", () => {
    const store = createStandaloneDraftMemory(); store.bind(account);
    store.set(account, "domains", { ...record(), conflict: true }); expect(store.hasUnsaved()).toBe(true);
    expect(() => store.set(account, "domains", { ...record(), workspace: { ...workspace(), ownerId: other } })).toThrow("owner mismatch");
    store.set(account, "domains", { ...record(), workspace: workspace(), dirty: false, pending: input }); expect(store.hasUnsaved()).toBe(true);
    store.set(account, "domains", { ...record(), workspace: workspace(), dirty: false }); expect(store.hasUnsaved()).toBe(false);
  });
  it("isolates tool records, freezes captured intent and notifies only provider subscribers", () => {
    const store = createStandaloneDraftMemory(), changed = vi.fn(); const unsubscribe = store.subscribe(changed);
    store.bind(account); const mutable = { ...record(), pending: structuredClone(input) }; store.set(account, "domains", mutable);
    mutable.pending.payload.input = "Changed externally"; expect(store.get(account, "domains")?.pending?.payload).toEqual(payload);
    expect(() => { (store.get(account, "domains")!.payload as typeof payload).input = "Changed"; }).toThrow();
    expect(store.get(account, "handles")).toBeNull(); unsubscribe(); store.clear(); expect(changed).toHaveBeenCalledTimes(2);
  });
});

describe("standalone bounded private browser client", () => {
  it("uses same-origin/no-store and validates exact revision/payload on save", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(response())); vi.stubGlobal("fetch", fetcher);
    expect(await saveStandaloneWorkspace(codec, account, input, signal())).toEqual(response());
    expect(fetcher).toHaveBeenCalledWith("/api/workspaces/domains", expect.objectContaining({ method: "PUT", credentials: "same-origin", mode: "same-origin", cache: "no-store", body: JSON.stringify(input), headers: expect.objectContaining({ "X-Embel-Account": owner }) }));
  });
  it("retains exact save body and request key for an uncertain commit retry", async () => {
    const bodies: string[] = []; let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => { bodies.push(init.body); if (n++ === 0) throw new TypeError("lost response after commit"); return Response.json(response()); }));
    const store = createStandaloneDraftMemory(); store.bind(account); store.set(account, "domains", { ...record(), pending: input });
    await expect(saveStandaloneWorkspace(codec, account, input, signal())).rejects.toThrow();
    const pending = store.get(account, "domains")!.pending!; expect(await saveStandaloneWorkspace(codec, account, pending, signal())).toEqual(response());
    expect(bodies).toEqual([JSON.stringify(input), JSON.stringify(input)]);
  });
  it("never accepts foreign owner or a mismatched save revision or payload", async () => {
    for (const bad of [{ ...response(), ownerId: other }, { ...response(), workspace: { ...workspace(), revision: 2 } }, { ...response(), workspace: { ...workspace(), payload: { ...payload, input: "Changed" } } }]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(bad)));
      await expect(saveStandaloneWorkspace(codec, account, input, signal())).rejects.toMatchObject({ status: 502 });
    }
  });
  it("refuses provider evidence in a success DTO or mutation before transport", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ...response(), workspace: { ...workspace(), payload: { ...payload, orders: [] } } })); vi.stubGlobal("fetch", fetcher);
    await expect(getStandaloneWorkspace(codec, account, signal())).rejects.toMatchObject({ status: 502 });
    fetcher.mockClear(); await expect(saveStandaloneWorkspace(codec, account, { ...input, payload: { ...payload, checks: [] } }, signal())).rejects.toMatchObject({ status: 422 }); expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds streamed success bodies and handles malformed JSON/type safely", async () => {
    for (const response of [new Response("x".repeat(262145), { headers: { "content-type": "application/json", "content-length": "1" } }), new Response("{", { headers: { "content-type": "application/json" } }), new Response("{}", { headers: { "content-type": "text/html" } })]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(getStandaloneWorkspace(codec, account, signal())).rejects.toMatchObject({ status: 502 });
    }
  });
  it("fences already aborted calls and late response bodies", async () => {
    const controller = new AbortController(); controller.abort(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(getStandaloneWorkspace(codec, account, controller.signal)).rejects.toMatchObject({ name: "AbortError" }); expect(fetcher).not.toHaveBeenCalled();
    const late = new AbortController(); vi.stubGlobal("fetch", vi.fn(async () => { late.abort(); return Response.json(response()); }));
    await expect(getStandaloneWorkspace(codec, account, late.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("rejects a foreign/mismatched imported project and malformed source selectors", async () => {
    const source = { projectId: other, projectRevision: 1, projectTitle: "Hidden", name: "Hidden", selectionId: null, candidateId: null, origin: "project_name" };
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ownerId: owner, source })); vi.stubGlobal("fetch", fetcher);
    await expect(getStandaloneImport(id, account, signal())).rejects.toMatchObject({ status: 502 });
    fetcher.mockClear(); await expect(getStandaloneImport("bad", account, signal())).rejects.toMatchObject({ status: 422 }); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 409, 413, 422, 503])("preserves honest HTTP %i without leaking response messages", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "PRIVATE DATABASE DETAILS" } }, { status })));
    await expect(getStandaloneWorkspace(codec, account, signal())).rejects.toMatchObject({ status, message: "The account request could not be completed." });
  });
});

describe("standalone save conflict and uncertain-outcome classifications", () => {
  it.each([409, 503])("keeps save HTTP %i distinct without interpreting private error text", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "revision_conflict private message" } }, { status })));
    const result = await saveStandaloneWorkspace(codec, account, input, signal()).catch(error => error);
    expect(result).toMatchObject({ status, message: "The account request could not be completed." });
    expect(standaloneErrorMessage(result)).toBe(status === 409
      ? "The saved workspace or imported source changed. Your edits are retained; choose which version to keep."
      : "Account workspaces are unavailable. Your draft is retained in this tab.");
  });
});
