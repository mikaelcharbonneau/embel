// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGenerationEstimate, type LogoEngineStarter } from "@/components/logo-creation/use-generation-estimate";
import type { LogoCreationController, LogoCreationState } from "@/components/logo-creation/creation-controller";
import { logoDrawingSlotIds, logoRefineRequestStatus, logoRunBatchId } from "@/domain/logo-engine";
import type { GenerationRun } from "@/domain/generations";
import type { LogoConceptBatch, LogoQuoteRequest } from "@/domain/logo-jobs";

// The Logo screens' switch between the old quote-and-admit path and the generation engine.
let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const idle: LogoCreationState = { phase: "idle", quote: null, request: null, error: null };
function controller(estimate: LogoCreationController["estimate"]) {
  return { estimate, start: vi.fn(), getSnapshot: () => idle, subscribe: () => () => undefined } as unknown as LogoCreationController;
}
const heads = { projectRevision: 1, referenceRevision: 0, preferencesRevision: 0, workspaceRevision: 1, stageRevisions: { brief_references: 1, concepts: 0, vector: 0, refinements: 0, directions: 0, deliverables: 0 } };
const request: LogoQuoteRequest = { operation: "concepts", expected: heads, briefRevisionId: "eeeeeeee-5555-4555-8555-555555555555", referenceSnapshotId: "eeeeeeee-5555-4555-8555-555555555556" };
let latest: ReturnType<typeof useGenerationEstimate> | null = null;
function Probe({ creation, value, engine }: { creation: LogoCreationController; value: LogoQuoteRequest | null; engine: LogoEngineStarter | null }) {
  latest = useGenerationEstimate(creation, value, engine);
  return null;
}
async function render(creation: LogoCreationController, value: LogoQuoteRequest | null, engine: LogoEngineStarter | null) {
  await act(async () => root.render(createElement(Probe, { creation, value, engine })));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
}

describe("starting Logo work", () => {
  it("asks for a quote first on the old path", async () => {
    const estimate = vi.fn(async () => { throw new Error("no quote in this test"); });
    await render(controller(estimate), request, null);
    expect(estimate).toHaveBeenCalledTimes(1);
    expect(latest).toMatchObject({ canStart: false, quote: null });
  });
  it("starts the engine run with one click and never asks for a quote while the Logo kinds are enabled", async () => {
    const estimate = vi.fn(), start = vi.fn();
    const engine: LogoEngineStarter = { busy: false, error: null, errorKey: null, start, clearError: vi.fn() };
    await render(controller(estimate), request, engine);
    expect(estimate).not.toHaveBeenCalled();
    expect(latest).toMatchObject({ canStart: true, quote: null, loading: false, busy: false });
    latest!.start();
    expect(start).toHaveBeenCalledWith(request);
  });
  it("holds every action while an engine run works, and explains a refusal only on its own action", async () => {
    const engine: LogoEngineStarter = { busy: true, error: "You've used this month's credits. Your logos are saved.", errorKey: JSON.stringify(request), start: vi.fn(), clearError: vi.fn() };
    await render(controller(vi.fn()), request, engine);
    expect(latest).toMatchObject({ canStart: false, busy: true, error: engine.error });
    await render(controller(vi.fn()), { ...request, operation: "more_concepts" }, engine);
    expect(latest!.error).toBeNull();
  });
});

describe("following an engine round", () => {
  const runId = "cccccccc-3333-4333-8333-333333333333", batchId = "ffffffff-6666-4666-8666-666666666666";
  const run = (status: GenerationRun["status"], outputs: GenerationRun["outputs"], kind = "logo.concepts"): GenerationRun => ({ id: runId, kind, status, credits: 6, errorCode: null,
    cancelRequested: false, createdAt: "2026-11-09T20:00:00.000Z", finishedAt: null, inputRevision: 1, outputs });
  const slot = (ordinal: number, attempts: { state: string; requestKey: string }[]) => ({ id: `55555555-8888-4888-8888-00000000000${ordinal}`, ordinal, attempts });
  const batch = (requestKey: string, slots: ReturnType<typeof slot>[]) => ({ id: batchId, requestKey, slots }) as unknown as LogoConceptBatch;

  it("draws into the batch it opened, and shows each empty slot as drawing until its image is saved", () => {
    const working = run("running", [{ key: "batch", output: { batchId } }, { key: "image.2", output: { state: "succeeded" } }]);
    expect(logoRunBatchId(working)).toBe(batchId);
    const own = batch(runId, [0, 1, 2, 3, 4, 5].map(ordinal => slot(ordinal, ordinal === 2 ? [{ state: "succeeded", requestKey: runId }] : [])));
    expect([...logoDrawingSlotIds(working, own)].map(id => Number(id.at(-1)))).toEqual([0, 1, 3, 4, 5]);
    expect(logoDrawingSlotIds(run("succeeded", working.outputs), own).size).toBe(0);
  });
  it("retrying draws again only the slots whose last image failed", () => {
    const earlier = batch("dddddddd-4444-4444-8444-444444444444", [slot(0, [{ state: "succeeded", requestKey: "x" }]), slot(1, [{ state: "failed", requestKey: "x" }])]);
    expect([...logoDrawingSlotIds(run("running", []), earlier)]).toEqual(["55555555-8888-4888-8888-000000000001"]);
  });
  it("reads a refinement's state in the screen's request words", () => {
    expect(["queued", "running", "succeeded", "failed", "cancelled"].map(status => logoRefineRequestStatus(run(status as GenerationRun["status"], [], "logo.refine"))))
      .toEqual(["admitted", "running", "succeeded", "failed", "failed"]);
  });
});
