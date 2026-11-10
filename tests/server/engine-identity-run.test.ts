import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createIdentitySpecificationRequest, identityBoardPrompt } from "../../src/server/ai/identity-direction-requests";
import { ENGINE_IDENTITY_POLICY_IDENTITY, ENGINE_IDENTITY_TEXT_POLICY } from "../../src/server/engine/identity-input";
import {
  createSpecification, drawBoard, prepareSpecification, readIdentityRound, recordBoardFailure, settleSpecification, specificationFromResponse, stopSpecification,
  type ClaimedIdentityRun, type IdentityRunDeps,
} from "../../src/server/engine/identity-run";
import { EngineProviderError, type BackgroundResponse, type EngineOpenAI } from "../../src/server/engine/openai";
import { ENGINE_BOARD_IMAGE, EngineImageRejectedError, type EngineImageReply, type EngineImages } from "../../src/server/engine/openai-images";
import { EngineStorageError, type EngineStorage } from "../../src/server/engine/storage";
import { boardSpecification, hash, id, ownerId, projectId, response as specificationResponse, selectedLogoJobInput } from "../fixtures/identity-generation";

// Synthetic OpenAI, Storage and database only; no live inference.
const runId = "cccccccc-3333-4333-8333-333333333333", jobId = id(31);
const logoBytes = new Uint8Array([137, 80, 78, 71, 9, 9, 9]);
const shared = selectedLogoJobInput(logoBytes);
if (shared.version !== 3) throw new Error("Expected the selected-logo fixture");
const sourceLogo = shared.sourceLogo;
const job = { ...shared, policyIdentity: ENGINE_IDENTITY_POLICY_IDENTITY, textPolicy: ENGINE_IDENTITY_TEXT_POLICY };
const run: ClaimedIdentityRun = { id: runId, ownerId, projectId, kind: "identity.directions", input: { version: 1, revision: 1, batchId: job.batchId, jobId } };
const board = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const drawn = (cost = 190_000): EngineImageReply => ({ kind: "image", bytes: board, providerRequestId: "req_board", responseHash: hash("reply"), usage: null, costMicrousd: cost });
const responseBody = (spec = boardSpecification(1)) => specificationResponse(spec).body;
const background = (status: BackgroundResponse["status"], body: unknown = { status }): BackgroundResponse => ({ id: "resp_synthetic", status, body, requestId: null });

