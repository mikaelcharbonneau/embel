import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createHash } from "node:crypto";
import { EngineProviderError } from "../../src/server/engine/openai";
import {
  EngineImageRejectedError,
  type EngineImageReply,
  type EngineImages,
} from "../../src/server/engine/openai-images";
import { EngineStorageError, type EngineStorage } from "../../src/server/engine/storage";
import {
  beginLogoImages,
  drawLogoImage,
  LogoRunError,
  readLogoImagesRun,
  recordLogoImageFailure,
  type ClaimedLogoRun,
  type LogoRunDeps,
} from "../../src/server/engine/logo-run";

// Synthetic provider, Storage and database only; no live inference.
const owner = "aaaaaaaa-1111-4111-8111-111111111111",
  project = "bbbbbbbb-2222-4222-8222-222222222222",
  runId = "cccccccc-3333-4333-8333-333333333333";
const other = "dddddddd-4444-4444-8444-444444444444";
const heads = {
  projectRevision: 1,
  referenceRevision: 0,
  preferencesRevision: 0,
  workspaceRevision: 1,
  stageRevisions: { brief_references: 1, concepts: 0, vector: 0, refinements: 0, directions: 0, deliverables: 0 },
};
const brief = {
  id: "eeeeeeee-5555-4555-8555-555555555555",
  revision: 1,
  payload: {
    name: "Levain & Co",
    activity: "Office bread",
    audience: "Office teams",
    personality: "Warm",
    logoTypes: ["wordmark", "pictorial"],
  },
};
const batchId = "ffffffff-6666-4666-8666-666666666666";
const hash = (seed: string) => createHash("sha256").update(seed).digest("hex");
const asset = (seed: string, ownerId = owner) => ({
  ownerId,
  projectId: project,
  assetId: "11111111-7777-4777-8777-77777777777" + seed,
  versionId: "22222222-7777-4777-8777-77777777777" + seed,
  contentHash: hash(seed),
});

const concepts: ClaimedLogoRun = {
  id: runId,
  ownerId: owner,
  projectId: project,
  kind: "logo.concepts",
  input: { version: 1, revision: 1, operation: "concepts", expected: heads, brief, batchId },
};
const refine = (
  references = [{ asset: asset("2"), mimeType: "image/png", aspects: ["overall_feel"] }],
): ClaimedLogoRun => ({
  id: runId,
  ownerId: owner,
  projectId: project,
  kind: "logo.refine",
  input: {
    version: 1,
    revision: 1,
    expected: heads,
    brief,
    source: { kind: "refinement", rasterRevisionId: other },
    basePreview: asset("1"),
    references,
    instruction: "Bolder lettering",
  },
});
const slot = { key: "image.0", type: "wordmark" as const, directionId: "open_geometry" };
const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const drawn = (cost = 210_000): EngineImageReply => ({
  kind: "image",
  bytes: png,
  providerRequestId: "req_synthetic",
  responseHash: hash("reply"),
  usage: null,
  costMicrousd: cost,
});

