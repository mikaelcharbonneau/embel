// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserVoiceAdapter } from "@/features/home-inputs/browser-voice-adapter";
import type {
  BrowserSpeechEnvironment,
  BrowserSpeechRecognition,
  BrowserSpeechEventMap,
} from "@/features/home-inputs/voice-contract";
import { validateAttachmentSelection } from "@/features/home-inputs/attachment-draft";
import { PROPOSED_HOME_ATTACHMENT_POLICY } from "@/domain/attachments";
class NativeVoice implements BrowserSpeechRecognition {
  static last: NativeVoice;
  static available = vi.fn(async () => "available" as const);
  static install = vi.fn();
  processLocally = false;
  lang = "";
  interimResults = false;
  continuous = true;
  listeners = new Map<string, Set<(event: never) => void>>();
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() {
    NativeVoice.last = this;
  }
  addEventListener<K extends keyof BrowserSpeechEventMap>(
    type: K,
    listener: (event: BrowserSpeechEventMap[K]) => void,
  ) {
    const group = this.listeners.get(type) ?? new Set();
    group.add(listener as (event: never) => void);
    this.listeners.set(type, group);
  }
  removeEventListener<K extends keyof BrowserSpeechEventMap>(
    type: K,
    listener: (event: BrowserSpeechEventMap[K]) => void,
  ) {
    this.listeners.get(type)?.delete(listener as (event: never) => void);
  }
  emit<K extends keyof BrowserSpeechEventMap>(type: K, event: BrowserSpeechEventMap[K]) {
    this.listeners.get(type)?.forEach((listener) => listener(event as never));
  }
}
const env = () => ({ isSecureContext: true, SpeechRecognition: NativeVoice }) as BrowserSpeechEnvironment;
const file = (size: number, type = "text/plain", name = "notes.txt") => ({ size, type, name }) as File;
/** A browser without the on-device probe: Safari, and Chromium before it shipped. */
class PrefixedVoice extends NativeVoice {
  static override available = undefined as never;
}
const signal = () => new AbortController().signal;
describe("dictation through the browser's speech recognition", () => {
  afterEach(() => {
    vi.useRealTimers();
    NativeVoice.available.mockReset().mockResolvedValue("available");
    NativeVoice.install.mockClear();
  });
  it("is unavailable only where the browser has no speech recognition or the page is not secure", async () => {
    expect((await createBrowserVoiceAdapter({ isSecureContext: true }).availability("en", signal())).status).toBe(
      "unavailable",
    );
    expect(
      (await createBrowserVoiceAdapter({ ...env(), isSecureContext: false }).availability("en", signal())).status,
    ).toBe("unavailable");
  });
  it("touches nothing of the browser's speech system before the person presses the button", async () => {
    const constructed = vi.fn();
    class Watched extends NativeVoice {
      constructor() {
        super();
        constructed();
      }
    }
    const adapter = createBrowserVoiceAdapter({ isSecureContext: true, SpeechRecognition: Watched });
    expect(await adapter.availability("en-US", signal())).toEqual({ status: "available", language: "en-US" });
    // Asking about on-device speech at page load crashed the headless Chromium CI uses.
    expect(NativeVoice.available).not.toHaveBeenCalled();
    expect(constructed).not.toHaveBeenCalled();
  });
  const begin = async (adapter: ReturnType<typeof createBrowserVoiceAdapter>, language = "en-US") => {
    const starting = adapter.start({
      language,
      signal: signal(),
      onTranscript: vi.fn(),
      onError: vi.fn(),
      onEnd: vi.fn(),
    });
    await vi.waitFor(() => expect(NativeVoice.last.start).toHaveBeenCalledOnce());
    NativeVoice.last.emit("start", new Event("start"));
    return starting;
  };
  it("uses the device when the browser can, and says so", async () => {
    const handle = await begin(createBrowserVoiceAdapter(env()));
    expect(NativeVoice.last.processLocally).toBe(true);
    expect(handle.disclosure).toMatch(/on this device/u);
  });
  it("falls back to the browser's speech service, says so, and never installs a language pack", async () => {
    NativeVoice.available.mockResolvedValue("downloadable" as never);
    const handle = await begin(createBrowserVoiceAdapter(env()));
    // Nothing claims on-device processing that the browser did not confirm.
    expect(NativeVoice.last.processLocally).toBe(false);
    expect(handle.disclosure).toMatch(/speech service/u);
    expect(NativeVoice.install).not.toHaveBeenCalled();
  });
  it("works with the prefixed recognition of Safari and older Chromium", async () => {
    const adapter = createBrowserVoiceAdapter({ isSecureContext: true, webkitSpeechRecognition: PrefixedVoice });
    expect(await adapter.availability("fr-CA", signal())).toEqual({ status: "available", language: "fr-CA" });
    const handle = await begin(adapter, "fr-CA");
    expect(NativeVoice.last.lang).toBe("fr-CA");
    expect(handle.disclosure).toMatch(/speech service/u);
  });
  it("keeps listening across pauses, waits for start and end, and separates settled words from guesses", async () => {
    const adapter = createBrowserVoiceAdapter(env()),
      transcript = vi.fn(),
      ended = vi.fn(),
      errors = vi.fn();
    let ready = false;
    const starting = adapter
      .start({
        language: "fr-FR",
        signal: signal(),
        onTranscript: transcript,
        onError: errors,
        onEnd: ended,
      })
      .then((handle) => {
        ready = true;
        return handle;
      });
    await vi.waitFor(() => expect(NativeVoice.last.start).toHaveBeenCalledOnce());
    expect(ready).toBe(false);
    expect(NativeVoice.last).toMatchObject({
      processLocally: true,
      lang: "fr-FR",
      continuous: true,
      interimResults: true,
    });
    NativeVoice.last.emit("start", new Event("start"));
    const handle = await starting;
    NativeVoice.last.emit("result", { resultIndex: 0, results: [{ isFinal: false, 0: { transcript: "Bonjour" } }] });
    expect(transcript.mock.calls.at(-1)?.[0]).toEqual({ finalText: "", interimText: "Bonjour" });
    NativeVoice.last.emit("result", {
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: "Bonjour monde" } }],
    });
    expect(transcript.mock.calls.at(-1)?.[0]).toEqual({ finalText: "Bonjour monde", interimText: "" });
    NativeVoice.last.emit("result", {
      resultIndex: 1,
      results: [
        { isFinal: true, 0: { transcript: "Bonjour monde" } },
        { isFinal: false, 0: { transcript: " et merci" } },
      ],
    });
    expect(transcript.mock.calls.at(-1)?.[0]).toEqual({ finalText: "Bonjour monde", interimText: "et merci" });
    let stopped = false;
    const stopping = handle.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    NativeVoice.last.emit("end", new Event("end"));
    await stopping;
    expect(ended).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
  });
  it("aborts a hung microphone start without applying late text", async () => {
    vi.useFakeTimers();
    const transcript = vi.fn(),
      errors = vi.fn(),
      adapter = createBrowserVoiceAdapter(env());
    const starting = adapter.start({
      language: "en",
      signal: signal(),
      onTranscript: transcript,
      onError: errors,
      onEnd: vi.fn(),
    });
    const failed = expect(starting).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(15_001);
    await failed;
    expect(errors).toHaveBeenCalledWith("start_timeout");
    expect(NativeVoice.last.abort).toHaveBeenCalledOnce();
    NativeVoice.last.emit("result", {
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: "Late private text" } }],
    });
    expect(transcript).not.toHaveBeenCalled();
  });
});
describe("bounded attachment preflight", () => {
  it("attachment bounds use exact bytes and preserve rejected selections", () => {
    const policy = PROPOSED_HOME_ATTACHMENT_POLICY;
    expect(
      validateAttachmentSelection([file(10_485_760), file(10_485_761), file(0), file(1, "image/svg+xml")], [], policy),
    ).toMatchObject({
      accepted: [file(10_485_760)],
      errors: [{ code: "file_bytes" }, { code: "file_bytes" }, { code: "mime" }],
    });
    expect(
      validateAttachmentSelection(
        Array.from({ length: 6 }, () => file(1)),
        [],
        policy,
      ).accepted,
    ).toHaveLength(5);
    expect(
      validateAttachmentSelection([file(10_485_760), file(10_485_760), file(5_242_880), file(1)], [], policy).errors,
    ).toMatchObject([{ code: "total_bytes" }]);
    // MIME/filename checks are preflight only. Actual decoder rejection is a server obligation.
    expect(
      validateAttachmentSelection([file(25, "image/png", "html-disguised.png")], [], policy).accepted,
    ).toHaveLength(1);
  });
});

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HomeVoiceControl, appendDictation } from "@/features/home-inputs/home-voice-control";
import type { HomeVoiceAdapter } from "@/features/home-inputs/voice-contract";
async function voiceFixture(available = true) {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let callbacks: Parameters<HomeVoiceAdapter["start"]>[0] | null = null;
  const stop = vi.fn(async () => callbacks?.onEnd());
  const start = vi.fn(async (input: Parameters<HomeVoiceAdapter["start"]>[0]) => {
    callbacks = input;
    return { stop, disclosure: "Fixture disclosure" };
  });
  const adapter: HomeVoiceAdapter = {
    availability: async (language) =>
      available
        ? { status: "available", language }
        : { status: "unavailable", reason: "No dictation in this fixture browser." },
    start,
  };
  const change = vi.fn(),
    submit = vi.fn();
  async function render(value = "Existing typed brief", sessionFence = "owner:1", disabled = false) {
    await act(async () =>
      root.render(
        createElement(
          "form",
          { onSubmit: submit },
          createElement(HomeVoiceControl, {
            value,
            onChange: change,
            language: "en-US",
            sessionFence,
            adapter,
            disabled,
          }),
        ),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }
  await render();
  const mic = () => host.querySelector<HTMLButtonElement>("button.home-voice-button")!;
  const press = () => act(async () => mic().click());
  return { host, root, start, stop, change, submit, render, mic, press, callbacks: () => callbacks! };
}
describe("the prompt box's dictation button", () => {
  let root: Root | null = null;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    document.body.replaceChildren();
    vi.useRealTimers();
  });
  it("starts with one press, adds settled words to the latest prompt and stops with a second press", async () => {
    const f = await voiceFixture();
    root = f.root;
    expect(f.mic().getAttribute("aria-label")).toBe("Dictate your prompt");
    expect(f.mic().getAttribute("aria-pressed")).toBe("false");
    expect(f.start).not.toHaveBeenCalled();
    await f.press();
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.mic().getAttribute("aria-pressed")).toBe("true");
    expect(f.host.querySelector('[role="status"]')?.textContent).toContain("Listening");
    expect(f.host.querySelector('[role="status"]')?.textContent).toContain("Fixture disclosure");
    // A guess is shown, not written.
    await act(async () => f.callbacks().onTranscript({ finalText: "", interimText: "delivered by" }));
    expect(f.host.querySelector(".home-voice-interim")?.textContent).toBe("delivered by");
    expect(f.change).not.toHaveBeenCalled();
    // The person kept typing meanwhile; settled words join what is there now.
    await f.render("Newer manual edit");
    await act(async () => f.callbacks().onTranscript({ finalText: "delivered by bike", interimText: "" }));
    expect(f.change).toHaveBeenLastCalledWith("Newer manual edit delivered by bike");
    // Only the words added since are written the next time.
    await f.render("Newer manual edit delivered by bike");
    await act(async () => f.callbacks().onTranscript({ finalText: "delivered by bike every Monday", interimText: "" }));
    expect(f.change).toHaveBeenLastCalledWith("Newer manual edit delivered by bike every Monday");
    expect(f.change).toHaveBeenCalledTimes(2);
    await f.press();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.mic().getAttribute("aria-pressed")).toBe("false");
    expect(f.host.querySelector('[role="status"]')).toBeNull();
    // Dictating never sends the prompt.
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("a refused microphone and late events leave the typed prompt alone", async () => {
    const f = await voiceFixture();
    root = f.root;
    await act(async () => {
      f.mic().click();
      f.mic().click();
    });
    expect(f.start).toHaveBeenCalledTimes(1);
    const old = f.callbacks();
    await act(async () => old.onError("permission_denied"));
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain("Microphone access is blocked");
    expect(f.mic().getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      old.onTranscript({ finalText: "Late private voice", interimText: "" });
      old.onEnd();
    });
    expect(f.host.textContent).not.toContain("Late private voice");
    expect(f.change).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("says so when the browser cannot dictate, instead of doing nothing", async () => {
    const f = await voiceFixture(false);
    root = f.root;
    expect(f.mic().disabled).toBe(false);
    await f.press();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.host.querySelector('[role="alert"]')?.textContent).toBe("No dictation in this fixture browser.");
    expect(f.change).not.toHaveBeenCalled();
  });
  it("a pause after spoken words ends dictation quietly", async () => {
    const f = await voiceFixture();
    root = f.root;
    await f.press();
    await act(async () => f.callbacks().onTranscript({ finalText: "A bakery", interimText: "" }));
    await act(async () => f.callbacks().onError("no_speech"));
    expect(f.host.querySelector('[role="alert"]')).toBeNull();
    expect(f.mic().getAttribute("aria-pressed")).toBe("false");
    expect(f.change).toHaveBeenCalledExactlyOnceWith("Existing typed brief A bakery");
  });
  it("stops when the prompt is full, without cutting words", async () => {
    const f = await voiceFixture();
    root = f.root;
    await f.render("a".repeat(11_995));
    await f.press();
    const capture = f.callbacks();
    await act(async () => capture.onTranscript({ finalText: "too many words", interimText: "" }));
    expect(f.change).not.toHaveBeenCalled();
    expect(capture.signal.aborted).toBe(true);
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain("12,000 characters");
  });
  it("an account change cancels dictation and late words cannot reach the next prompt", async () => {
    const f = await voiceFixture();
    root = f.root;
    await f.press();
    const old = f.callbacks();
    await f.render("Another owner prompt", "owner:2");
    expect(old.signal.aborted).toBe(true);
    await act(async () => {
      old.onTranscript({ finalText: "Hidden old phrase", interimText: "more" });
      old.onEnd();
    });
    expect(f.host.textContent).not.toContain("more");
    expect(f.change).not.toHaveBeenCalled();
  });
  it("a held prompt takes no more dictated words", async () => {
    const f = await voiceFixture();
    root = f.root;
    await f.press();
    const capture = f.callbacks();
    await f.render("Existing typed brief", "owner:1", true);
    expect(capture.signal.aborted).toBe(true);
    await act(async () => capture.onTranscript({ finalText: "after the send", interimText: "" }));
    expect(f.change).not.toHaveBeenCalled();
    expect(f.mic().disabled).toBe(true);
  });
  it("joins dictated words with one space and refuses overflow without truncating", () => {
    expect(appendDictation("a".repeat(11999), "bb")).toBeNull();
    expect(appendDictation("", " exact phrase ")).toBe("exact phrase");
    expect(appendDictation("Typed,", "then spoken")).toBe("Typed, then spoken");
    expect(appendDictation("Typed\n", "then spoken")).toBe("Typed\nthen spoken");
    expect(appendDictation("Typed", "  ")).toBe("Typed");
  });
});