function harness(options: { begin?: unknown; replies?: (EngineImageReply | Error)[]; marked?: boolean | Error; size?: number; stopped?: boolean; put?: (Error | null)[];
  stored?: Record<string, Uint8Array>; tokens?: number; create?: BackgroundResponse | Error; retrieve?: BackgroundResponse } = {}) {
  const replies = [...(options.replies ?? [drawn()])], puts = [...(options.put ?? [])];
  const boards: { ordinal: number; board: Record<string, unknown>; responseId: string | null; cost: number }[] = [];
  const outputs: { key: string; output: unknown; responseId: string | null; cost: number }[] = [];
  const draws: { prompt: string; images: string[]; profile: unknown }[] = [], reads: string[] = [], written: string[] = [], created: string[] = [], cancelled: string[] = [];
  const images: EngineImages = { async draw(input) {
    draws.push({ prompt: input.prompt, images: input.images.map(image => image.reference.versionId), profile: input.profile });
    const next = replies.shift()!; if (next instanceof Error) throw next; return next;
  } };
  const storage: EngineStorage = {
    async put(owner, target) {
      const error = puts.shift(); if (error) throw error;
      if (target.ownerId !== owner.ownerId || target.projectId !== owner.projectId) throw new EngineStorageError("storage_path_refused");
      written.push(`${target.ownerId}/${target.projectId}/${target.assetId}/${target.versionId}`);
    },
    async get(owner, target) {
      if (target.ownerId !== owner.ownerId || target.projectId !== owner.projectId) throw new EngineStorageError("storage_path_refused");
      reads.push(`${target.ownerId}/${target.projectId}/${target.assetId}/${target.versionId}`);
      const bytes = (options.stored ?? { [sourceLogo.preview.reference.versionId]: logoBytes })[target.versionId];
      if (!bytes) throw new EngineStorageError("storage_not_found");
      return { bytes, mimeType: "image/png" };
    },
  };
  const openai: EngineOpenAI = {
    countInputTokens: async () => options.tokens ?? 4_000,
    async create(_request, key) { created.push(key); const answer = options.create ?? background("queued"); if (answer instanceof Error) throw answer; return answer; },
    retrieve: async () => options.retrieve ?? background("completed", responseBody()),
    async cancel(responseId) { cancelled.push(responseId); return background("cancelled", { usage: { input_tokens: 10, output_tokens: 0 } }); },
  };
  let ids = 0;
  const deps: IdentityRunDeps = {
    images, storage, openai, now: () => new Date("2026-11-09T20:00:00.000Z"), newId: () => `99999999-8888-4888-8888-${String(++ids).padStart(12, "0")}`,
    inspect: async () => ({ width: options.size ?? 1024, height: options.size ?? 1024 }),
    db: {
      check: async () => ({ status: "running", cancelRequested: options.stopped ?? false, paused: false }),
      begin: async () => options.begin ?? { batchId: job.batchId, jobId, job, pending: [1, 2, 3], prior: [] },
      async saveOutput(_run, key, output, responseId, cost) {
        if (key.startsWith("sent.") && options.marked instanceof Error) throw options.marked;
        outputs.push({ key, output, responseId, cost });
        return key.startsWith("sent.") ? options.marked !== false : true;
      },
      async saveBoard(_run, ordinal, value, responseId, cost) {
        boards.push({ ordinal, board: value as Record<string, unknown>, responseId, cost });
        const saved = value as { state: string; code?: string };
        return { state: saved.state, ...(saved.code ? { code: saved.code } : {}) };
      },
    },
  };
  return { deps, boards, outputs, draws, reads, written, created, cancelled };
}

describe("the frozen round", () => {
  it("reads the batch's job input under the engine's selected-logo policy", async () => {
    const { deps } = harness();
    expect((await readIdentityRound(deps, run)).job).toMatchObject({ version: 3, batchId: job.batchId, policyIdentity: ENGINE_IDENTITY_POLICY_IDENTITY });
  });
  it.each([
    ["another kind", { ...run, kind: "logo.concepts" }, undefined],
    ["another owner", { ...run, ownerId: id(900) }, undefined],
    ["another batch", run, { batchId: id(901), jobId, job, pending: [1], prior: [] }],
    ["the shared worker's policy", run, { batchId: job.batchId, jobId, job: shared, pending: [1], prior: [] }],
  ])("refuses %s", async (_label, claimed, begin) => {
    await expect(readIdentityRound(harness({ begin }).deps, claimed as ClaimedIdentityRun)).rejects.toThrow("invalid_run_input");
  });
});