function harness(
  options: {
    replies?: (EngineImageReply | Error)[];
    marked?: boolean | Error;
    monochrome?: boolean;
    put?: (Error | null)[];
    stored?: Record<string, Uint8Array>;
    stopped?: boolean;
  } = {},
) {
  const replies = [...(options.replies ?? [drawn()])],
    puts = [...(options.put ?? [])];
  const saved: { key: string; image: Record<string, unknown>; responseId: string | null; cost: number }[] = [];
  const draws: { prompt: string; images: number }[] = [],
    markers: string[] = [],
    written: string[] = [];
  const images: EngineImages = {
    async draw(input) {
      draws.push({ prompt: input.prompt, images: input.images.length });
      const next = replies.shift()!;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const storage: EngineStorage = {
    async put(run, target) {
      const error = puts.shift();
      if (error) throw error;
      if (target.ownerId !== run.ownerId) throw new EngineStorageError("storage_path_refused");
      written.push(`${target.ownerId}/${target.projectId}/${target.assetId}/${target.versionId}`);
    },
    async get(run, target) {
      if (target.ownerId !== run.ownerId) throw new EngineStorageError("storage_path_refused");
      const bytes = options.stored?.[target.versionId];
      if (!bytes) throw new EngineStorageError("storage_not_found");
      return { bytes, mimeType: "image/png" };
    },
  };
  let ids = 0;
  const deps: LogoRunDeps = {
    images,
    storage,
    now: () => new Date("2026-11-09T20:00:00.000Z"),
    newId: () => `99999999-8888-4888-8888-${String(++ids).padStart(12, "0")}`,
    raster: {
      normalize: async (bytes) => bytes,
      inspect: async () => ({
        width: 1024,
        height: 1024,
        isMonochrome: options.monochrome ?? true,
        pixelHash: hash("pixels"),
      }),
    },
    db: {
      check: async () => ({ status: "running", cancelRequested: options.stopped ?? false, paused: false }),
      begin: async () => ({
        batchId,
        plan: {},
        slots: [0, 1, 2, 3, 4, 5].map((ordinal) => ({
          ordinal,
          slotId: `33333333-9999-4999-8999-00000000000${ordinal}`,
          type: ordinal % 2 ? "pictorial" : "wordmark",
          directionId: "open_geometry",
        })),
      }),
      async saveOutput(_run, key) {
        if (options.marked instanceof Error) throw options.marked;
        markers.push(key);
        return options.marked ?? true;
      },
      async saveImage(_run, key, image, responseId, cost) {
        saved.push({ key, image: image as Record<string, unknown>, responseId, cost });
        const value = image as { state: string; code?: string };
        return { state: value.state, ...(value.code ? { code: value.code } : {}) };
      },
    },
  };
  return { deps, saved, draws, markers, written };
}

describe("reading a Logo run", () => {
  it("accepts concepts and refinements of the run's own owner and project only", () => {
    expect(readLogoImagesRun(concepts).kind).toBe("logo.concepts");
    expect(readLogoImagesRun(refine()).kind).toBe("logo.refine");
    expect(() =>
      readLogoImagesRun(refine([{ asset: asset("2", other), mimeType: "image/png", aspects: ["overall_feel"] }])),
    ).toThrow(LogoRunError);
    expect(() => readLogoImagesRun({ ...concepts, kind: "logo.refine" })).toThrow("invalid_run_input");
    expect(() =>
      readLogoImagesRun({ ...concepts, input: { ...(concepts.input as object), operation: "retry_failed" } }),
    ).toThrow("invalid_run_input");
  });
  it("opens a concepts round as six targets, and a refinement as one", async () => {
    const { deps } = harness();
    expect((await beginLogoImages(deps, concepts)).targets.map((target) => target.key)).toEqual([
      "image.0",
      "image.1",
      "image.2",
      "image.3",
      "image.4",
      "image.5",
    ]);
    expect(await beginLogoImages(deps, refine())).toEqual({ targets: [{ key: "image.refine" }] });
  });
});

describe("drawing one Logo image", () => {
  it("marks the try as sent, draws once, stores under the owner's path and records it with its cost", async () => {
    const { deps, saved, draws, markers, written } = harness();
    expect(await drawLogoImage(deps, concepts, slot, 1)).toEqual({ state: "succeeded", code: null });
    expect(markers).toEqual(["sent.image.0.1"]);
    expect(draws).toHaveLength(1);
    expect(draws[0]!.prompt).toContain("Assigned logo type: wordmark.");
    expect(draws[0]!.prompt).toContain("Use a fully transparent background");
    expect(written).toEqual([
      `${owner}/${project}/99999999-8888-4888-8888-000000000001/99999999-8888-4888-8888-000000000002`,
    ]);
    expect(saved).toEqual([
      {
        key: "image.0",
        responseId: "req_synthetic",
        cost: 210_000,
        image: {
          state: "succeeded",
          image: {
            assetId: "99999999-8888-4888-8888-000000000001",
            versionId: "99999999-8888-4888-8888-000000000002",
            mimeType: "image/png",
            byteLength: png.byteLength,
            contentHash: createHash("sha256").update(png).digest("hex"),
            normalizedPixelHash: hash("pixels"),
          },
          provider: {
            model: "gpt-image-2.6-sunburst",
            providerRequestId: "req_synthetic",
            responseHash: hash("reply"),
            observedAt: "2026-11-09T20:00:00.000Z",
          },
        },
      },
    ]);
  });
  it("asks to try again when nothing was drawn, without recording anything", async () => {
    const { deps, saved, draws } = harness({ replies: [new EngineProviderError("retry", 429, 2_000)] });
    expect(await drawLogoImage(deps, concepts, slot, 1)).toEqual({ state: "retry", retryAfterMs: 2_000 });
    expect(draws).toHaveLength(1);
    expect(saved).toEqual([]);
  });
  it("records a refused image as failed, with the usage OpenAI reported", async () => {
    const { deps, saved } = harness({ replies: [new EngineImageRejectedError(400, "req_refused", 1_200)] });
    expect(await drawLogoImage(deps, concepts, slot, 1)).toEqual({ state: "failed", code: "provider_rejected" });
    expect(saved).toEqual([
      { key: "image.0", image: { state: "failed", code: "provider_rejected" }, responseId: "req_refused", cost: 1_200 },
    ]);
  });
  it("never sends an image twice when its outcome is unknown", async () => {
    const { deps, saved, draws } = harness({ replies: [new EngineProviderError("uncertain", 504)] });
    expect(await drawLogoImage(deps, concepts, slot, 1)).toEqual({ state: "failed", code: "provider_outcome_unknown" });
    expect(draws).toHaveLength(1);
    expect(saved[0]).toMatchObject({ image: { state: "failed", code: "provider_outcome_unknown" }, cost: 0 });
  });
  it("does not send a try that an earlier run of this step may already have sent", async () => {
    const { deps, saved, draws } = harness({ marked: false });
    expect(await drawLogoImage(deps, concepts, slot, 2)).toEqual({ state: "failed", code: "provider_outcome_unknown" });
    expect(draws).toEqual([]);
    expect(saved).toHaveLength(1);
  });
  it("stops without sending once the run has ended", async () => {
    const { deps, saved, draws } = harness({ marked: new Error("run_not_running") });
    expect(await drawLogoImage(deps, concepts, slot, 1)).toEqual({ state: "stopped" });
    expect(draws).toEqual([]);
    expect(saved).toEqual([]);
  });
  it("fails a paid image that is not black and white, or unreadable, and keeps its cost", async () => {
    const color = harness({ monochrome: false });
    expect(await drawLogoImage(color.deps, concepts, slot, 1)).toEqual({ state: "failed", code: "chromatic_output" });
    expect(color.written).toEqual([]);
    expect(color.saved[0]).toMatchObject({
      cost: 210_000,
      image: { state: "failed", code: "chromatic_output", provider: { providerRequestId: "req_synthetic" } },
    });
    const unreadable = harness({
      replies: [
        {
          kind: "unusable",
          code: "invalid_output",
          providerRequestId: "req_x",
          responseHash: null,
          usage: null,
          costMicrousd: 90_000,
        },
      ],
    });
    expect(await drawLogoImage(unreadable.deps, concepts, slot, 1)).toEqual({
      state: "failed",
      code: "invalid_output",
    });
    expect(unreadable.saved[0]).toMatchObject({ cost: 90_000 });
  });
  it("retries a Storage outage while storing, then fails the image with its cost", async () => {
    const recovered = harness({ put: [new EngineStorageError("storage_unavailable"), null] });
    expect(await drawLogoImage(recovered.deps, concepts, slot, 1)).toEqual({ state: "succeeded", code: null });
    const lost = harness({
      put: [
        new EngineStorageError("storage_unavailable"),
        new EngineStorageError("storage_unavailable"),
        new EngineStorageError("storage_unavailable"),
      ],
    });
    expect(await drawLogoImage(lost.deps, concepts, slot, 1)).toEqual({ state: "failed", code: "storage_unavailable" });
    expect(lost.saved[0]).toMatchObject({ cost: 210_000 });
  }, 15_000);
  it("stores no file for an image that finished after Stop, and keeps its usage", async () => {
    const { deps, saved, written } = harness({ stopped: true });
    expect(await drawLogoImage(deps, concepts, slot, 1)).toEqual({ state: "failed", code: "run_stopped" });
    expect(written).toEqual([]);
    expect(saved[0]).toMatchObject({ cost: 210_000, image: { state: "failed", code: "run_stopped" } });
  });
  it("refines from the stored base image and liked uploads, and fails when one is gone", async () => {
    const stored = { [asset("1").versionId]: png, [asset("2").versionId]: png };
    const present = harness({ stored });
    expect(await drawLogoImage(present.deps, refine(), { key: "image.refine" }, 1)).toEqual({
      state: "succeeded",
      code: null,
    });
    expect(present.draws[0]).toMatchObject({ images: 2 });
    expect(present.draws[0]!.prompt).toContain("Refine the first image");
    expect(present.draws[0]!.prompt).toContain("Bolder lettering");
    const missing = harness({ stored: { [asset("1").versionId]: png } });
    expect(await drawLogoImage(missing.deps, refine(), { key: "image.refine" }, 1)).toEqual({
      state: "failed",
      code: "source_unavailable",
    });
    expect(missing.draws).toEqual([]);
  });
  it("refuses keys and tries outside the run", async () => {
    const { deps } = harness();
    await expect(drawLogoImage(deps, concepts, { key: "image.refine" }, 1)).rejects.toThrow("invalid_run_input");
    await expect(drawLogoImage(deps, concepts, slot, 4)).rejects.toThrow("invalid_run_input");
    await expect(recordLogoImageFailure(deps, concepts, "image.9", "x")).rejects.toThrow("invalid_run_input");
  });
});

describe("partial results", () => {
  it("keeps each image's own outcome when some of a round fail", async () => {
    const { deps, saved } = harness({
      replies: [
        drawn(),
        new EngineImageRejectedError(400, null, 0),
        drawn(),
        new EngineProviderError("uncertain", null),
        drawn(),
        drawn(),
      ],
    });
    const { targets } = await beginLogoImages(deps, concepts);
    const ends = [];
    for (const target of targets) ends.push(await drawLogoImage(deps, concepts, target, 1));
    expect(ends.map((end) => ("code" in end ? (end.code ?? end.state) : end.state))).toEqual([
      "succeeded",
      "provider_rejected",
      "succeeded",
      "provider_outcome_unknown",
      "succeeded",
      "succeeded",
    ]);
    expect(saved.map((row) => [row.key, (row.image as { state: string }).state])).toEqual([
      ["image.0", "succeeded"],
      ["image.1", "failed"],
      ["image.2", "succeeded"],
      ["image.3", "failed"],
      ["image.4", "succeeded"],
      ["image.5", "succeeded"],
    ]);
  });
  it("records an image whose step stopped answering as failed, once", async () => {
    const { deps, saved } = harness();
    expect(await recordLogoImageFailure(deps, concepts, "image.2", "provider_outcome_unknown")).toEqual({
      state: "failed",
      code: "provider_outcome_unknown",
    });
    expect(saved).toEqual([
      { key: "image.2", image: { state: "failed", code: "provider_outcome_unknown" }, responseId: null, cost: 0 },
    ]);
  });
});
