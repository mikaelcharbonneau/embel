// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { File as NodeFile } from "node:buffer";
import { contextSnapshotSchema } from "@/domain/projects";
import { accountProjectDraft, createAccountInput } from "@/components/workspace/project-draft-adapter";
import { createHomeInputSession, emptyHomeInputIntent, type HomeInputSession } from "@/features/home-inputs/home-input-session";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { NewProjectForm } from "@/components/workspace/project-editor";
import { forgetReceipt, readReceipt, rememberReceipt } from "@/components/workspace/account-project-start-recovery";
const mock = vi.hoisted(() => ({ session: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 } as VerifiedAccount | { status: "checking"; generation: number }, memory: null as HomeInputSession | null, create: vi.fn(), update: vi.fn(), get: vi.fn(), push: vi.fn(), strategy: vi.fn(), save: vi.fn(), current: vi.fn(), expire: vi.fn() }));
let accountDrafts: ReturnType<typeof createAccountDraftMemory>;
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.push }) }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ drafts: accountDrafts, session: mock.session, homeInputSession: mock.memory, isCurrent: mock.current, expire: mock.expire }) }));
vi.mock("@/components/workspace/account-strategy-start", () => ({ useAccountStrategyStart: (options?: { beforeSignIn?: () => boolean }) => ({ start: mock.strategy, save: mock.save, pending: false, notice: createElement("a", { href: "/sign-in", onClick: (event: { preventDefault: () => void }) => { if (options?.beforeSignIn && !options.beforeSignIn()) event.preventDefault(); } }, "Sign in fixture") }) }));
vi.mock("@/components/workspace/local-drafts", async importOriginal => ({ ...await importOriginal<typeof import("@/components/workspace/local-drafts")>(), useLocalDrafts: () => ({ loaded: true, drafts: [], storage: "available" }), createLocalDraft: mock.create, updateLocalDraft: mock.update, getLocalDraft: mock.get }));
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", fileId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const account: VerifiedAccount = { status: "ready", userId: owner, generation: 1 };
const draft = accountProjectDraft({ id: projectId, owner_id: owner, scope: "complete_brand", title: "Original fixture", current_revision: 1, created_at: "2026-10-07T00:00:00Z", context: contextSnapshotSchema.parse({ description: "Original typed brief" }) });
const file = new NodeFile(["brief"], "private-input.txt", { type: "text/plain" }) as unknown as File;
const ref = { id: fileId, ownerId: owner, projectId: null, projectRevision: null, blobVersionId: fileId, contentHash: "a".repeat(64), mimeType: "text/plain" as const, byteLength: 5, name: file.name, sourceReceiptId: fileId, state: "staged" as const };
let root: Root | null = null, host: HTMLDivElement;
async function render() { await act(async () => root!.render(createElement(NewProjectForm, { home: true, exampleId: "b2b" }))); }
async function click(label: string) { await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.includes(label))!.click()); }
beforeEach(() => {
  accountDrafts = createAccountDraftMemory();
 Object.defineProperty(navigator, "locks", { configurable: true, value: { request: (_name: string, _options: unknown, action: () => Promise<unknown>) => action() } });
 window.localStorage.clear(); window.sessionStorage.clear();
 Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); HTMLElement.prototype.scrollTo = vi.fn(); mock.session = account; mock.memory = createHomeInputSession(); mock.memory.bind(account);
 mock.current.mockReset().mockImplementation((value: VerifiedAccount) => mock.session.status === "ready" && mock.session.userId === value.userId && mock.session.generation === value.generation);
 mock.update.mockReset().mockReturnValue(true); mock.create.mockReset().mockReturnValue(projectId); mock.get.mockReset().mockImplementation((id: string) => id === projectId ? draft : undefined); mock.push.mockReset(); mock.strategy.mockReset().mockResolvedValue(false); mock.save.mockReset().mockResolvedValue(true);
 forgetReceipt({ ownerId: owner, draftId: projectId, projectId: null });
 host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.unstubAllGlobals(); });