describe("a direction's specification", () => {
  it("sends the specification request with the round's earlier directions as prior systems", async () => {
    const prior = [boardSpecification(1).components];
    const prepared = await prepareSpecification(harness().deps, run, 2, prior);
    expect(prepared).toMatchObject({ ordinal: 2, requestKey: `identity-${runId}-spec-2` });
    const expected = createIdentitySpecificationRequest(job.input, prior.map(components => ({ components })), 2, ENGINE_IDENTITY_TEXT_POLICY, job.sourceLogo);
    expect("request" in prepared && prepared.request).toEqual(expected);
  });
  it("fails a direction whose input is too large before any paid call", async () => {
    const { deps, created } = harness({ tokens: ENGINE_IDENTITY_TEXT_POLICY.maxInputTokens + 1 });
    expect(await prepareSpecification(deps, run, 1, [])).toEqual({ ordinal: 1, failed: "input_too_large" });
    expect(created).toEqual([]);
  });
  it("marks each try as sent before the one create, and never sends a started try again", async () => {
    const first = harness(), prepared = await prepareSpecification(first.deps, run, 1, []) as Extract<Awaited<ReturnType<typeof prepareSpecification>>, { request: unknown }>;
    expect(await createSpecification(first.deps, run, prepared, 1)).toEqual({ state: "sent", responseId: "resp_synthetic" });
    expect(first.outputs.map(output => output.key)).toEqual(["sent.spec.1.1"]);
    expect(first.created).toEqual([`identity-${runId}-spec-1-1`]);
    const replay = harness({ marked: false });
    expect(await createSpecification(replay.deps, run, prepared, 1)).toEqual({ state: "failed", code: "send_interrupted" });
    expect(replay.created).toEqual([]);
  });
  it.each([
    ["a 429 asks for another try", new EngineProviderError("retry", 429, 5_000), { state: "retry", retryAfterMs: 5_000 }],
    ["a refusal fails the direction", new EngineProviderError("rejected", 400), { state: "failed", code: "provider_rejected" }],
    ["an unknown outcome is never sent again", new EngineProviderError("uncertain", 504), { state: "failed", code: "send_interrupted" }],
  ])("%s", async (_label, error, expected) => {
    const { deps } = harness({ create: error }), prepared = await prepareSpecification(deps, run, 1, []) as Extract<Awaited<ReturnType<typeof prepareSpecification>>, { request: unknown }>;
    expect(await createSpecification(deps, run, prepared, 1)).toEqual(expected);
  });
  it("saves a usable specification with its response id and cost", async () => {
    const { deps, outputs } = harness();
    const settled = await settleSpecification(deps, run, 1, 1, "resp_synthetic", []);
    expect(settled).toEqual({ state: "ready", specification: boardSpecification(1) });
    expect(outputs).toEqual([{ key: "spec.1.1", output: { state: "ready", specification: boardSpecification(1) }, responseId: "resp_synthetic", cost: expect.any(Number) }]);
    expect(outputs[0]!.cost).toBeGreaterThan(0);
  });
  it("keeps an unusable reply's usage and lets the workflow try once more", async () => {
    const unsupported = boardSpecification(1); unsupported.components.typography.styles[0]!.family = "Comic Sans";
    const duplicate = boardSpecification(1);
    expect(specificationFromResponse(responseBody(unsupported), job.sourceLogo.brief.payload.name, [])).toEqual({ code: "invalid_output" });
    expect(specificationFromResponse(responseBody(duplicate), job.sourceLogo.brief.payload.name, [duplicate.components])).toEqual({ code: "duplicate_identity_direction" });
    expect(specificationFromResponse({ ...responseBody(), model: "gpt-other" }, "Logo fixture", [])).toEqual({ code: "invalid_output" });
    const { deps, outputs } = harness({ retrieve: background("completed", responseBody(unsupported)) });
    expect(await settleSpecification(deps, run, 1, 1, "resp_synthetic", [])).toEqual({ state: "invalid", code: "invalid_output" });
    expect(outputs[0]).toMatchObject({ key: "spec.1.1", output: { state: "invalid", code: "invalid_output" } });
  });
  it("fails a direction whose response failed, and stops an open response at OpenAI", async () => {
    const failed = harness({ retrieve: background("failed", { status: "failed" }) });
    expect(await settleSpecification(failed.deps, run, 2, 1, "resp_synthetic", [])).toEqual({ state: "failed", code: "provider_failed" });
    const stopped = harness();
    expect(await stopSpecification(stopped.deps, run, 2, 1, "resp_open", "cancelled")).toEqual({ state: "stopped" });
    expect(stopped.cancelled).toEqual(["resp_open"]);
    expect(stopped.outputs[0]).toMatchObject({ key: "spec.2.1", output: { state: "stopped", code: "cancelled" }, responseId: "resp_open" });
    expect(await stopSpecification(harness().deps, run, 2, 1, "resp_open", "provider_timeout")).toEqual({ state: "failed", code: "provider_timeout" });
  });
});

