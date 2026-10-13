import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectScreeningClient } from "@/components/naming/project-screening-client";
import { createProjectScreeningMemory, type ScreeningDraft } from "@/components/naming/project-screening-memory";
import { screeningInput, screeningOwner, screeningPage, screeningProject, screeningRecord, screeningSelection } from "../fixtures/project-screening";
const account = { userId: screeningOwner, generation: 1 };
const draft: ScreeningDraft = { tool: "domains", domain: "cedar.com", handle: "cedar", platform: "youtube", jurisdictions: "EM", niceClasses: "", notes: "Private local fixture", sources: "", observedAt: screeningInput.observedAt, acknowledged: false, dirty: true, pendingInput: null };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("screening private client and draft memory", () => {
  it("hides drafts across unverification, retains same-owner recovery and clears owner replacement", () => {
    const memory = createProjectScreeningMemory(); memory.bind(account); memory.put(account, screeningProject, screeningSelection, 2, draft);
    memory.bind(null); expect(memory.get(account, screeningProject, screeningSelection, 2)).toBeNull(); expect(memory.hasUnsaved()).toBe(true);
    const current = { ...account, generation: 2 }; memory.bind(current);
    expect(memory.get(account, screeningProject, screeningSelection, 2)).toBeNull(); expect(memory.get(current, screeningProject, screeningSelection, 2)?.notes).toBe(draft.notes);
    memory.put(account, screeningProject, screeningSelection, 2, null); expect(memory.hasUnsaved()).toBe(true);
    memory.bind({ userId: screeningRecord.id, generation: 3 }); expect(memory.hasUnsaved()).toBe(false);
    memory.bind(current); expect(memory.get(current, screeningProject, screeningSelection, 2)).toBeNull();
  });
  it("retains the exact uncertain record input and rejects an intent from another basis", () => {
    const memory = createProjectScreeningMemory(); memory.bind(account);
    memory.put(account, screeningProject, screeningSelection, 2, { ...draft, pendingInput: screeningInput });
    expect(memory.get(account, screeningProject, screeningSelection, 2)?.pendingInput).toEqual(screeningInput);
    memory.put(account, screeningProject, screeningSelection, 3, { ...draft, pendingInput: screeningInput });
    expect(memory.get(account, screeningProject, screeningSelection, 3)).toBeNull(); memory.clear(); expect(memory.hasUnsaved()).toBe(false);
  });
  it("rejects owner/intent substitutions and expires only the still-current account", async () => {
    const expire = vi.fn(), current = vi.fn(() => true);
    const client = createProjectScreeningClient({ ownerId: screeningOwner, projectId: screeningProject, isCurrent: current, expire });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ ...screeningPage, ownerId: screeningRecord.id, currentBasis: null })).mockResolvedValueOnce(Response.json({ ...screeningRecord, notes: "Substituted" })).mockResolvedValueOnce(new Response(null, { status: 401 })));
    await expect(client.read(new AbortController().signal)).rejects.toMatchObject({ status: 502 });
    await expect(client.record(screeningInput, new AbortController().signal)).rejects.toMatchObject({ status: 502 });
    await expect(client.read(new AbortController().signal)).rejects.toMatchObject({ status: 401 }); expect(expire).toHaveBeenCalledOnce();
  });
  it("fences late transport completion after cancellation or account replacement", async () => {
    let resolve!: (value: Response) => void, active = true;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const client = createProjectScreeningClient({ ownerId: screeningOwner, projectId: screeningProject, isCurrent: () => active, expire: vi.fn() });
    const controller = new AbortController(); const pending = client.read(controller.signal); const caught = pending.catch(error => error);
    controller.abort(); active = false; resolve(Response.json(screeningPage)); expect(await caught).toMatchObject({ status: 408 });
  });
  it("bounds a stalled complete HTTP wait without automatically retrying", async () => {
    vi.useFakeTimers(); const fetcher = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal("fetch", fetcher);
    const client = createProjectScreeningClient({ ownerId: screeningOwner, projectId: screeningProject, isCurrent: () => true, expire: vi.fn() });
    const caught = client.record(screeningInput, new AbortController().signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(25001); expect(await caught).toMatchObject({ status: 408 }); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects oversized decoded replies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(" ".repeat(1048577), { headers: { "content-type": "application/json" } })));
    const client = createProjectScreeningClient({ ownerId: screeningOwner, projectId: screeningProject, isCurrent: () => true, expire: vi.fn() });
    await expect(client.read(new AbortController().signal)).rejects.toMatchObject({ status: 502 });
  });
});
