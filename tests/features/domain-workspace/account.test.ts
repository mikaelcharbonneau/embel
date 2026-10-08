import { afterEach, describe, expect, it, vi } from "vitest";
import { getStandaloneImport, getStandaloneWorkspace, saveStandaloneWorkspace } from "../../../src/components/tools/account-standalone-client";
import { createStandaloneDraftMemory } from "../../../src/components/tools/standalone-draft-memory";
import { standalonePayloadCodec } from "../../../src/features/domain-workspace/account-codec";
import { emptyDomainDraft } from "../../../src/features/domain-workspace/draft";

const owner = "11111111-1111-4111-8111-111111111111";
const foreign = "22222222-2222-4222-8222-222222222222";
const account = { userId: owner, generation: 1 };
const workspace = { id: "33333333-3333-4333-8333-333333333333", ownerId: owner, tool: "domains" as const, revision: 1,
  payload: { ...emptyDomainDraft("North Star"), candidates: ["northstar.com", "northstar.co", "northstar.io"] }, imports: [],
  createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z" };
const signal = () => new AbortController().signal;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

describe("Domains consumer using the shared private account client", () => {
  it("reads a strict owned draft through only the same-origin account route", async () => {
    const fetch = vi.fn(async () => response({ ownerId: owner, workspace })); vi.stubGlobal("fetch", fetch);
    expect((await getStandaloneWorkspace(standalonePayloadCodec, account, signal())).workspace?.payload).toEqual(workspace.payload);
    expect(fetch).toHaveBeenCalledWith("/api/workspaces/domains", expect.objectContaining({ method: "GET", mode: "same-origin", credentials: "same-origin", cache: "no-store" }));
  });
  it.each([
    { ownerId: foreign, workspace: { ...workspace, ownerId: foreign } },
    { ownerId: owner, workspace: { ...workspace, tool: "handles" } },
    { ownerId: owner, workspace: { ...workspace, payload: { ...workspace.payload, orders: [] } } },
    { ownerId: owner, workspace: { ...workspace, payload: { ...workspace.payload, candidates: ["other.com"] } } },
  ])("rejects foreign, mismatched-tool and injected evidence replies", async value => {
    vi.stubGlobal("fetch", vi.fn(async () => response(value)));
    await expect(getStandaloneWorkspace(standalonePayloadCodec, account, signal())).rejects.toMatchObject({ status: 502 });
  });
  it("uses explicit CAS, never sends an owner assertion and retains conflicts for the caller", async () => {
    const input = { requestKey: "44444444-4444-4444-8444-444444444444", expectedRevision: 1, payload: emptyDomainDraft("New Name"), imports: [] };
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.method).toBe("PUT"); expect(JSON.parse(String(options.body))).toEqual(input);
      return response({ ownerId: owner, workspace: { ...workspace, payload: input.payload, revision: 2 } });
    });
    vi.stubGlobal("fetch", fetch);
    expect((await saveStandaloneWorkspace(standalonePayloadCodec, account, input, signal())).workspace?.revision).toBe(2);
    fetch.mockImplementationOnce(async () => response({ error: "fixture conflict" }, 409));
    await expect(saveStandaloneWorkspace(standalonePayloadCodec, account, input, signal())).rejects.toMatchObject({ status: 409 });
    expect(input.expectedRevision).toBe(1); expect(input.payload.input).toBe("New Name");
  });
  it("rejects stale save acknowledgements and malformed drafts before any network write", async () => {
    const fetch = vi.fn(async () => response({ ownerId: owner, workspace })); vi.stubGlobal("fetch", fetch);
    const input = { requestKey: "44444444-4444-4444-8444-444444444444", expectedRevision: 1, payload: workspace.payload, imports: [] };
    await expect(saveStandaloneWorkspace(standalonePayloadCodec, account, input, signal())).rejects.toMatchObject({ status: 502 });
    fetch.mockClear();
    await expect(saveStandaloneWorkspace(standalonePayloadCodec, account, { ...input, payload: { ...input.payload, registration: "confirmed" } }, signal())).rejects.toMatchObject({ status: 422 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects wrong-owner/source imports and never uses a provider endpoint", async () => {
    const projectId = "55555555-5555-4555-8555-555555555555";
    const source = { projectId, projectRevision: 2, selectionId: null, candidateId: null, projectTitle: "Saved project", name: "Owned Name", origin: "project_name" };
    const fetch = vi.fn(async () => response({ ownerId: owner, source })); vi.stubGlobal("fetch", fetch);
    expect((await getStandaloneImport(projectId, account, signal())).source?.name).toBe("Owned Name");
    expect(fetch).toHaveBeenCalledWith(`/api/workspaces/imports?projectId=${projectId}`, expect.objectContaining({ method: "GET" }));
    fetch.mockImplementationOnce(async () => response({ ownerId: foreign, source }));
    await expect(getStandaloneImport(projectId, account, signal())).rejects.toMatchObject({ status: 502 });
    fetch.mockImplementationOnce(async () => response({ ownerId: owner, source: { ...source, projectId: foreign } }));
    await expect(getStandaloneImport(projectId, account, signal())).rejects.toMatchObject({ status: 502 });
  });
  it("rejects a late response even if a transport ignores the aborted signal", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const controller = new AbortController();
    const pending = getStandaloneWorkspace(standalonePayloadCodec, account, controller.signal);
    controller.abort(); resolve(response({ ownerId: owner, workspace }));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
  it("hides expired-session draft memory, recovers only for the same owner and clears on owner change", () => {
    const memory = createStandaloneDraftMemory(); memory.bind(account);
    const record = { workspace, payload: emptyDomainDraft("Unsaved Name"), imports: [], dirty: true, pending: null, conflict: true };
    expect(memory.set(account, "domains", record)).toBe(true);
    memory.bind(null);
    expect(memory.get(account, "domains")).toBeNull(); expect(memory.hasUnsaved()).toBe(true);
    const resumed = { ...account, generation: 2 }; memory.bind(resumed);
    expect(memory.get(account, "domains")).toBeNull();
    expect(memory.get(resumed, "domains")?.payload).toEqual(record.payload);
    expect(memory.set(account, "domains", record)).toBe(false);
    const changed = { userId: foreign, generation: 3 }; memory.bind(changed);
    expect(memory.get(changed, "domains")).toBeNull(); expect(memory.hasUnsaved()).toBe(false);
  });
});