describe("a direction's board", () => {
  it("reads the chosen logo from the owner's path, draws once with the board request and records it under the owner's path", async () => {
    const { deps, boards, draws, reads, written, outputs } = harness();
    expect(await drawBoard(deps, run, 1, boardSpecification(1), 1)).toEqual({ state: "succeeded", code: null });
    const logo = shared.sourceLogo.preview.reference;
    expect(reads).toEqual([`${ownerId}/${projectId}/${logo.assetId}/${logo.versionId}`]);
    expect(outputs.map(output => output.key)).toEqual(["sent.board.1.1"]);
    expect(draws).toEqual([{ prompt: identityBoardPrompt("Logo fixture", boardSpecification(1), true), images: [logo.versionId], profile: ENGINE_BOARD_IMAGE }]);
    expect(written).toEqual([`${ownerId}/${projectId}/99999999-8888-4888-8888-000000000001/99999999-8888-4888-8888-000000000002`]);
    expect(boards).toEqual([{ ordinal: 1, responseId: "req_board", cost: 190_000, board: { state: "succeeded",
      image: { assetId: "99999999-8888-4888-8888-000000000001", versionId: "99999999-8888-4888-8888-000000000002", mimeType: "image/png", byteLength: board.byteLength, contentHash: hash(board) },
      specification: { components: boardSpecification(1).components, applicationDesign: boardSpecification(1).applicationDesign },
      provider: { model: "gpt-image-2.6-sunburst", providerRequestId: "req_board", responseHash: hash("reply") } } }]);
  });
  it("asks for another try when nothing was drawn, and records nothing", async () => {
    const { deps, boards } = harness({ replies: [new EngineProviderError("retry", 429, 2_000)] });
    expect(await drawBoard(deps, run, 2, boardSpecification(2), 1)).toEqual({ state: "retry", retryAfterMs: 2_000 });
    expect(boards).toEqual([]);
  });
  it("never sends a started try again", async () => {
    const { deps, boards, draws } = harness({ marked: false });
    expect(await drawBoard(deps, run, 2, boardSpecification(2), 2)).toMatchObject({ state: "failed", code: "provider_outcome_unknown" });
    expect(draws).toEqual([]);
    expect(boards[0]).toMatchObject({ ordinal: 2, board: { state: "failed", code: "provider_outcome_unknown" } });
  });
  it.each([
    ["a refusal, with its usage", new EngineImageRejectedError(400, "req_refused", 1_200), "provider_rejected", 1_200],
    ["an unknown outcome", new EngineProviderError("uncertain", 504), "provider_outcome_unknown", 0],
  ])("fails the direction on %s", async (_label, error, code, cost) => {
    const { deps, boards } = harness({ replies: [error] });
    expect(await drawBoard(deps, run, 3, boardSpecification(3), 1)).toEqual({ state: "failed", code });
    expect(boards[0]).toMatchObject({ ordinal: 3, cost, board: { state: "failed", code } });
  });
  it("keeps the usage of a board that is unusable or arrives after Stop, and stores no file", async () => {
    const wrong = harness({ size: 512 });
    expect(await drawBoard(wrong.deps, run, 1, boardSpecification(1), 1)).toEqual({ state: "failed", code: "invalid_dimensions" });
    expect(wrong.boards[0]).toMatchObject({ cost: 190_000 });
    const stopped = harness({ stopped: true });
    expect(await drawBoard(stopped.deps, run, 1, boardSpecification(1), 1)).toEqual({ state: "failed", code: "run_stopped" });
    expect([...wrong.written, ...stopped.written]).toEqual([]);
  });
  it("fails a direction whose chosen logo is gone, and retries a passing Storage outage", async () => {
    const gone = harness({ stored: {} });
    expect(await drawBoard(gone.deps, run, 1, boardSpecification(1), 1)).toEqual({ state: "failed", code: "source_unavailable" });
    expect(gone.draws).toEqual([]);
    const unavailable = harness();
    unavailable.deps.storage.get = async () => { throw new EngineStorageError("storage_unavailable"); };
    expect(await drawBoard(unavailable.deps, run, 1, boardSpecification(1), 1)).toEqual({ state: "retry", retryAfterMs: null });
  });
  it("records a direction without a board once, with a safe reason", async () => {
    const { deps, boards } = harness();
    expect(await recordBoardFailure(deps, run, 2, "Not A Code")).toEqual({ state: "failed", code: "generation_failed" });
    expect(boards).toEqual([{ ordinal: 2, board: { state: "failed", code: "generation_failed" }, responseId: null, cost: 0 }]);
  });
});
