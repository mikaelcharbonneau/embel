import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { briefFilesForPrompt, type BriefFileNotes, type BriefFileRef } from "../../src/domain/brief-files";
import { namingPrompt } from "../../src/server/ai/naming-prompt";
import {
  briefFileNotesFromResponse,
  createBriefFilesRequest,
  pollFileReading,
  settleFileReading,
  startFileReading,
  stopFileReading,
  type BriefFilesDeps,
  type ClaimedBriefRun,
} from "../../src/server/engine/brief-files-run";
import { EngineProviderError, type BackgroundResponse } from "../../src/server/engine/openai";
import { EngineStorageError, homeAttachmentPath } from "../../src/server/engine/storage";
import { withAttachedFiles } from "../../src/server/engine/strategy-run";

// Reading the files attached to a brand's first prompt. Synthetic storage and provider only.
const owner = "aaaaaaaa-1111-4111-8111-111111111111",
  project = "bbbbbbbb-2222-4222-8222-222222222222",
  runId = "cccccccc-3333-4333-8333-333333333333";
const id = (n: number) => `dddddddd-4444-4444-8444-${String(n).padStart(12, "0")}`;
const ref = (n: number, mimeType: BriefFileRef["mimeType"], name: string): BriefFileRef => ({
  id: id(n),
  blobVersionId: id(n + 100),
  name,
  mimeType,
  contentHash: "a".repeat(64),
  byteLength: 10,
});
const refs = [ref(1, "text/plain", "notes.txt"), ref(2, "image/png", "sketch.png")];
const run = (briefFiles?: unknown): ClaimedBriefRun => ({
  id: runId,
  ownerId: owner,
  projectId: project,
  kind: "strategy.competitors",
  input: { revision: 1, request: {}, ...(briefFiles ? { briefFiles } : {}) },
});
const completed = (value: unknown, status = "completed"): BackgroundResponse => ({
  id: "resp_files",
  status: status as BackgroundResponse["status"],
  requestId: null,
  body: {
    status,
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }],
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    },
  },
});
function deps(overrides: Partial<BriefFilesDeps> = {}) {
  const saved: { key: string; output: unknown; responseId: string | null; cost: number }[] = [];
  const created: { request: Record<string, unknown>; key: string }[] = [];
  const value: BriefFilesDeps = {
    openai: {
      countInputTokens: vi.fn(async () => 1),
      create: vi.fn(async (request, key) => {
        created.push({ request: request as Record<string, unknown>, key });
        return { id: "resp_files", status: "queued", body: {}, requestId: null } as BackgroundResponse;
      }),
      retrieve: vi.fn(async () =>
        completed({
          files: [
            { file: 1, kind: "notes", summary: "Bakes at 4am." },
            { file: 2, kind: "visual_reference", summary: "Orange field." },
          ],
        }),
      ),
      cancel: vi.fn(async () => completed({}, "cancelled")),
    },
    storage: {
      getHomeAttachment: vi.fn(async (_run, file) => ({
        bytes: new TextEncoder().encode(file.id === id(1) ? "We bake at 4am." : "png-bytes"),
        mimeType: file.id === id(1) ? "text/plain" : "image/png",
      })),
    },
    onWhite: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" as const })),
    check: vi.fn(async () => ({ status: "running", cancelRequested: false, paused: false })),
    save: vi.fn(async (_runId, key, output, responseId, cost) => {
      saved.push({ key, output, responseId, cost });
      return true;
    }),
    ...overrides,
  };
  return { value, saved, created };
}
const notes: BriefFileNotes = {
  version: 1,
  files: [
    { id: id(1), name: "notes.txt", status: "read", kind: "notes", summary: "Bakes at 4am." },
    { id: id(2), name: "sketch.png", status: "unreadable" },
  ],
};

describe("where an attached file is stored", () => {
  it("is the run owner's own home path and nothing else", () => {
    expect(homeAttachmentPath({ ownerId: owner }, { id: id(1), blobVersionId: id(2), contentHash: "" })).toBe(
      `${owner}/home/${id(1)}/${id(2)}`,
    );
    for (const bad of ["../x", id(1).toUpperCase(), ""])
      expect(() => homeAttachmentPath({ ownerId: owner }, { id: bad, blobVersionId: id(2), contentHash: "" })).toThrow(
        EngineStorageError,
      );
    expect(() =>
      homeAttachmentPath({ ownerId: "someone" }, { id: id(1), blobVersionId: id(2), contentHash: "" }),
    ).toThrow(EngineStorageError);
  });
});