import { File as NodeFile } from "node:buffer";
import {
  createHomeInputSession,
  saveAttachedHomeDraft,
  emptyHomeInputIntent,
} from "@/features/home-inputs/home-input-session";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { contextSnapshotSchema } from "@/domain/projects";
import { AccountRequestError } from "@/components/workspace/account-api";
import type { AccountLifecycleClient } from "@/components/workspace/account-lifecycle-client";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import type { OwnedAttachmentRef } from "@/domain/attachments";
const homeOwner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  homeProject = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const homeId = (n: number) => `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, "0")}`;
const homeAccount: VerifiedAccount = { status: "ready", userId: homeOwner, generation: 1 };
function pendingFile(n: number) {
  const file = new NodeFile(["brief"], `${n}.txt`, { type: "text/plain" }) as unknown as File;
  return {
    localId: homeId(n),
    file,
    upload: { requestKey: homeId(n), name: file.name, mimeType: "text/plain" as const, contentHash: "a".repeat(64) },
    receipt: null,
    outcome: "local" as const,
  };
}
function uploaded(n: number): OwnedAttachmentRef {
  return {
    id: homeId(n),
    ownerId: homeOwner,
    projectId: null,
    projectRevision: null,
    blobVersionId: homeId(n),
    contentHash: "a".repeat(64),
    mimeType: "text/plain",
    byteLength: 5,
    name: `${n}.txt`,
    sourceReceiptId: homeId(n),
    state: "staged",
  };
}
const homeDraft = () =>
  accountProjectDraft({
    id: homeProject,
    owner_id: homeOwner,
    title: "Retained brief",
    scope: "complete_brand",
    current_revision: 1,
    context: contextSnapshotSchema.parse({ description: "Typed brief retained" }),
    created_at: "2026-10-07T00:00:00Z",
  });
