// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOnDeviceVoiceAdapter } from "@/features/home-inputs/on-device-voice-adapter";
import type { OnDeviceSpeechEnvironment, OnDeviceSpeechRecognition, OnDeviceSpeechEventMap } from "@/features/home-inputs/voice-contract";
import { validateAttachmentSelection } from "@/features/home-inputs/attachment-draft";
import { PROPOSED_HOME_ATTACHMENT_POLICY } from "@/domain/attachments";
class NativeVoice implements OnDeviceSpeechRecognition {
 static last: NativeVoice; static available = vi.fn(async () => "available" as const); static install = vi.fn();
 processLocally = false; lang = ""; interimResults = false; continuous = true;
 listeners = new Map<string, Set<(event: never) => void>>(); start = vi.fn(); stop = vi.fn(); abort = vi.fn();
 constructor() { NativeVoice.last = this; }
 addEventListener<K extends keyof OnDeviceSpeechEventMap>(type: K, listener: (event: OnDeviceSpeechEventMap[K]) => void) { const group = this.listeners.get(type) ?? new Set(); group.add(listener as (event: never) => void); this.listeners.set(type, group); }
 removeEventListener<K extends keyof OnDeviceSpeechEventMap>(type: K, listener: (event: OnDeviceSpeechEventMap[K]) => void) { this.listeners.get(type)?.delete(listener as (event: never) => void); }
 emit<K extends keyof OnDeviceSpeechEventMap>(type: K, event: OnDeviceSpeechEventMap[K]) { this.listeners.get(type)?.forEach(listener => listener(event as never)); }
}
const env = () => ({ isSecureContext: true, SpeechRecognition: NativeVoice }) as OnDeviceSpeechEnvironment;
const file = (size: number, type = "text/plain", name = "notes.txt") => ({ size, type, name } as File);
describe("explicit on-device voice", () => {
 afterEach(() => { vi.useRealTimers(); NativeVoice.available.mockReset().mockResolvedValue("available"); NativeVoice.install.mockClear(); });
 it("on-device voice refuses downloadable packs and never invokes install or cloud fallback", async () => {
  const adapter = createOnDeviceVoiceAdapter(env()); NativeVoice.available.mockResolvedValueOnce("downloadable" as never);
  expect((await adapter.availability("en-US", new AbortController().signal)).status).toBe("unavailable");
  expect(NativeVoice.install).not.toHaveBeenCalled(); expect(NativeVoice.last.start).not.toHaveBeenCalled();
  expect((await createOnDeviceVoiceAdapter({ isSecureContext: false }).availability("en", new AbortController().signal)).status).toBe("unavailable");
 });
 it("on-device voice waits for start and end events and deduplicates result indexes", async () => {
  const adapter = createOnDeviceVoiceAdapter(env()), transcript = vi.fn(), ended = vi.fn(), errors = vi.fn();
  let ready = false;
  const starting = adapter.start({ language: "fr-FR", signal: new AbortController().signal, onTranscript: transcript, onError: errors, onEnd: ended }).then(handle => { ready = true; return handle; });
  await vi.waitFor(() => expect(NativeVoice.last.start).toHaveBeenCalledOnce());
  expect(ready).toBe(false); expect(NativeVoice.last).toMatchObject({ processLocally: true, lang: "fr-FR", continuous: false, interimResults: true });
  NativeVoice.last.emit("start", new Event("start")); const handle = await starting;
  NativeVoice.last.emit("result", { resultIndex: 0, results: [{ isFinal: false, 0: { transcript: "Bonjour" } }] });
  NativeVoice.last.emit("result", { resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "Bonjour monde" } }] });
  expect(transcript.mock.calls.at(-1)?.[0]).toEqual({ text: "Bonjour monde", final: true });
  let stopped = false; const stopping = handle.stop().then(() => { stopped = true; }); await Promise.resolve(); expect(stopped).toBe(false);
  NativeVoice.last.emit("end", new Event("end")); await stopping; expect(ended).toHaveBeenCalledOnce(); expect(errors).not.toHaveBeenCalled();
 });
 it("on-device voice aborts hung permission and stop without applying late text", async () => {
  vi.useFakeTimers(); const transcript = vi.fn(), errors = vi.fn(), adapter = createOnDeviceVoiceAdapter(env());
  const starting = adapter.start({ language: "en", signal: new AbortController().signal, onTranscript: transcript, onError: errors, onEnd: vi.fn() });
  const failed = expect(starting).rejects.toThrow(); await vi.advanceTimersByTimeAsync(15_001); await failed;
  expect(errors).toHaveBeenCalledWith("start_timeout"); expect(NativeVoice.last.abort).toHaveBeenCalledOnce();
  NativeVoice.last.emit("result", { resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "Late private text" } }] }); expect(transcript).not.toHaveBeenCalled();
 });
});
describe("bounded attachment preflight", () => {
 it("attachment bounds use exact bytes and preserve rejected selections", () => {
  const policy = PROPOSED_HOME_ATTACHMENT_POLICY;
  expect(validateAttachmentSelection([file(10_485_760), file(10_485_761), file(0), file(1, "image/svg+xml")], [], policy)).toMatchObject({ accepted: [file(10_485_760)], errors: [{ code: "file_bytes" }, { code: "file_bytes" }, { code: "mime" }] });
  expect(validateAttachmentSelection(Array.from({ length: 6 }, () => file(1)), [], policy).accepted).toHaveLength(5);
  expect(validateAttachmentSelection([file(10_485_760), file(10_485_760), file(5_242_880), file(1)], [], policy).errors).toMatchObject([{ code: "total_bytes" }]);
  // MIME/filename checks are preflight only. Actual decoder rejection is a server obligation.
  expect(validateAttachmentSelection([file(25, "image/png", "html-disguised.png")], [], policy).accepted).toHaveLength(1);
 });
});

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HomeVoiceControl, appendReviewedTranscript } from "@/features/home-inputs/home-voice-control";
import type { HomeVoiceAdapter } from "@/features/home-inputs/voice-contract";
async function voiceFixture() {
 vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
 const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
 let callbacks: Parameters<HomeVoiceAdapter["start"]>[0] | null = null;
 const start = vi.fn(async (input: Parameters<HomeVoiceAdapter["start"]>[0]) => { callbacks = input; return { stop: vi.fn(async () => callbacks?.onEnd()) }; });
 const adapter: HomeVoiceAdapter = { availability: async language => ({ status: "available", language, transportId: "synthetic-local-fixture", disclosure: "Local fixture" }), start };
 const change = vi.fn(), submit = vi.fn();
 async function render(value = "Existing typed brief", sessionFence = "owner:1") { await act(async () => root.render(createElement("form", { onSubmit: submit }, createElement(HomeVoiceControl, { value, onChange: change, language: "en-US", sessionFence, adapter, disabled: false })))); await act(async () => { await vi.advanceTimersByTimeAsync(1); }); }
 await render();
 const click = async (text: string) => { const button = [...host.querySelectorAll("button")].find(button => button.textContent === text); if (!button) throw new Error(`Missing ${text}`); await act(async () => button.click()); };
 return { host, root, start, change, submit, render, click, callbacks: () => callbacks! };
}
describe("mounted Home voice preserves explicit intent", () => {
 let root: Root | null = null;
 afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.useRealTimers(); });
 it("voice denial and stale events preserve the typed prompt", async () => {
  const f = await voiceFixture(); root = f.root;
  expect(f.start).not.toHaveBeenCalled();
  const button = [...f.host.querySelectorAll("button")].find(button => button.textContent === "Start voice input")!;
  await act(async () => { button.click(); button.click(); }); expect(f.start).toHaveBeenCalledTimes(1);
  const old = f.callbacks(); await act(async () => old.onError("permission_denied")); expect(f.change).not.toHaveBeenCalled();
  await f.render("Newer manual edit"); await act(async () => { old.onTranscript({ text: "Late private voice", final: true }); old.onEnd(); });
  expect(f.host.textContent).not.toContain("Late private voice"); expect(f.change).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
 });
 it("using a transcript never sends the conversation and appends to the latest typed text", async () => {
  const f = await voiceFixture(); root = f.root;
  await f.click("Start voice input"); await act(async () => f.callbacks().onTranscript({ text: "Reviewed transcript", final: false }));
  expect(f.change).not.toHaveBeenCalled(); await f.render("Newer manual edit");
  await act(async () => f.callbacks().onEnd()); await f.click("Use transcript");
  expect(f.change).toHaveBeenCalledExactlyOnceWith("Newer manual edit\nReviewed transcript"); expect(f.submit).not.toHaveBeenCalled();
 });
 it("owner generation change cancels capture and late events cannot expose the prior transcript", async () => {
  const f = await voiceFixture(); root = f.root; await f.click("Start voice input"); const old = f.callbacks();
  await f.render("Another owner prompt", "owner:2"); expect(old.signal.aborted).toBe(true);
  await act(async () => { old.onTranscript({ text: "Hidden old phrase", final: true }); old.onEnd(); });
  expect(f.host.textContent).not.toContain("Hidden old phrase"); expect(f.change).not.toHaveBeenCalled();
 });
 it("cancel returns keyboard focus to Start after the listening controls close", async () => {
  const f = await voiceFixture(); root = f.root; await f.click("Start voice input");
  const cancel = [...f.host.querySelectorAll("button")].find(button => button.textContent === "Cancel voice input")!;
  cancel.focus(); await act(async () => cancel.click());
  expect(document.activeElement?.textContent).toBe("Start voice input"); expect(f.change).not.toHaveBeenCalled();
 });
 it("refuses transcript overflow without truncating either input", () => {
  expect(appendReviewedTranscript("a".repeat(11999), "b")).toBeNull();
  expect(appendReviewedTranscript("", " exact phrase ")).toBe("exact phrase");
 });
});