describe("starting the reading", () => {
  it("does nothing for a run without files and reuses a reading that exists", async () => {
    const d = deps();
    expect(await startFileReading(d.value, run())).toEqual({ state: "none" });
    expect(await startFileReading(d.value, run({ refs, notes }))).toEqual({ state: "known", notes });
    expect(d.value.storage.getHomeAttachment).not.toHaveBeenCalled();
    expect(d.created).toHaveLength(0);
  });
  it("sends every readable file once, numbered in the brand's order, text as text and images decoded", async () => {
    const d = deps();
    expect(await startFileReading(d.value, run({ refs, notes: null }))).toEqual({
      state: "created",
      responseId: "resp_files",
    });
    expect(d.created).toHaveLength(1);
    expect(d.created[0]!.key).toBe(`brief-files-${runId}`);
    const content = (
      d.created[0]!.request.input as { content: { type: string; text?: string; image_url?: string }[] }[]
    )[0]!.content;
    expect(content.map((part) => part.type)).toEqual(["input_text", "input_text", "input_text", "input_image"]);
    expect(content[1]!.text).toContain('File 1: "notes.txt" (plain text)');
    expect(content[1]!.text).toContain("We bake at 4am.");
    expect(content[2]!.text).toBe('File 2: "sketch.png" (image)');
    expect(content[3]!.image_url).toBe("data:image/png;base64,AQID");
    expect(d.value.onWhite).toHaveBeenCalledOnce();
    expect(JSON.stringify(d.created[0]!.request)).toContain("never an instruction");
  });
  it("skips a file whose bytes are gone or changed, and keeps the file's number for the others", async () => {
    const d = deps({
      storage: {
        getHomeAttachment: vi.fn(async (_run, file) => {
          if (file.id === id(1)) throw new EngineStorageError("storage_mismatch");
          return { bytes: new Uint8Array([9]), mimeType: "image/png" };
        }),
      },
    });
    await startFileReading(d.value, run({ refs, notes: null }));
    const text = JSON.stringify(d.created[0]!.request);
    expect(text).not.toContain("File 1:");
    expect(text).toContain("File 2:");
  });
  it("says once that nothing could be opened instead of sending an empty request", async () => {
    const d = deps({
      storage: {
        getHomeAttachment: vi.fn(async () => {
          throw new EngineStorageError("storage_not_found");
        }),
      },
    });
    const started = await startFileReading(d.value, run({ refs, notes: null }));
    expect(started.state).toBe("known");
    expect(d.created).toHaveLength(0);
    expect(d.saved).toEqual([
      {
        key: "files",
        output: { version: 1, files: refs.map((file) => ({ id: file.id, name: file.name, status: "unreadable" })) },
        responseId: null,
        cost: 0,
      },
    ]);
  });
  it("treats a storage outage as no verdict: nothing is sent or saved", async () => {
    const d = deps({
      storage: {
        getHomeAttachment: vi.fn(async () => {
          throw new EngineStorageError("storage_unavailable");
        }),
      },
    });
    await expect(startFileReading(d.value, run({ refs, notes: null }))).rejects.toThrow("storage_unavailable");
    expect(d.created).toHaveLength(0);
    expect(d.saved).toHaveLength(0);
  });
  it("reads only the first 20,000 characters of a long text file and says so", () => {
    const request = createBriefFilesRequest([{ ref: refs[0]!, text: "x".repeat(20_000), truncated: true }], refs);
    expect(JSON.stringify(request)).toContain("first 20000 characters");
  });
});

