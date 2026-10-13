// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { AccountDomainsWorkspace } from "@/components/tools/domain-account-workspace";
import { HandlesAccountEditor } from "@/components/tools/handles-account-editor";
import { TrademarkAccountEditor } from "@/components/tools/trademark-account-editor";
import { domainDraftSchema } from "@/features/domain-workspace/draft";
import { createEntry, type HandlesState } from "@/features/handles-workspace/domain";
import { createTrademarkDraft } from "@/features/trademark-workspace/domain";
import { contextSnapshotSchema } from "@/domain/projects";
import { standaloneImportKey, type StandaloneImportSource, type StandaloneTool, type StandaloneWorkspace } from "@/domain/standalone-workspaces";
import type { StandalonePromotionInput, StandalonePromotionReceipt } from "@/domain/standalone-promotion";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
const uuid = (value: number) => `a0000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const owner = uuid(1), otherOwner = uuid(2), stamp = "2026-10-06T00:00:00Z";
const imports: StandaloneImportSource[] = [3, 4].map(value => ({ projectId: uuid(value), projectRevision: value, selectionId: null, candidateId: null, origin: "project_name", projectTitle: `Saved source ${value}`, name: "Cedar" }));
const payloads = {
  domains: domainDraftSchema.parse({ version: 1, input: "Cedar", extensions: ["com", "co"], candidates: ["cedar.com", "cedar.co"] }),
  handles: { version: 1, bundles: [{ id: "cedar-bundle", title: "Cedar bundle", list: "Saved candidates", source: { id: "manual-cedar", name: "Cedar", origin: "manual", projectId: null, projectTitle: null }, savedAt: stamp, entries: [createEntry("instagram", "cedar")] }] } satisfies HandlesState,
  trademarks: { ...createTrademarkDraft("Cedar"), goodsServices: "Handmade furniture", userNotes: "User research notes", owner: { name: "Private owner", address: "Private address", contact: "Private contact" } },
};
type Payload = typeof payloads[StandaloneTool];
function saved(tool: StandaloneTool, revision = 3): StandaloneWorkspace<Payload> {
  return { id: uuid(10), ownerId: owner, tool, revision, payload: structuredClone(payloads[tool]), imports: structuredClone(imports), createdAt: stamp, updatedAt: stamp };
}
function receipt(input: StandalonePromotionInput): StandalonePromotionReceipt {
  return { ownerId: owner, requestKey: input.requestKey, project: { id: uuid(20), owner_id: owner, title: input.title, scope: "complete_brand", current_revision: 1, context: contextSnapshotSchema.parse({ description: "Frozen saved context" }), created_at: stamp }, source: { id: uuid(21), ownerId: owner, workspaceId: input.workspaceId, workspaceRevision: input.expectedWorkspaceRevision, selection: input.selection, payloadHash: "a".repeat(64), contextSource: input.contextSource ? imports.find(source => standaloneImportKey(source) === standaloneImportKey(input.contextSource!))! : null, createdAt: stamp } };
}
const selectors = {
  domains: { tool: "domains" as const, domain: "cedar.com" },
  handles: { tool: "handles" as const, bundleId: "cedar-bundle" },
  trademarks: { tool: "trademarks" as const },
};
const selectionButtonText = { domains: "Create brand from cedar.com", handles: "Create brand from bundle", trademarks: "Create brand from draft" };
let root: Root | null = null, host: HTMLDivElement;
let session: ReturnType<typeof useAccountSession>;
let currentOwner = owner;
let posts: StandalonePromotionInput[];
let requests: string[];
let stored: StandaloneWorkspace<Payload> | null;
let onPost: (input: StandalonePromotionInput) => Promise<Response>;
let onLookup: (key: string) => Promise<Response>;

function Harness({ tool, mounted = true }: { tool: StandaloneTool; mounted?: boolean }) {
  const account = useAccountSession();
  useLayoutEffect(() => { session = account; });
  const props = { memory: account.standaloneDrafts };
  return mounted ? tool === "domains" ? createElement(AccountDomainsWorkspace, props) : tool === "handles" ? createElement(HandlesAccountEditor, props) : createElement(TrademarkAccountEditor, props) : null;
}
async function settle(assertion: () => void) {
  let lastError: unknown;
  for (let i = 0; i < 60; i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2)); });
    try { assertion(); return; } catch (error) { lastError = error; }
  }
  throw lastError;
}
async function render(tool: StandaloneTool, mounted = true) {
  await act(async () => root!.render(createElement(AccountSessionProvider, null, createElement(Harness, { tool, mounted }))));
}
async function mount(tool: StandaloneTool) {
  await render(tool);
  await settle(() => { expect(session.session.status).toBe("ready"); expect(session.standaloneDrafts.get(session.session as VerifiedAccount, tool)).not.toBeNull(); });
}
function button(label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.replace(/\s+/g, " ").trim() === label);
  expect(result, `Expected button: ${label}`).toBeDefined();
  return result!;
}
function field<T extends HTMLInputElement | HTMLSelectElement>(label: string): T {
  const item = [...host.querySelectorAll("label")].find(node => node.textContent?.trim() === label);
  expect(item, `Expected field: ${label}`).toBeDefined();
  return document.getElementById(item!.htmlFor) as T;
}
async function edit(label: string, value: string) {
  const input = field(label);
  const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
}
async function choose(tool: StandaloneTool) { if (tool === "trademarks") await act(async () => button("Fill").click()); if (tool === "handles") await act(async () => button("Library").click()); await act(async () => button(selectionButtonText[tool]).click()); }
async function titleAndContext(title = "Cedar complete brand") {
  await edit("New brand title", title);
  await edit("Saved context to carry forward", standaloneImportKey(imports[1]!));
}
function currentRecord(tool: StandaloneTool) { return session.standaloneDrafts.get(session.session as VerifiedAccount, tool)!; }
async function changeRecord(tool: StandaloneTool, patch: Partial<ReturnType<typeof currentRecord>>) {
  await act(async () => { session.standaloneDrafts.set(session.session as VerifiedAccount, tool, { ...currentRecord(tool), ...patch }); });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  navigation.push.mockClear(); currentOwner = owner; posts = []; requests = []; stored = null;
  onPost = async input => Response.json(receipt(input));
  onLookup = async () => Response.json({ status: "not_found" });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input); requests.push(path);
    if (path === "/api/session") return Response.json({ user: { id: currentOwner } });
    if (path === "/api/standalone-checks" && init?.method === "GET") return Response.json({ ownerId: currentOwner, domains: "unavailable", youtube: false, euipo: false });
    if (path === "/api/workspaces/promotions") { const body = JSON.parse(String(init?.body)) as StandalonePromotionInput; posts.push(body); return onPost(body); }
    if (path.startsWith("/api/workspaces/promotions/requests/")) return onLookup(path.split("/").at(-1)!);
    if (["/api/workspaces/domains", "/api/workspaces/handles", "/api/workspaces/trademarks"].includes(path) && init?.method === "GET") return Response.json({ ownerId: currentOwner, workspace: currentOwner === owner ? stored : null });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("saved standalone account editor promotion", () => {
  it.each(["domains", "handles", "trademarks"] as const)("%s selects saved work without a mutation, requires title/context and navigates only after its verified receipt", async tool => {
    stored = saved(tool);
    let finish!: (response: Response) => void;
    onPost = () => new Promise(resolve => { finish = resolve; });
    await mount(tool); await choose(tool);
    expect(host.querySelector('[aria-label="Create complete brand from saved work"]')).not.toBeNull();
    expect(posts).toEqual([]); expect(navigation.push).not.toHaveBeenCalled();
    expect(button("Create complete brand").disabled).toBe(true);
    await edit("New brand title", "Cedar complete brand");
    expect(button("Create complete brand").disabled).toBe(true);
    await edit("Saved context to carry forward", standaloneImportKey(imports[1]!));
    const submit = button("Create complete brand");
    await act(async () => { submit.click(); submit.click(); });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ requestKey: expect.any(String), workspaceId: uuid(10), expectedWorkspaceRevision: 3, selection: selectors[tool], contextSource: { projectId: imports[1]!.projectId, projectRevision: 4, selectionId: null }, title: "Cedar complete brand" });
    expect(JSON.stringify(posts[0])).not.toContain("Private owner");
    expect(navigation.push).not.toHaveBeenCalled();
    await act(async () => finish(Response.json(receipt(posts[0]!))));
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${uuid(20)}`);
    expect(currentRecord(tool).workspace).toEqual(stored); expect(currentRecord(tool).dirty).toBe(false);
    expect(session.lifecycleMemory.hasUnsaved()).toBe(false);
    await act(async () => button("Open created brand").click());
    expect(posts).toHaveLength(1); expect(navigation.push).toHaveBeenCalledTimes(1);
    expect(requests.every(path => ["/api/session", "/api/standalone-checks", `/api/workspaces/${tool}`, "/api/workspaces/promotions"].includes(path))).toBe(true);
  });

  it.each(["dirty", "pending", "conflict"] as const)("preserves a selected saved domain but gates promotion during account %s", async gate => {
    stored = saved("domains"); await mount("domains"); await choose("domains"); await titleAndContext();
    const patch = gate === "pending" ? { pending: { requestKey: uuid(30), expectedRevision: 3, payload: payloads.domains, imports: [] } } : { [gate]: true };
    await changeRecord("domains", patch);
    expect(button("Create complete brand").disabled).toBe(true);
    await act(async () => button("Create complete brand").click());
    expect(posts).toEqual([]); expect(navigation.push).not.toHaveBeenCalled();
  });

  it("requires an unsaved domain candidate to be saved before opening a promotion", async () => {
    stored = saved("domains"); await mount("domains");
    await changeRecord("domains", { dirty: true, payload: domainDraftSchema.parse({ version: 1, input: "New", extensions: ["com"], candidates: ["new.com"] }) });
    await act(async () => button("Create brand from new.com").click());
    expect(host.querySelector('[aria-label="Create complete brand from saved work"]')).toBeNull();
    expect(host.textContent).toContain("Save the account draft before creating a brand.");
    expect(posts).toEqual([]);
  });

  it("restores an uncertain original promotion after navigation and keeps its old revision when current saved candidates change", async () => {
    stored = saved("domains"); await mount("domains"); await choose("domains"); await titleAndContext("Original brand");
    onPost = async () => { throw new TypeError("Lost acknowledgement"); };
    await act(async () => button("Create complete brand").click());
    expect(posts).toHaveLength(1); const original = structuredClone(posts[0]!);
    await render("domains", false);
    const newer = { ...saved("domains", 4), payload: domainDraftSchema.parse({ version: 1, input: "Later", extensions: ["com"], candidates: ["later.com"] }) };
    await changeRecord("domains", { workspace: newer, payload: newer.payload });
    await render("domains");
    expect(field<HTMLInputElement>("New brand title").value).toBe("Original brand");
    onLookup = async key => { expect(key).toBe(original.requestKey); return Response.json({ status: "committed", receipt: receipt(original) }); };
    await act(async () => button("Check and retry original promotion").click());
    expect(posts).toEqual([original]);
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${uuid(20)}`);
    expect(currentRecord("domains").workspace?.revision).toBe(4);
  });

  it("does not reinterpret an unresolved domain promotion as a handle promotion", async () => {
    stored = saved("domains"); await mount("domains"); await choose("domains"); await titleAndContext();
    onPost = async () => { throw new TypeError("Lost acknowledgement"); };
    await act(async () => button("Create complete brand").click());
    const original = structuredClone(posts[0]!);
    stored = saved("handles"); await render("handles");
    await settle(() => expect(session.standaloneDrafts.get(session.session as VerifiedAccount, "handles")?.workspace?.tool).toBe("handles"));
    await choose("handles");
    expect(host.querySelector('[aria-label="Create complete brand from saved work"]')).toBeNull();
    expect(host.textContent).toContain("Check the original Domains promotion before creating another brand.");
    expect(host.querySelector('a[href="/domains"]')).not.toBeNull();
    expect(posts).toEqual([original]); expect(navigation.push).not.toHaveBeenCalled();
  });

  it("fences a delayed receipt on owner change and never opens the previous owner's new brand", async () => {
    stored = saved("trademarks"); await mount("trademarks"); await choose("trademarks"); await titleAndContext();
    let finish!: (response: Response) => void; onPost = () => new Promise(resolve => { finish = resolve; });
    await act(async () => button("Create complete brand").click());
    const original = structuredClone(posts[0]!);
    currentOwner = otherOwner; await act(async () => session.refresh());
    await settle(() => expect((session.session as VerifiedAccount).userId).toBe(otherOwner));
    await act(async () => finish(Response.json(receipt(original))));
    expect(navigation.push).not.toHaveBeenCalled(); expect(session.lifecycleMemory.hasUnsaved()).toBe(false);
    expect(host.textContent).not.toContain("Private owner");
  });

  it("does not leave newly unsaved edits when a valid promotion finishes", async () => {
    stored = saved("handles"); await mount("handles"); await choose("handles"); await titleAndContext();
    let finish!: (response: Response) => void; onPost = () => new Promise(resolve => { finish = resolve; });
    await act(async () => button("Create complete brand").click());
    await changeRecord("handles", { dirty: true });
    await act(async () => finish(Response.json(receipt(posts[0]!))));
    expect(navigation.push).not.toHaveBeenCalled(); expect(currentRecord("handles").dirty).toBe(true);
    expect(host.querySelector(`a[href="/brands/account/${uuid(20)}"]`)).not.toBeNull();
  });

  it("uses an explicit manual-context choice without sending imported context or draft contents", async () => {
    stored = saved("trademarks"); await mount("trademarks"); await choose("trademarks");
    await edit("New brand title", "Manual brand"); await edit("Saved context to carry forward", "none");
    await act(async () => button("Create complete brand").click());
    expect(posts[0]?.contextSource).toBeNull(); expect(posts[0]?.selection).toEqual({ tool: "trademarks" });
    expect(JSON.stringify(posts[0])).not.toContain("Private contact");
    expect(host.textContent).toContain("Trademark notes do not establish clearance.");
  });

  it("retains the original title and request through same-owner reverification and an exact not-found retry", async () => {
    stored = saved("handles"); await mount("handles"); await choose("handles"); await titleAndContext("Original handle brand");
    onPost = async () => { throw new TypeError("Lost acknowledgement"); };
    await act(async () => button("Create complete brand").click());
    const original = structuredClone(posts[0]!), generation = session.session.generation;
    await act(async () => session.refresh());
    await settle(() => { expect(session.session.status).toBe("ready"); expect(session.session.generation).toBeGreaterThan(generation); });
    expect(field<HTMLInputElement>("New brand title").value).toBe("Original handle brand");
    expect(field<HTMLInputElement>("New brand title").disabled).toBe(true);
    onLookup = async key => { expect(key).toBe(original.requestKey); return Response.json({ status: "not_found" }); };
    onPost = async input => Response.json(receipt(input));
    await act(async () => button("Check and retry original promotion").click());
    expect(posts).toEqual([original, original]); expect(navigation.push).toHaveBeenCalledOnce();
    expect(session.lifecycleMemory.hasUnsaved()).toBe(false);
  });

  it("requires a new saved choice if the revision changes before brand creation starts", async () => {
    stored = saved("domains"); await mount("domains"); await choose("domains"); await titleAndContext();
    const newer = saved("domains", 4);
    await changeRecord("domains", { workspace: newer, payload: newer.payload });
    expect(host.querySelector('[aria-label="Create complete brand from saved work"]')).toBeNull();
    expect(host.textContent).toContain("The saved account draft changed. Choose the saved result again before creating a brand.");
    expect(posts).toEqual([]);
    await choose("domains"); await titleAndContext("New saved source");
    await act(async () => button("Create complete brand").click());
    expect(posts[0]?.expectedWorkspaceRevision).toBe(4);
  });

  it("keeps a 409 promotion locked through a pending lookup rather than discarding or replacing it", async () => {
    stored = saved("domains"); await mount("domains"); await choose("domains"); await titleAndContext();
    onPost = async () => Response.json({ error: "Private server detail" }, { status: 409 });
    await act(async () => button("Create complete brand").click());
    const original = structuredClone(posts[0]!);
    await act(async () => button("Create brand from cedar.co").click());
    expect(field<HTMLInputElement>("New brand title").disabled).toBe(true);
    onLookup = async key => Response.json({ status: "pending", requestKey: key });
    await act(async () => button("Check and retry original promotion").click());
    expect(posts).toEqual([original]); expect(navigation.push).not.toHaveBeenCalled();
    expect(session.lifecycleMemory.get(session.session as VerifiedAccount, "standalone_promotion")?.input).toEqual(original);
    expect(session.lifecycleMemory.hasUnsaved()).toBe(true); expect(host.textContent).not.toContain("Private server detail");
  });

  it("rejects an unverified receipt without navigation or losing the original request", async () => {
    stored = saved("trademarks"); await mount("trademarks"); await choose("trademarks"); await titleAndContext();
    onPost = async input => Response.json({ ...receipt(input), source: { ...receipt(input).source, workspaceRevision: 2 } });
    await act(async () => button("Create complete brand").click());
    expect(navigation.push).not.toHaveBeenCalled(); expect(session.lifecycleMemory.hasUnsaved()).toBe(true);
    expect(session.lifecycleMemory.get(session.session as VerifiedAccount, "standalone_promotion")?.input).toEqual(posts[0]);
    expect(button("Check and retry original promotion")).toBeDefined();
  });
});