describe("attached Home intent orchestration with synthetic unavailable production storage", () => {
  it("pending file-selection markers stay private and clear on verified different owner or confirmed logout", () => {
    const memory = createHomeInputSession();
    memory.bind(homeAccount);
    const reader = memory.beginSelection(homeAccount, 2)!;
    const selected = memory.getSelection(homeAccount)!;
    memory.bind(null);
    expect(memory.hasUnsaved()).toBe(true);
    expect(memory.getSelection(homeAccount)).toBeNull();
    expect(reader.current()).toBe(false);
    const recovered = { ...homeAccount, generation: 3 };
    memory.bind(recovered);
    expect(memory.getSelection(recovered)).toEqual({ ...selected, status: "interrupted" });
    expect(memory.cancelSelection(homeAccount, selected.id)).toBe(false);
    const foreign = { ...recovered, userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    memory.bind(foreign);
    expect(memory.getSelection(foreign)).toBeNull();
    expect(memory.hasUnsaved()).toBe(false);
    const fresh = memory.beginSelection(foreign, 1)!;
    reader.complete();
    reader.interrupt();
    expect(fresh.current()).toBe(true);
    memory.clear();
    expect(memory.hasUnsaved()).toBe(false);
    expect(fresh.current()).toBe(false);
  });

  it("a fenced hung upload cannot hold the next verified generation admission", () => {
    const memory = createHomeInputSession();
    memory.bind(homeAccount);
    const releaseOld = memory.acquire(homeAccount);
    expect(releaseOld).not.toBeNull();
    memory.bind(null);
    const next = { ...homeAccount, generation: 2 };
    memory.bind(next);
    const releaseNew = memory.acquire(next);
    expect(releaseNew).not.toBeNull();
    releaseOld!();
    expect(memory.acquire(next)).toBeNull();
    releaseNew!();
    expect(memory.acquire(next)).not.toBeNull();
  });

  it("one failed attachment does not lose the brief or verified files", async () => {
    const memory = createHomeInputSession();
    memory.bind(homeAccount);
    memory.set(homeAccount, { ...emptyHomeInputIntent(), files: [pendingFile(1), pendingFile(2), pendingFile(3)] });
    const stage = vi
      .fn()
      .mockResolvedValueOnce(uploaded(1))
      .mockResolvedValueOnce(uploaded(2))
      .mockRejectedValueOnce(new AccountRequestError(422));
    const save = vi.fn(),
      client = { stageHomeAttachment: stage, saveAttachedProjectDraft: save } as unknown as AccountLifecycleClient;
    const draft = homeDraft();
    await expect(
      saveAttachedHomeDraft({ account: homeAccount, draft, memory, client, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ status: 422 });
    expect(memory.get(homeAccount)?.files.map((file) => file.outcome)).toEqual(["verified", "verified", "failed"]);
    expect(memory.get(homeAccount)?.saveIntent?.project.context.description).toBe("Typed brief retained");
    expect(draft.description).toBe("Typed brief retained");
    expect(save).not.toHaveBeenCalled();
  });
  it("lost Home save response cannot create a second project and never submits Strategy", async () => {
    const memory = createHomeInputSession();
    memory.bind(homeAccount);
    memory.set(homeAccount, { ...emptyHomeInputIntent(), files: [pendingFile(1)] });
    let committed: unknown;
    const stage = vi.fn().mockResolvedValue(uploaded(1)),
      save = vi.fn(async (input: Parameters<AccountLifecycleClient["saveAttachedProjectDraft"]>[0]) => {
        committed = {
          ownerId: homeOwner,
          requestKey: input.requestKey,
          project: {
            ...input.project,
            id: homeProject,
            owner_id: homeOwner,
            current_revision: 1,
            created_at: "2026-10-07T00:00:00Z",
          },
          attachments: [{ ...uploaded(1), projectId: homeProject, projectRevision: 1, state: "linked" }],
        };
        throw new TypeError("Lost save response");
      });
    const read = vi.fn(async () => ({ status: "committed", receipt: committed })),
      client = {
        stageHomeAttachment: stage,
        saveAttachedProjectDraft: save,
        readAttachedProjectDraftRequest: read,
      } as unknown as AccountLifecycleClient;
    const args = { account: homeAccount, draft: homeDraft(), memory, client, signal: new AbortController().signal };
    await expect(saveAttachedHomeDraft(args)).rejects.toThrow();
    expect(memory.get(homeAccount)?.saveOutcome).toBe("uncertain");
    const original = memory.get(homeAccount)?.saveIntent;
    const result = await saveAttachedHomeDraft({
      ...args,
      draft: { ...args.draft, description: "A later local edit" },
    });
    expect(result).toEqual(committed);
    expect(memory.get(homeAccount)?.saveIntent).toEqual(original);
    expect(stage).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(memory.hasUnsaved()).toBe(false);
  });
  it("owner change fences uploaded files and pending Home intent", async () => {
    const memory = createHomeInputSession();
    memory.bind(homeAccount);
    memory.set(homeAccount, { ...emptyHomeInputIntent(), files: [pendingFile(1)] });
    let resolve!: (value: OwnedAttachmentRef) => void;
    const stage = vi.fn(
        () =>
          new Promise<OwnedAttachmentRef>((done) => {
            resolve = done;
          }),
      ),
      save = vi.fn();
    const client = { stageHomeAttachment: stage, saveAttachedProjectDraft: save } as unknown as AccountLifecycleClient;
    const operation = saveAttachedHomeDraft({
      account: homeAccount,
      draft: homeDraft(),
      memory,
      client,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(stage).toHaveBeenCalledTimes(1));
    memory.bind(null);
    resolve(uploaded(1));
    expect(await operation).toBeNull();
    expect(memory.get(homeAccount)).toBeNull();
    expect(save).not.toHaveBeenCalled();
    const next = { ...homeAccount, generation: 3 };
    memory.bind(next);
    expect(memory.get(next)?.files[0]?.outcome).toBe("pending");
    memory.bind({ ...next, userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    expect(memory.hasUnsaved()).toBe(false);
  });
});

import { createHash, webcrypto } from "node:crypto";
import { createAccountLifecycleClient } from "@/components/workspace/account-lifecycle-client";
describe("bounded raw Home upload transport", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("freezes original bytes, verifies hash and sends URL-encoded Unicode metadata separately", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const bytes = new Uint8Array([104, 105]),
      hash = createHash("sha256").update(bytes).digest("hex"),
      name = "café 中文.txt";
    const input = { requestKey: homeId(1), name, mimeType: "text/plain" as const, contentHash: hash };
    const ref = { ...uploaded(1), name, contentHash: hash, byteLength: 2 };
    const fetcher = vi.fn().mockResolvedValue(Response.json({ requestKey: input.requestKey, attachment: ref }));
    vi.stubGlobal("fetch", fetcher);
    const client = createAccountLifecycleClient(homeAccount, () => true, vi.fn());
    const operation = client.stageHomeAttachment(input, bytes);
    bytes[0] = 0;
    expect(await operation).toEqual(ref);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "/api/home/attachments",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: expect.objectContaining({
          "Content-Type": "text/plain",
          "X-Embel-Account": homeAccount.userId,
          "X-Fluid-Attachment-Name": encodeURIComponent(name),
          "X-Fluid-Content-Hash": hash,
        }),
      }),
    );
    expect([...new Uint8Array(fetcher.mock.calls[0]![1].body)]).toEqual([104, 105]);
  });
  it("binds an attached project creation to the captured account", async () => {
    const project = {
      title: "Retained brief",
      scope: "complete_brand" as const,
      context: contextSnapshotSchema.parse({ description: "Typed brief" }),
    };
    const input = { requestKey: homeId(2), project, attachmentIds: [homeId(1)] };
    const receipt = {
      ownerId: homeOwner,
      requestKey: input.requestKey,
      project: {
        ...project,
        id: homeProject,
        owner_id: homeOwner,
        current_revision: 1,
        created_at: "2026-10-07T00:00:00Z",
      },
      attachments: [{ ...uploaded(1), projectId: homeProject, projectRevision: 1, state: "linked" }],
    };
    const fetcher = vi.fn().mockResolvedValue(Response.json(receipt));
    vi.stubGlobal("fetch", fetcher);
    const client = createAccountLifecycleClient(homeAccount, () => true, vi.fn());
    expect(await client.saveAttachedProjectDraft(input)).toEqual(receipt);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "/api/home/projects",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Embel-Account": homeAccount.userId }),
        body: JSON.stringify(input),
      }),
    );
  });
  it.each(["upload", "project"])(
    "expires the captured account on a cookie-switch rejection of %s without retrying",
    async (kind) => {
      vi.stubGlobal("crypto", webcrypto);
      const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
        expire = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const client = createAccountLifecycleClient(homeAccount, () => true, expire);
      const bytes = new Uint8Array([104, 105]),
        hash = createHash("sha256").update(bytes).digest("hex");
      const result =
        kind === "upload"
          ? await client.stageHomeAttachment(
              { requestKey: homeId(1), name: "1.txt", mimeType: "text/plain", contentHash: hash },
              bytes,
            )
          : await client.saveAttachedProjectDraft({
              requestKey: homeId(2),
              project: {
                title: "Private draft",
                scope: "complete_brand",
                context: contextSnapshotSchema.parse({ description: "Typed brief" }),
              },
              attachmentIds: [],
            });
      expect(result).toBeNull();
      expect(expire).toHaveBeenCalledExactlyOnceWith(homeAccount);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(new Headers(fetcher.mock.calls[0]![1].headers).get("X-Embel-Account")).toBe(homeOwner);
    },
  );
  it("refuses changed bytes before network and mismatched upload acknowledgements", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const bytes = new Uint8Array([104, 105]),
      hash = createHash("sha256").update(bytes).digest("hex"),
      input = { requestKey: homeId(1), name: "1.txt", mimeType: "text/plain" as const, contentHash: hash };
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const client = createAccountLifecycleClient(homeAccount, () => true, vi.fn());
    await expect(client.stageHomeAttachment(input, new Uint8Array([0]))).rejects.toMatchObject({ status: 422 });
    expect(fetcher).not.toHaveBeenCalled();
    for (const result of [
      { requestKey: homeId(2), attachment: { ...uploaded(1), byteLength: 2, contentHash: hash } },
      { requestKey: homeId(1), attachment: { ...uploaded(1), byteLength: 3, contentHash: hash } },
    ]) {
      fetcher.mockResolvedValueOnce(Response.json(result));
      await expect(client.stageHomeAttachment(input, bytes)).rejects.toMatchObject({ status: 502 });
    }
  });
});