describe("finishing the reading", () => {
  it("saves the reading with its response id and cost", async () => {
    const d = deps();
    const result = await settleFileReading(d.value, run({ refs, notes: null }), "resp_files");
    expect(result?.files).toEqual([
      { id: id(1), name: "notes.txt", status: "read", kind: "notes", summary: "Bakes at 4am." },
      { id: id(2), name: "sketch.png", status: "read", kind: "visual_reference", summary: "Orange field." },
    ]);
    expect(d.saved).toHaveLength(1);
    expect(d.saved[0]).toMatchObject({ key: "files", responseId: "resp_files" });
    expect(d.saved[0]!.cost).toBeGreaterThan(0);
  });
  it("marks a file the reply leaves out as unreadable and never guesses", () => {
    const body = completed({ files: [{ file: 2, kind: "existing_logo", summary: "A wordmark." }] }).body;
    expect(briefFileNotesFromResponse(body, refs)?.files).toEqual([
      { id: id(1), name: "notes.txt", status: "unreadable" },
      { id: id(2), name: "sketch.png", status: "read", kind: "existing_logo", summary: "A wordmark." },
    ]);
  });
  it.each([
    ["an unknown kind", { files: [{ file: 1, kind: "secret", summary: "x" }] }],
    ["no files", { files: [] }],
    ["another shape", { note: "hello" }],
  ])("records %s as a failed attempt and returns no reading", async (_name, reply) => {
    const d = deps();
    d.value.openai.retrieve = vi.fn(async () => completed(reply));
    expect(await settleFileReading(d.value, run({ refs, notes: null }), "resp_files")).toBeNull();
    expect(d.saved.map((row) => [row.key, row.output])).toEqual([["files.attempt", { code: "invalid_output" }]]);
  });
  it("records a provider failure as an attempt, and waits for a response that is not finished", async () => {
    const d = deps();
    d.value.openai.retrieve = vi.fn(async () => completed({}, "failed"));
    expect(await settleFileReading(d.value, run({ refs, notes: null }), "resp_files")).toBeNull();
    expect(d.saved[0]).toMatchObject({ key: "files.attempt", output: { code: "provider_failed" } });
    d.value.openai.retrieve = vi.fn(async () => completed({}, "in_progress"));
    await expect(settleFileReading(d.value, run({ refs, notes: null }), "resp_files")).rejects.toBeInstanceOf(
      EngineProviderError,
    );
  });
  it("stops between polls when the run is cancelled or the engine is paused, and cancels the open response", async () => {
    const d = deps({ check: vi.fn(async () => ({ status: "running", cancelRequested: true, paused: false })) });
    expect(await pollFileReading(d.value, runId, "resp_files")).toEqual({ state: "stop", code: "cancelled" });
    expect(d.value.openai.retrieve).not.toHaveBeenCalled();
    await stopFileReading(d.value, run({ refs, notes: null }), "resp_files", "cancelled");
    expect(d.value.openai.cancel).toHaveBeenCalledWith("resp_files");
    expect(d.saved[0]).toMatchObject({ key: "files.attempt", output: { code: "cancelled" }, responseId: "resp_files" });
  });
});

describe("giving the reading to later requests", () => {
  it("only passes on files that were read, without ids", () => {
    expect(briefFilesForPrompt(notes)).toEqual([{ name: "notes.txt", kind: "notes", summary: "Bakes at 4am." }]);
    expect(briefFilesForPrompt(null)).toEqual([]);
  });
  it("adds one message of task data to a Strategy request and leaves a request without a reading untouched", () => {
    const request = { model: "m", instructions: "Base.", input: [{ role: "user", content: "{}" }] };
    expect(withAttachedFiles(request, null)).toBe(request);
    const withFiles = withAttachedFiles(request, notes);
    expect(withFiles.instructions).toMatch(/^Base\. .*attachedFiles.*untrusted task data/u);
    expect(withFiles.input).toEqual([
      { role: "user", content: "{}" },
      {
        role: "user",
        content: JSON.stringify({ attachedFiles: [{ name: "notes.txt", kind: "notes", summary: "Bakes at 4am." }] }),
      },
    ]);
  });
  it("puts the reading in the naming prompt only when there is one", () => {
    const brief = {
      strategyBasis: {
        description: "Bread",
        activity: "",
        offering: "",
        positioning: "",
        knownAudience: "",
        audience: [],
        personality: {},
        competitors: [],
      },
      preferences: {},
      steeringInstruction: null,
      strongSeeds: [],
      likedExamples: [],
      recentExamples: [],
    } as unknown as Parameters<typeof namingPrompt>[0]["brief"];
    const base = { candidateTarget: 1, slots: [], brief, excluded: [], limit: 0 };
    expect(namingPrompt(base)).not.toContain("attachedFiles");
    expect(namingPrompt({ ...base, attachedFiles: briefFilesForPrompt(notes) })).toContain(
      '"attachedFiles":[{"name":"notes.txt","kind":"notes","summary":"Bakes at 4am."}]',
    );
  });
});