import { File as NodeFile } from "node:buffer";
import { createHomeInputSession, saveAttachedHomeDraft, emptyHomeInputIntent } from "@/features/home-inputs/home-input-session";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { contextSnapshotSchema } from "@/domain/projects";
import { AccountRequestError } from "@/components/workspace/account-api";
import type { AccountLifecycleClient } from "@/components/workspace/account-lifecycle-client";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import type { OwnedAttachmentRef } from "@/domain/attachments";
const homeOwner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", homeProject = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const homeId = (n: number) => `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, "0")}`;
const homeAccount: VerifiedAccount = { status: "ready", userId: homeOwner, generation: 1 };
function pendingFile(n: number) {
 const file = new NodeFile(["brief"], `${n}.txt`, { type: "text/plain" }) as unknown as File;
 return { localId: homeId(n), file, upload: { requestKey: homeId(n), name: file.name, mimeType: "text/plain" as const, contentHash: "a".repeat(64) }, receipt: null, outcome: "local" as const };
}
function uploaded(n: number): OwnedAttachmentRef { return { id: homeId(n), ownerId: homeOwner, projectId: null, projectRevision: null, blobVersionId: homeId(n), contentHash: "a".repeat(64), mimeType: "text/plain", byteLength: 5, name: `${n}.txt`, sourceReceiptId: homeId(n), state: "staged" }; }
const homeDraft = () => accountProjectDraft({ id: homeProject, owner_id: homeOwner, title: "Retained brief", scope: "complete_brand", current_revision: 1, context: contextSnapshotSchema.parse({ description: "Typed brief retained" }), created_at: "2026-10-07T00:00:00Z" });
describe("attached Home intent orchestration with synthetic unavailable production storage", () => {
 it("pending file-selection markers stay private and clear on verified different owner or confirmed logout", () => {
  const memory = createHomeInputSession(); memory.bind(homeAccount);
  const reader = memory.beginSelection(homeAccount, 2)!; const selected = memory.getSelection(homeAccount)!;
  memory.bind(null); expect(memory.hasUnsaved()).toBe(true); expect(memory.getSelection(homeAccount)).toBeNull(); expect(reader.current()).toBe(false);
  const recovered = { ...homeAccount, generation: 3 }; memory.bind(recovered);
  expect(memory.getSelection(recovered)).toEqual({ ...selected, status: "interrupted" }); expect(memory.cancelSelection(homeAccount, selected.id)).toBe(false);
  const foreign = { ...recovered, userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }; memory.bind(foreign);
  expect(memory.getSelection(foreign)).toBeNull(); expect(memory.hasUnsaved()).toBe(false);
  const fresh = memory.beginSelection(foreign, 1)!; reader.complete(); reader.interrupt(); expect(fresh.current()).toBe(true);
  memory.clear(); expect(memory.hasUnsaved()).toBe(false); expect(fresh.current()).toBe(false);
 });

 it("a fenced hung upload cannot hold the next verified generation admission", () => {
  const memory = createHomeInputSession(); memory.bind(homeAccount);
  const releaseOld = memory.acquire(homeAccount); expect(releaseOld).not.toBeNull();
  memory.bind(null); const next = { ...homeAccount, generation: 2 }; memory.bind(next);
  const releaseNew = memory.acquire(next); expect(releaseNew).not.toBeNull();
  releaseOld!(); expect(memory.acquire(next)).toBeNull(); releaseNew!();
  expect(memory.acquire(next)).not.toBeNull();
 });

 it("one failed attachment does not lose the brief or verified files", async () => {
  const memory = createHomeInputSession(); memory.bind(homeAccount); memory.set(homeAccount, { ...emptyHomeInputIntent(), files: [pendingFile(1), pendingFile(2), pendingFile(3)] });
  const stage = vi.fn().mockResolvedValueOnce(uploaded(1)).mockResolvedValueOnce(uploaded(2)).mockRejectedValueOnce(new AccountRequestError(422));
  const save = vi.fn(), client = { stageHomeAttachment: stage, saveAttachedProjectDraft: save } as unknown as AccountLifecycleClient;
  const draft = homeDraft(); await expect(saveAttachedHomeDraft({ account: homeAccount, draft, memory, client, signal: new AbortController().signal })).rejects.toMatchObject({ status: 422 });
  expect(memory.get(homeAccount)?.files.map(file => file.outcome)).toEqual(["verified", "verified", "failed"]);
  expect(memory.get(homeAccount)?.saveIntent?.project.context.description).toBe("Typed brief retained"); expect(draft.description).toBe("Typed brief retained"); expect(save).not.toHaveBeenCalled();
 });
 it("lost Home save response cannot create a second project and never submits Strategy", async () => {
  const memory = createHomeInputSession(); memory.bind(homeAccount); memory.set(homeAccount, { ...emptyHomeInputIntent(), files: [pendingFile(1)] });
  let committed: unknown;
  const stage = vi.fn().mockResolvedValue(uploaded(1)), save = vi.fn(async (input: Parameters<AccountLifecycleClient["saveAttachedProjectDraft"]>[0]) => {
   committed = { ownerId: homeOwner, requestKey: input.requestKey, project: { ...input.project, id: homeProject, owner_id: homeOwner, current_revision: 1, created_at: "2026-10-07T00:00:00Z" }, attachments: [{ ...uploaded(1), projectId: homeProject, projectRevision: 1, state: "linked" }] };
   throw new TypeError("Lost save response");
  });
  const read = vi.fn(async () => ({ status: "committed", receipt: committed })), client = { stageHomeAttachment: stage, saveAttachedProjectDraft: save, readAttachedProjectDraftRequest: read } as unknown as AccountLifecycleClient;
  const args = { account: homeAccount, draft: homeDraft(), memory, client, signal: new AbortController().signal };
  await expect(saveAttachedHomeDraft(args)).rejects.toThrow();
  expect(memory.get(homeAccount)?.saveOutcome).toBe("uncertain"); const original = memory.get(homeAccount)?.saveIntent;
  const result = await saveAttachedHomeDraft({ ...args, draft: { ...args.draft, description: "A later local edit" } });
  expect(result).toEqual(committed); expect(memory.get(homeAccount)?.saveIntent).toEqual(original); expect(stage).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledTimes(1); expect(memory.hasUnsaved()).toBe(false);
 });
 it("owner change fences uploaded files and pending Home intent", async () => {
  const memory = createHomeInputSession(); memory.bind(homeAccount); memory.set(homeAccount, { ...emptyHomeInputIntent(), files: [pendingFile(1)] });
  let resolve!: (value: OwnedAttachmentRef) => void;
  const stage = vi.fn(() => new Promise<OwnedAttachmentRef>(done => { resolve = done; })), save = vi.fn();
  const client = { stageHomeAttachment: stage, saveAttachedProjectDraft: save } as unknown as AccountLifecycleClient;
  const operation = saveAttachedHomeDraft({ account: homeAccount, draft: homeDraft(), memory, client, signal: new AbortController().signal });
  await vi.waitFor(() => expect(stage).toHaveBeenCalledTimes(1)); memory.bind(null); resolve(uploaded(1)); expect(await operation).toBeNull();
  expect(memory.get(homeAccount)).toBeNull(); expect(save).not.toHaveBeenCalled();
  const next = { ...homeAccount, generation: 3 }; memory.bind(next); expect(memory.get(next)?.files[0]?.outcome).toBe("pending");
  memory.bind({ ...next, userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }); expect(memory.hasUnsaved()).toBe(false);
 });
});