function selectFiles() { mock.memory!.set(account, { ...emptyHomeInputIntent(), files: [{ localId: fileId, file, upload: { requestKey: fileId, name: file.name, mimeType: "text/plain", contentHash: ref.contentHash }, receipt: ref, outcome: "verified" }] }); }
const capability = () => Response.json({ ownerId: owner, policy: null, reason: "Synthetic unavailable storage; already staged fixture recovery is allowed." });
describe("mounted Home attached brief integration", () => {
 it.each([false, true])("keeps the original attached save live across a re-render and fences account changes (account changes=%s)", async changeAccount => {
  selectFiles();
  let finish!: () => void, saveSignal!: AbortSignal;
  const fetcher = vi.fn((path: string, options: RequestInit) => {
   if (path.endsWith("/capability")) return Promise.resolve(capability());
   expect(path).toBe("/api/home/projects"); expect(options.method).toBe("POST");
   saveSignal = options.signal as AbortSignal;
   const input = JSON.parse(String(options.body));
   const saved = { ownerId: owner, requestKey: input.requestKey, project: { ...input.project, id: projectId, owner_id: owner, current_revision: 1, created_at: "2026-10-07T00:00:00Z" }, attachments: [{ ...ref, projectId, projectRevision: 1, state: "linked" }] };
   return new Promise<Response>(resolve => { finish = () => resolve(Response.json(saved)); });
  });
  vi.stubGlobal("fetch", fetcher);
  await render(); await click("Save brief with files");
  expect(saveSignal).toBeDefined(); expect(saveSignal.aborted).toBe(false);
  const originalRequest = mock.memory!.get(account)!.saveIntent!;
  await render();
  expect(mock.session).toBe(account);
  expect(mock.memory!.get(account)!.saveIntent).toBe(originalRequest);
  expect(fetcher.mock.calls.filter(([path]) => path.endsWith("/capability"))).toHaveLength(1);
  expect(saveSignal.aborted).toBe(false);
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
  if (changeAccount) {
   await act(async () => { mock.session = { status: "checking", generation: 2 }; mock.memory!.bind(null); });
   await render();
   expect(saveSignal.aborted).toBe(true);
  }
  await act(async () => finish());
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
  expect(mock.create).toHaveBeenCalledTimes(1); expect(mock.strategy).not.toHaveBeenCalled();
  if (changeAccount) expect(mock.push).not.toHaveBeenCalled();
  else {
    expect(mock.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${projectId}?view=strategy`);
    expect(accountDrafts.get(projectId)?.saved.context.description).toBe(originalRequest.project.context.description);
  }
 });

 it("lost Home save response reuses the original browser draft and never starts Strategy", async () => {
  selectFiles(); let saved: unknown; const bodies: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, options: RequestInit) => {
   if (path.endsWith("/capability")) return capability();
   if (options.method === "POST") {
    bodies.push(String(options.body)); const input = JSON.parse(String(options.body));
    saved = { ownerId: owner, requestKey: input.requestKey, project: { ...input.project, id: projectId, owner_id: owner, current_revision: 1, created_at: "2026-10-07T00:00:00Z" }, attachments: [{ ...ref, projectId, projectRevision: 1, state: "linked" }] };
    throw new TypeError("Lost acknowledgement after atomic fixture commit");
   }
   return Response.json({ status: "committed", receipt: saved });
  }));
  await render(); expect(host.textContent).toContain("does not start AI processing"); await click("Save brief with files"); expect(host.textContent).toContain("could not be confirmed");
  expect(mock.create).toHaveBeenCalledTimes(1); expect(mock.strategy).not.toHaveBeenCalled(); expect(mock.push).not.toHaveBeenCalled();
  await click("Check and retry attached brief");
  expect(mock.create).toHaveBeenCalledTimes(1); expect(bodies).toHaveLength(1); expect(mock.strategy).not.toHaveBeenCalled(); expect(mock.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${projectId}`);
 });
 it("hidden pending files block text-only fallback during owner recheck", async () => {
  selectFiles(); const fetcher = vi.fn().mockImplementation(async () => capability()); vi.stubGlobal("fetch", fetcher);
  await render();
  await act(async () => { mock.session = { status: "checking", generation: 2 }; mock.memory!.bind(null); }); await render();
  expect(host.textContent).not.toContain(file.name); expect(host.textContent).toContain("Verify the same account");
  const send = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Send prompt"))!;
  expect(send.disabled).toBe(true); await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(mock.create).not.toHaveBeenCalled(); expect(mock.strategy).not.toHaveBeenCalled(); expect(mock.push).not.toHaveBeenCalled();
 });
 it("blocks text dispatch while a newly selected file is still being read and hashed", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ownerId: owner, policy: { allowedMimeTypes: ["text/plain"], maxFiles: 5, maxFileBytes: 10485760, maxTotalBytes: 26214400 }, reason: null })));
  await render();
  let release!: (value: ArrayBuffer) => void;
  const pendingFile = new NodeFile(["brief"], "selected.txt", { type: "text/plain" });
  Object.defineProperty(pendingFile, "arrayBuffer", { value: () => new Promise<ArrayBuffer>(resolve => { release = resolve; }) });
  const picker = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(picker, "files", { value: [pendingFile], configurable: true });
  await act(async () => {
   picker.dispatchEvent(new Event("change", { bubbles: true }));
   host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(mock.create).not.toHaveBeenCalled(); expect(mock.strategy).not.toHaveBeenCalled(); expect(mock.push).not.toHaveBeenCalled();
  expect([...host.querySelectorAll("button")].find(button => button.textContent?.includes("Send prompt"))!.disabled).toBe(true);
  await act(async () => {
   release(new TextEncoder().encode("brief").buffer);
   // WebCrypto completion is asynchronous; wait for the retained file, not a 10ms timing guess.
   await vi.waitFor(() => expect(mock.memory!.get(account)?.files[0]?.file.name).toBe("selected.txt"), { timeout: 5000 });
  });
  expect(mock.strategy).not.toHaveBeenCalled();
 });
 it("retains a text-only prompt when its account-start action cannot be confirmed", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => capability())); await render(); await click("Send prompt");
  expect(mock.create).not.toHaveBeenCalled(); expect(mock.strategy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ownerId: owner, description: expect.stringContaining("subscription tool") })); expect(mock.push).not.toHaveBeenCalled(); expect(host.querySelector("textarea")!.value).toContain("subscription tool");
 });
 it("retains an interrupted pre-hash selection guard through same-owner verification until explicit cancellation", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ownerId: owner, policy: { allowedMimeTypes: ["text/plain"], maxFiles: 5, maxFileBytes: 10485760, maxTotalBytes: 26214400 }, reason: null })));
  await render(); let finish!: (value: ArrayBuffer) => void;
  const selected = new NodeFile(["brief"], "before-refresh.txt", { type: "text/plain" });
  Object.defineProperty(selected, "arrayBuffer", { value: () => new Promise<ArrayBuffer>(resolve => { finish = resolve; }) });
  const picker = host.querySelector<HTMLInputElement>('input[type="file"]')!; Object.defineProperty(picker, "files", { value: [selected], configurable: true });
  await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));
  await act(async () => { mock.session = { status: "checking", generation: 2 }; mock.memory!.bind(null); }); await render();
  const recovered = { ...account, generation: 3 };
  await act(async () => { mock.session = recovered; mock.memory!.bind(recovered); }); await render();
  expect(mock.memory!.hasUnsaved()).toBe(true);
  expect([...host.querySelectorAll("button")].find(button => button.textContent?.includes("Send prompt"))!.disabled).toBe(true);
  expect(host.textContent).toContain("File selection was interrupted");
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(mock.create).not.toHaveBeenCalled(); expect(mock.strategy).not.toHaveBeenCalled();
  await click("Cancel pending file selection");
  await act(async () => { finish(new TextEncoder().encode("brief").buffer); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(mock.memory!.get(recovered)?.files ?? []).toHaveLength(0); expect(mock.memory!.hasUnsaved()).toBe(false);
  await click("Send prompt"); expect(mock.strategy).toHaveBeenCalledTimes(1);
 });
 it("a cancelled slow selection cannot append late or release a newer file selection", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ownerId: owner, policy: { allowedMimeTypes: ["text/plain"], maxFiles: 5, maxFileBytes: 10485760, maxTotalBytes: 26214400 }, reason: null })));
  await render(); let oldFinish!: (value: ArrayBuffer) => void, newFinish!: (value: ArrayBuffer) => void;
  const oldFile = new NodeFile(["old"], "cancelled.txt", { type: "text/plain" }), newFile = new NodeFile(["new"], "retained.txt", { type: "text/plain" });
  Object.defineProperty(oldFile, "arrayBuffer", { value: () => new Promise<ArrayBuffer>(resolve => { oldFinish = resolve; }) });
  Object.defineProperty(newFile, "arrayBuffer", { value: () => new Promise<ArrayBuffer>(resolve => { newFinish = resolve; }) });
  async function choose(selected: NodeFile) { const picker = host.querySelector<HTMLInputElement>('input[type="file"]')!; Object.defineProperty(picker, "files", { value: [selected], configurable: true }); await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true }))); }
  await choose(oldFile); await click("Cancel pending file selection"); await choose(newFile);
  await act(async () => { oldFinish(new TextEncoder().encode("old").buffer); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(mock.memory!.isSelecting()).toBe(true); expect(mock.memory!.get(account)?.files ?? []).toHaveLength(0);
  await act(async () => { newFinish(new TextEncoder().encode("new").buffer); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(mock.memory!.get(account)?.files.map(item => item.file.name)).toEqual(["retained.txt"]); expect(mock.memory!.isSelecting()).toBe(false);
  expect(mock.create).not.toHaveBeenCalled(); expect(mock.strategy).not.toHaveBeenCalled();
 });
 it("freezes prompt and examples while the original attached save is pending", async () => {
  mock.get.mockImplementation(() => ({ ...draft, description: String(mock.create.mock.calls.at(-1)![0].description) }));
  selectFiles(); let finish!: (response: Response) => void, saved: unknown;
  vi.stubGlobal("fetch", vi.fn(async (path: string, options: RequestInit) => {
   if (path.endsWith("/capability")) return capability();
   const input = JSON.parse(String(options.body)); saved = { ownerId: owner, requestKey: input.requestKey, project: { ...input.project, id: projectId, owner_id: owner, current_revision: 1, created_at: "2026-10-07T00:00:00Z" }, attachments: [{ ...ref, projectId, projectRevision: 1, state: "linked" }] };
   return new Promise<Response>(resolve => { finish = resolve; });
  }));
  await render(); const originalPrompt = host.querySelector("textarea")!.value; await click("Save brief with files");
  const textarea = host.querySelector("textarea")!;
  expect(textarea.readOnly || textarea.disabled).toBe(true);
  expect([...host.querySelectorAll<HTMLButtonElement>(".home-example-pills button")].every(button => button.disabled)).toBe(true);
  await act(async () => { host.querySelector<HTMLButtonElement>(".home-example-pills button:last-child")!.click(); });
  expect(textarea.value).toBe(originalPrompt);
  await act(async () => finish(Response.json(saved)));
  expect(mock.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${projectId}?view=strategy`); expect(mock.strategy).not.toHaveBeenCalled();
 });

 it("hides rejected filename errors immediately during checking and a different verified owner", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ownerId: mock.session.status === "ready" ? mock.session.userId : owner, policy: { allowedMimeTypes: ["text/plain"], maxFiles: 5, maxFileBytes: 10485760, maxTotalBytes: 26214400 }, reason: null })));
  await render(); const rejected = new NodeFile(["private"], "private-client-plan.svg", { type: "image/svg+xml" });
  const picker = host.querySelector<HTMLInputElement>('input[type="file"]')!; Object.defineProperty(picker, "files", { value: [rejected], configurable: true });
  await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true }))); expect(host.textContent).toContain(rejected.name);
  await act(async () => { mock.session = { status: "checking", generation: 2 }; mock.memory!.bind(null); }); await render();
  expect(host.textContent).not.toContain(rejected.name);
  const other = { ...account, userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", generation: 3 };
  await act(async () => { mock.session = other; mock.memory!.bind(other); }); await render(); expect(host.textContent).not.toContain(rejected.name);
 });

 it("remounted recovery displays the exact frozen prompt and example provenance", async () => {
  selectFiles(); mock.get.mockReturnValue({ ...draft, example: true });
  vi.stubGlobal("fetch", vi.fn(async (path: string) => { if (path.endsWith("/capability")) return capability(); throw new TypeError("Unconfirmed save fixture"); }));
  await render(); await click("Save brief with files"); expect(mock.memory!.get(account)?.saveIntent?.project.scope).toBe("complete_brand");
  await act(async () => root!.unmount()); root = createRoot(host);
  await act(async () => root!.render(createElement(NewProjectForm, { home: true })));
  expect(host.querySelector("textarea")!.value).toBe("Original typed brief");
  expect(host.textContent).toContain("Example prompt");
  expect(host.querySelector("textarea")!.readOnly).toBe(true); expect(mock.create).toHaveBeenCalledTimes(1);
 });

 it("reuses the pending account draft on retries and an explicit Save project", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => capability())); await render();
  await click("Send prompt"); await click("Send prompt");
  expect(mock.create).not.toHaveBeenCalled(); expect(mock.strategy).toHaveBeenCalledTimes(2); expect(mock.push).not.toHaveBeenCalled();
  const first = mock.strategy.mock.calls[0]![0]; expect(mock.strategy.mock.calls[1]![0]).toEqual(first);
  await click("Save project"); expect(mock.create).not.toHaveBeenCalled(); expect(mock.strategy).toHaveBeenCalledTimes(2);
  expect(mock.save).toHaveBeenCalledExactlyOnceWith(first); expect(mock.push).not.toHaveBeenCalled();
 });
 it("does not duplicate local drafts or AI starts on same-turn Send clicks", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => capability())); let finish!: (value: boolean) => void;
  mock.strategy.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; })); await render();
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  await act(async () => { submit.click(); submit.click(); });
  expect(mock.create).not.toHaveBeenCalled(); expect(mock.strategy).toHaveBeenCalledTimes(1);
  await act(async () => finish(false)); expect(mock.push).not.toHaveBeenCalled();
 });
 it("keeps Save project unavailable while attached files need recovery", async () => {
  selectFiles(); vi.stubGlobal("fetch", vi.fn(async () => capability())); await render();
  expect([...host.querySelectorAll("button")].find(button => button.textContent === "Save project")).toBeUndefined();
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent).toBe("Save brief with files");
 });

 it("does not turn a stale Save project click into attached-file transmission", async () => {
  const fetcher = vi.fn(async () => capability()); vi.stubGlobal("fetch", fetcher); await render();
  await click("Send prompt"); mock.create.mockClear(); mock.strategy.mockClear();
  const save = [...host.querySelectorAll("button")].find(button => button.textContent === "Save project")!;
  await act(async () => { selectFiles(); save.click(); });
  expect(mock.create).not.toHaveBeenCalled(); expect(mock.strategy).not.toHaveBeenCalled();
  expect(fetcher.mock.calls).toHaveLength(1); expect(mock.push).not.toHaveBeenCalled();
 });

 it("keeps the typed prompt before following the sign-in recovery link", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => capability())); await render();
  const link = host.querySelector<HTMLAnchorElement>('a[href="/sign-in"]')!;
  link.addEventListener("click", event => event.preventDefault());
  await act(async () => link.click());
  expect(mock.create).not.toHaveBeenCalled(); expect(JSON.parse(window.sessionStorage.getItem(`fluid.prompt-buffer.v1:${owner}`)!).input.context.description).toContain("subscription tool");
  expect(mock.strategy).not.toHaveBeenCalled();
 });

 it("saves the latest unlocked Home text before opening its retained draft", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => capability())); await render(); await click("Send prompt");
  await click("A neighborhood coffee shop");
  const latest = host.querySelector("textarea")!.value; expect(latest).toContain("neighborhood coffee shop");
  mock.update.mockClear(); await click("Save project");
  expect(mock.update).not.toHaveBeenCalled(); expect(mock.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ description: latest, id: mock.strategy.mock.calls[0]![0].id }));
  expect(mock.strategy).toHaveBeenCalledTimes(1); expect(mock.create).not.toHaveBeenCalled();
 });

 it.each(["ordinary", "historical"] as const)("does not bypass an uncertain %s save by adding files", async kind => {
  const retained = { ownerId: owner, draftId: projectId, projectId: null, ...(kind === "ordinary" ? { request: { key: projectId, input: createAccountInput(draft) } } : {}) };
  rememberReceipt(retained); selectFiles();
  const fetcher = vi.fn(async () => capability()); vi.stubGlobal("fetch", fetcher); await render();
  await click("Save brief with files");
  expect(host.textContent).toContain("another save to check");
  expect(fetcher.mock.calls).toHaveLength(1); expect(mock.push).not.toHaveBeenCalled();
  expect(readReceipt(owner, projectId)).toEqual(retained);
 });

 it("records the exact attached request fence while its project save is uncertain", async () => {
  selectFiles();
  vi.stubGlobal("fetch", vi.fn(async (path: string) => { if (path.endsWith("/capability")) return capability(); throw new TypeError("Lost attached create acknowledgement"); }));
  await render(); await click("Save brief with files");
  expect(readReceipt(owner, projectId)).toEqual({ ownerId: owner, draftId: projectId, projectId: null, attachedRequestKey: mock.memory!.get(account)!.saveIntent!.requestKey });
  expect(mock.strategy).not.toHaveBeenCalled();
 });

 it("does not upload or create an attached project when its durable guard cannot be saved", async () => {
  window.localStorage.setItem("fluid.local-drafts.v1", JSON.stringify({ version: 1, drafts: [draft] }));
  selectFiles(); const fetcher = vi.fn(async () => capability()); vi.stubGlobal("fetch", fetcher); await render();
  const originalSet = Storage.prototype.setItem;
  const blocked = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function(this: Storage, key: string, value: string) {
   if (key.startsWith("fluid.project-source.v1:")) throw new Error("Quota exceeded");
   return originalSet.call(this, key, value);
  });
  try {
   await click("Save brief with files");
   expect(fetcher.mock.calls).toHaveLength(1); expect(mock.push).not.toHaveBeenCalled();
   expect(host.textContent).toContain("No project request was sent");
   expect(mock.memory!.get(account)!.files).toHaveLength(1);
  } finally { blocked.mockRestore(); }
 });

});
