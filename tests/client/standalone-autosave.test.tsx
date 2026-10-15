// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStandaloneDraftMemory, type StandaloneDraftMemory } from "@/components/tools/standalone-draft-memory";
import { STANDALONE_AUTOSAVE_DELAY_MS, useStandaloneWorkspace } from "@/components/tools/use-standalone-workspace";
import { StandaloneSaveStatus } from "@/components/tools/standalone-save-status";
import { HandlesWorkspace } from "@/features/handles-workspace/handles-workspace";
import type { HandlesState } from "@/features/handles-workspace/domain";
import { standalonePayloadCodec as domains } from "@/features/domain-workspace/account-codec";
import { emptyDomainDraft, toggleDomainShortlist } from "@/features/domain-workspace/draft";
import { createEmptyHandlesDraft, standalonePayloadCodec as handles } from "@/features/handles-workspace/account-codec";
import { createEntry } from "@/features/handles-workspace/domain";
import { createEmptyTrademarkAccountDraft, standalonePayloadCodec as trademarks } from "@/features/trademark-workspace/account-codec";
import type { SaveStandaloneWorkspaceInput, StandalonePayloadCodec, StandaloneTool, StandaloneWorkspace } from "@/domain/standalone-workspaces";

const auth = vi.hoisted(() => ({ session: { status: "ready" as "ready" | "checking", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 }, isCurrent: vi.fn(), expire: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => auth }));
const owner = auth.session.userId, other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", workspaceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", stamp = "2026-10-15T12:00:00Z";
const codecs: Record<StandaloneTool, StandalonePayloadCodec> = { domains, handles, trademarks };
const empty: Record<StandaloneTool, () => unknown> = { domains: emptyDomainDraft, handles: createEmptyHandlesDraft, trademarks: createEmptyTrademarkAccountDraft };
function payload(tool: StandaloneTool, text: string): unknown {
  if (tool === "domains") return emptyDomainDraft(text);
  if (tool === "trademarks") return { ...createEmptyTrademarkAccountDraft(text), goodsServices: "Furniture" };
  return { version: 1, bundles: [{ id: "test-bundle", title: text, list: "Saved candidates", savedAt: stamp, source: { id: "manual", name: "Cedar", origin: "manual", projectId: null, projectTitle: null }, entries: [createEntry("instagram", "cedar")] }] };
}
let root: Root, host: HTMLDivElement, memory: StandaloneDraftMemory;
let state: ReturnType<typeof useStandaloneWorkspace<unknown>>;
let stored: StandaloneWorkspace | null, bodies: SaveStandaloneWorkspaceInput[], reads: number;
let write: (input: SaveStandaloneWorkspaceInput) => Promise<Response>;
function commit(input: SaveStandaloneWorkspaceInput) {
  stored = { id: workspaceId, ownerId: owner, tool: "domains", revision: input.expectedRevision + 1, payload: input.payload, imports: [], createdAt: stamp, updatedAt: stamp };
  return Response.json({ ownerId: owner, workspace: stored });
}
function Harness({ tool }: { tool: StandaloneTool }) {
  const value = useStandaloneWorkspace({ codec: codecs[tool], emptyPayload: empty[tool], memory });
  useLayoutEffect(() => { state = value; });
  return <><StandaloneSaveStatus state={value} />{tool === "handles" && value.payload !== null && <HandlesWorkspace value={value.payload as HandlesState} onChange={value.setPayload} disabled={!value.canEdit} saveCheckEvidence={false} />}</>;
}
async function render(tool: StandaloneTool = "domains", mounted = true) {
  await act(async () => root.render(mounted ? <Harness tool={tool} /> : null));
  await tick(0);
}
async function tick(duration = STANDALONE_AUTOSAVE_DELAY_MS) { await act(async () => { await vi.advanceTimersByTimeAsync(duration); }); }
async function edit(text: string, tool: StandaloneTool = "domains") { await act(async () => state.setPayload(payload(tool, text))); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function current() { return memory.get(auth.session, "domains")!; }
function button(text: string) { return [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text)!; }

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  auth.session = { status: "ready", userId: owner, generation: 1 };
  auth.isCurrent.mockImplementation((account: typeof auth.session) => auth.session.status === "ready" && auth.session.userId === account.userId && auth.session.generation === account.generation);
  auth.expire.mockReset(); memory = createStandaloneDraftMemory(); memory.bind(auth.session);
  stored = null; bodies = []; reads = 0; write = async input => commit(input);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "GET") { reads += 1; return Response.json({ ownerId: auth.session.userId, workspace: auth.session.userId === owner ? stored : null }); }
    const input = JSON.parse(String(init.body)) as SaveStandaloneWorkspaceInput; bodies.push(input);
    const result = await write(input);
    // Test fixture persists each tool through the same real bounded HTTP client.
    const resultBody = await result.json();
    if (result.ok && resultBody.workspace) { resultBody.workspace.tool = url.split("/").at(-1); if (stored) stored.tool = resultBody.workspace.tool; }
    return Response.json(resultBody, { status: result.status });
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => { memory.clear(); root.unmount(); }); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("account-authoritative standalone autosave", () => {
  it.each(["domains", "handles", "trademarks"] as const)("debounces %s edits, shows Saved only after acknowledgement, and reloads the database value", async tool => {
    await render(tool); expect(bodies).toEqual([]);
    await edit("Cedar", tool); expect(host.textContent).toContain("Saving…");
    await tick(STANDALONE_AUTOSAVE_DELAY_MS - 1); expect(bodies).toEqual([]);
    await tick(1); expect(bodies).toHaveLength(1); expect(state.dirty).toBe(false); expect(state.pending).toBe(false);
    expect(host.querySelector('[aria-label="Save status"]')?.textContent).toBe("Saved"); expect(host.querySelector('[aria-label="Save status"] button')).toBeNull();
    await render(tool, false); memory = createStandaloneDraftMemory(); memory.bind(auth.session);
    await render(tool); expect(state.payload).toEqual(payload(tool, "Cedar")); expect(reads).toBe(2);
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });

  it("autosaves unfinished Handles typing, platforms, variations and saved searches across reload", async () => {
    async function fill(label: string, text: string) {
      const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
      expect(input).not.toBeNull();
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); });
    }
    await render("handles");
    await fill("Business handles", "Cedar"); await fill("Prefixes", "try, get");
    const platform = [...host.querySelectorAll("label")].find(label => label.textContent === "TikTok")!.querySelector<HTMLInputElement>("input")!;
    await act(async () => platform.click()); await tick();
    expect((stored!.payload as HandlesState).search).toMatchObject({ nameDraft: "Cedar", names: "", options: { prefixes: "try, get" } });
    expect((stored!.payload as HandlesState).search!.platforms).not.toContain("tiktok");
    await render("handles", false); memory = createStandaloneDraftMemory(); memory.bind(auth.session); await render("handles");
    expect(host.querySelector<HTMLInputElement>('[aria-label="Business handles"]')!.value).toBe("Cedar");
    expect(host.querySelector<HTMLInputElement>('[aria-label="Prefixes"]')!.value).toBe("try, get");
    await act(async () => button("Save search").click()); await tick();
    expect((stored!.payload as HandlesState).search!.savedSearches).toHaveLength(1);
    await render("handles", false); memory = createStandaloneDraftMemory(); memory.bind(auth.session); await render("handles");
    await act(async () => button("Saved").click()); expect(host.textContent).toContain("Cedar"); expect(button("Use search")).toBeDefined();
    await act(async () => button("Remove search").click()); await tick();
    expect((stored!.payload as HandlesState).search!.savedSearches).toEqual([]);
  });

  it("autosaves domain shortlist changes during a pending search save and reloads the latest choices", async () => {
    const first = deferred<Response>(); write = async input => bodies.length === 1 ? first.promise : commit(input);
    await render(); await edit("Current search"); await tick();
    const shortlisted = toggleDomainShortlist(domains.schema.parse(state.payload), "earlier.com");
    await act(async () => state.setPayload(shortlisted));
    expect(state.canEdit).toBe(true); expect(bodies).toHaveLength(1);
    await act(async () => first.resolve(commit(bodies[0]!)));
    expect(bodies).toHaveLength(2); expect(bodies[1]!.payload).toEqual(shortlisted); expect(state.dirty).toBe(false);
    expect(JSON.stringify(bodies)).not.toMatch(/amountMinor|checkedAt|provider/);
    await render("domains", false); memory = createStandaloneDraftMemory(); memory.bind(auth.session); await render();
    expect(state.payload).toEqual(shortlisted);
    await act(async () => state.setPayload(toggleDomainShortlist(domains.schema.parse(state.payload), "earlier.com"))); await tick();
    expect(domains.schema.parse(stored!.payload).shortlistedDomains).toBeUndefined();
  });

  it("keeps typing enabled and serializes newer input after an older acknowledgement", async () => {
    const first = deferred<Response>(), second = deferred<Response>();
    write = () => bodies.length === 1 ? first.promise : second.promise;
    await render(); await edit("First"); await tick();
    expect(state.canEdit).toBe(true); expect(state.saving).toBe(true);
    await edit("Newest"); await tick(5000); expect(bodies).toHaveLength(1);
    await act(async () => first.resolve(commit(bodies[0]!)));
    expect(bodies).toHaveLength(2); expect(bodies[1]!.expectedRevision).toBe(1);
    expect(bodies[1]!.payload).toEqual(payload("domains", "Newest")); expect(state.payload).toEqual(payload("domains", "Newest"));
    expect(state.dirty).toBe(true); expect(host.textContent).toContain("Saving…");
    await act(async () => second.resolve(commit(bodies[1]!)));
    expect(state.dirty).toBe(false); expect(state.workspace?.revision).toBe(2); expect(host.querySelector('[aria-label="Save status"]')?.textContent).toBe("Saved");
  });

  it("persists a revert made while the previous change was in flight", async () => {
    commit({ requestKey: workspaceId, expectedRevision: 0, payload: payload("domains", "Original"), imports: [] });
    const first = deferred<Response>(); write = async input => bodies.length === 1 ? first.promise : commit(input);
    await render(); await edit("Changed"); await tick(); await edit("Original");
    expect(state.pending).toBe(true); await act(async () => first.resolve(commit(bodies[0]!)));
    expect(bodies).toHaveLength(2); expect(bodies[1]!.payload).toEqual(payload("domains", "Original"));
    expect(state.workspace?.payload).toEqual(payload("domains", "Original")); expect(state.dirty).toBe(false);
  });

  it("replays the exact lost-acknowledgement request before saving newer edits", async () => {
    const first = deferred<Response>(); write = () => first.promise;
    await render(); await edit("Original request"); await tick(); await edit("Newest input");
    const original = structuredClone(bodies[0]!); commit(original);
    await act(async () => first.reject(new TypeError("Lost acknowledgement")));
    expect(current().pending).toEqual(original); expect(state.canEdit).toBe(true); expect(button("Retry")).toBeDefined();
    await edit("Newest retained input"); await tick(10_000); expect(bodies).toHaveLength(1);
    write = async input => commit(input);
    await act(async () => button("Retry").click());
    expect(bodies).toHaveLength(3); expect(bodies[1]).toEqual(original);
    expect(bodies[2]!.requestKey).not.toBe(original.requestKey); expect(bodies[2]!.expectedRevision).toBe(1);
    expect(bodies[2]!.payload).toEqual(payload("domains", "Newest retained input")); expect(host.querySelector('[aria-label="Save status"]')?.textContent).toBe("Saved");
  });

  it("retains 503 failures and does not retry automatically while editing", async () => {
    write = async () => Response.json({ error: "Unavailable" }, { status: 503 });
    await render(); await edit("First"); await tick(); const pending = structuredClone(current().pending);
    await edit("Still editable"); await tick(5000);
    expect(bodies).toHaveLength(1); expect(current().pending).toEqual(pending); expect(current().payload).toEqual(payload("domains", "Still editable"));
    expect(state.error).toContain("unavailable");
  });

  it("retains the newest branch on conflict and overwrites the saved branch only after an explicit choice", async () => {
    const first = deferred<Response>(); write = () => first.promise;
    await render(); await edit("First"); await tick(); await edit("My newest changes");
    commit({ requestKey: workspaceId, expectedRevision: 6, payload: payload("domains", "Other tab"), imports: [] });
    await act(async () => first.resolve(Response.json({ error: "Conflict" }, { status: 409 })));
    expect(state.conflict).toBe(true); expect(state.payload).toEqual(payload("domains", "My newest changes")); expect(current().pending).toBeNull();
    await tick(5000); expect(bodies).toHaveLength(1);
    write = async input => commit(input);
    await act(async () => button("Save my changes instead").click()); await tick();
    expect(bodies[1]!.expectedRevision).toBe(7); expect(bodies[1]!.payload).toEqual(payload("domains", "My newest changes"));
    expect(state.conflict).toBe(false); expect(host.querySelector('[aria-label="Save status"]')?.textContent).toBe("Saved");
  });

  it("requires confirmation to replace conflicted edits with the saved version", async () => {
    write = async () => Response.json({ error: "Conflict" }, { status: 409 });
    await render(); await edit("My changes"); await tick();
    commit({ requestKey: workspaceId, expectedRevision: 1, payload: payload("domains", "Other tab"), imports: [] });
    await act(async () => button("Use saved version").click()); expect(state.payload).toEqual(payload("domains", "My changes"));
    await act(async () => button("Keep editing").click()); expect(state.conflict).toBe(true);
    await act(async () => button("Use saved version").click()); await act(async () => button("Replace my changes").click());
    expect(state.payload).toEqual(payload("domains", "Other tab")); expect(state.conflict).toBe(false); expect(bodies).toHaveLength(1);
  });

  it("flushes on navigation and prevents another mounted editor from starting a concurrent writer", async () => {
    const first = deferred<Response>(); write = () => first.promise;
    await render(); await edit("Before navigation"); await render("domains", false);
    expect(bodies).toHaveLength(1); await render(); expect(state.canEdit).toBe(true);
    await edit("After navigation"); await tick(5000); expect(bodies).toHaveLength(1);
    write = async input => commit(input); await act(async () => first.resolve(commit(bodies[0]!)));
    expect(bodies).toHaveLength(2); expect(state.workspace?.payload).toEqual(payload("domains", "After navigation"));
  });

  it("fences late acknowledgements and queued writes when the verified account changes", async () => {
    const first = deferred<Response>(); write = () => first.promise;
    await render(); await edit("Private owner A"); await tick(); await edit("Private newer input");
    await act(async () => { auth.session = { status: "ready", userId: other, generation: 2 }; memory.bind(auth.session); });
    await render(); await act(async () => first.resolve(commit(bodies[0]!))); await tick();
    expect(state.payload).toEqual(emptyDomainDraft()); expect(state.workspace).toBeNull(); expect(bodies).toHaveLength(1);
    expect(memory.hasUnsaved()).toBe(false);
  });

  it("retains the original intent when cookies switch accounts before the tab rechecks its session", async () => {
    let cookieOwner = owner, mutations = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "GET") return Response.json({ ownerId: cookieOwner, workspace: null });
      expect(new Headers(init.headers).get("X-Embel-Account")).toBe(owner);
      if (new Headers(init.headers).get("X-Embel-Account") !== cookieOwner) return Response.json({ error: "Account changed" }, { status: 401 });
      mutations += 1; return commit(JSON.parse(String(init.body)));
    }));
    await render(); await edit("Owner A private input"); cookieOwner = other; await tick();
    expect(mutations).toBe(0); expect(auth.expire).toHaveBeenCalledWith(auth.session);
    expect(current().pending?.payload).toEqual(payload("domains", "Owner A private input"));
    expect(current().payload).toEqual(payload("domains", "Owner A private input"));
    expect(current().saveError).toContain("same account"); await tick(5000); expect(mutations).toBe(0);
  });

  it("recovers the exact pending intent for the same owner after a verification fence", async () => {
    const first = deferred<Response>(); write = () => first.promise;
    await render(); await edit("Pending private input"); await tick(); const original = structuredClone(bodies[0]!);
    await act(async () => { auth.session = { status: "checking", userId: owner, generation: 2 }; memory.bind(null); }); await render();
    expect(state.payload).toBeNull(); await act(async () => first.resolve(commit(original)));
    write = async input => commit(input);
    await act(async () => { auth.session = { status: "ready", userId: owner, generation: 3 }; memory.bind(auth.session); }); await render(); await tick();
    expect(bodies).toEqual([original, original]); expect(state.workspace?.payload).toEqual(payload("domains", "Pending private input"));
    expect(memory.hasUnsaved()).toBe(false);
  });

  it("reports a failed account read without fabricating an empty editable workspace", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Unavailable" }, { status: 503 })));
    await render(); expect(state.payload).toBeNull(); expect(state.canEdit).toBe(false); expect(state.status).toBe("error");
    expect(button("Retry")).toBeDefined(); await tick(5000); expect(bodies).toEqual([]);
  });

  it("offers Retry when refreshing a previously saved workspace fails", async () => {
    await render(); await edit("Saved content"); await tick(); await render("domains", false);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Unavailable" }, { status: 503 })));
    await render(); expect(state.payload).toEqual(payload("domains", "Saved content"));
    expect(state.error).toContain("unavailable"); expect(button("Retry")).toBeDefined();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ownerId: owner, workspace: stored })));
    await act(async () => button("Retry").click()); expect(state.error).toBeNull(); expect(state.dirty).toBe(false);
    expect(host.querySelector('[aria-label="Save status"]')?.textContent).toBe("Saved");
  });
});