import { createHash, webcrypto } from "node:crypto";
import { createAccountLifecycleClient } from "@/components/workspace/account-lifecycle-client";
describe("bounded raw Home upload transport", () => {
 afterEach(() => vi.unstubAllGlobals());
 it("freezes original bytes, verifies hash and sends URL-encoded Unicode metadata separately", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const bytes = new Uint8Array([104, 105]), hash = createHash("sha256").update(bytes).digest("hex"), name = "café 中文.txt";
  const input = { requestKey: homeId(1), name, mimeType: "text/plain" as const, contentHash: hash };
  const ref = { ...uploaded(1), name, contentHash: hash, byteLength: 2 };
  const fetcher = vi.fn().mockResolvedValue(Response.json({ requestKey: input.requestKey, attachment: ref })); vi.stubGlobal("fetch", fetcher);
  const client = createAccountLifecycleClient(homeAccount, () => true, vi.fn()); const operation = client.stageHomeAttachment(input, bytes); bytes[0] = 0;
  expect(await operation).toEqual(ref);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/home/attachments", expect.objectContaining({ method: "POST", credentials: "same-origin", headers: expect.objectContaining({ "Content-Type": "text/plain", "X-Embel-Account": homeAccount.userId, "X-Fluid-Attachment-Name": encodeURIComponent(name), "X-Fluid-Content-Hash": hash }) }));
  expect([...new Uint8Array(fetcher.mock.calls[0]![1].body)]).toEqual([104, 105]);
 });
 it("binds an attached project creation to the captured account", async () => {
  const project = { title: "Retained brief", scope: "complete_brand" as const, context: contextSnapshotSchema.parse({ description: "Typed brief" }) };
  const input = { requestKey: homeId(2), project, attachmentIds: [homeId(1)] };
  const receipt = { ownerId: homeOwner, requestKey: input.requestKey, project: { ...project, id: homeProject, owner_id: homeOwner, current_revision: 1, created_at: "2026-10-07T00:00:00Z" }, attachments: [{ ...uploaded(1), projectId: homeProject, projectRevision: 1, state: "linked" }] };
  const fetcher = vi.fn().mockResolvedValue(Response.json(receipt)); vi.stubGlobal("fetch", fetcher);
  const client = createAccountLifecycleClient(homeAccount, () => true, vi.fn());
  expect(await client.saveAttachedProjectDraft(input)).toEqual(receipt);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/home/projects", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "X-Embel-Account": homeAccount.userId }), body: JSON.stringify(input) }));
 });
 it.each(["upload", "project"])("expires the captured account on a cookie-switch rejection of %s without retrying", async kind => {
  vi.stubGlobal("crypto", webcrypto);
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 401 })), expire = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const client = createAccountLifecycleClient(homeAccount, () => true, expire);
  const bytes = new Uint8Array([104, 105]), hash = createHash("sha256").update(bytes).digest("hex");
  const result = kind === "upload"
   ? await client.stageHomeAttachment({ requestKey: homeId(1), name: "1.txt", mimeType: "text/plain", contentHash: hash }, bytes)
   : await client.saveAttachedProjectDraft({ requestKey: homeId(2), project: { title: "Private draft", scope: "complete_brand", context: contextSnapshotSchema.parse({ description: "Typed brief" }) }, attachmentIds: [] });
  expect(result).toBeNull(); expect(expire).toHaveBeenCalledExactlyOnceWith(homeAccount); expect(fetcher).toHaveBeenCalledTimes(1);
  expect(new Headers(fetcher.mock.calls[0]![1].headers).get("X-Embel-Account")).toBe(homeOwner);
 });
 it("refuses changed bytes before network and mismatched upload acknowledgements", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const bytes = new Uint8Array([104, 105]), hash = createHash("sha256").update(bytes).digest("hex"), input = { requestKey: homeId(1), name: "1.txt", mimeType: "text/plain" as const, contentHash: hash };
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); const client = createAccountLifecycleClient(homeAccount, () => true, vi.fn());
  await expect(client.stageHomeAttachment(input, new Uint8Array([0]))).rejects.toMatchObject({ status: 422 }); expect(fetcher).not.toHaveBeenCalled();
  for (const result of [ { requestKey: homeId(2), attachment: { ...uploaded(1), byteLength: 2, contentHash: hash } }, { requestKey: homeId(1), attachment: { ...uploaded(1), byteLength: 3, contentHash: hash } } ]) {
   fetcher.mockResolvedValueOnce(Response.json(result)); await expect(client.stageHomeAttachment(input, bytes)).rejects.toMatchObject({ status: 502 });
  }
 });
});
