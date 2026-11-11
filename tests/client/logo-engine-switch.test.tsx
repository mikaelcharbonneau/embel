// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGenerationEstimate, type LogoEngineStarter } from "@/components/logo-creation/use-generation-estimate";
import { logoDrawingSlotIds, logoRefineRequestStatus, logoRunBatchId, logoUndrawnSlotIds } from "@/domain/logo-engine";
import type { GenerationRun } from "@/domain/generations";
import type { LogoConceptBatch, LogoRunRequest } from "@/domain/logo-jobs";

// The Logo screens start work on the generation engine; with its Logo kinds off nothing starts.
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const heads = {
  projectRevision: 1,
  referenceRevision: 0,
  preferencesRevision: 0,
  workspaceRevision: 1,
  stageRevisions: { brief_references: 1, concepts: 0, vector: 0, refinements: 0, directions: 0, deliverables: 0 },
};
const request: LogoRunRequest = {
  operation: "concepts",
  expected: heads,
  briefRevisionId: "eeeeeeee-5555-4555-8555-555555555555",
  referenceSnapshotId: "eeeeeeee-5555-4555-8555-555555555556",
};
const probe: { current: ReturnType<typeof useGenerationEstimate> | null } = { current: null };
function Probe({ value, engine }: { value: LogoRunRequest | null; engine: LogoEngineStarter | null }) {
  const estimate = useGenerationEstimate(value, engine);
  useLayoutEffect(() => {
    probe.current = estimate;
  });
  return null;
}
async function render(value: LogoRunRequest | null, engine: LogoEngineStarter | null) {
  await act(async () => root.render(createElement(Probe, { value, engine })));
}

describe("starting Logo work", () => {
  it("starts nothing while the Logo kinds are turned off: there is no other path", async () => {
    await render(request, null);
    expect(probe.current).toMatchObject({ canStart: false, busy: false, enabled: false, error: null });
    probe.current!.start();
  });
  it("starts the engine run with one click while the Logo kinds are enabled", async () => {
    const start = vi.fn();
    const engine: LogoEngineStarter = { busy: false, error: null, errorKey: null, start, clearError: vi.fn() };
    await render(request, engine);
    expect(probe.current).toMatchObject({ canStart: true, busy: false });
    probe.current!.start();
    expect(start).toHaveBeenCalledWith(request);
  });
  it("holds every action while an engine run works, and explains a refusal only on its own action", async () => {
    const engine: LogoEngineStarter = {
      busy: true,
      error: "You've used this month's credits. Your logos are saved.",
      errorKey: JSON.stringify(request),
      start: vi.fn(),
      clearError: vi.fn(),
    };
    await render(request, engine);
    expect(probe.current).toMatchObject({ canStart: false, busy: true, error: engine.error });
    await render({ ...request, operation: "more_concepts" }, engine);
    expect(probe.current!.error).toBeNull();
  });
});

describe("following an engine round", () => {
  const runId = "cccccccc-3333-4333-8333-333333333333",
    batchId = "ffffffff-6666-4666-8666-666666666666";
  const run = (
    status: GenerationRun["status"],
    outputs: GenerationRun["outputs"],
    kind = "logo.concepts",
  ): GenerationRun => ({
    id: runId,
    kind,
    status,
    credits: 6,
    errorCode: null,
    cancelRequested: false,
    createdAt: "2026-11-09T20:00:00.000Z",
    finishedAt: null,
    inputRevision: 1,
    outputs,
  });
  const slot = (ordinal: number, attempts: { state: string; requestKey: string }[]) => ({
    id: `55555555-8888-4888-8888-00000000000${ordinal}`,
    ordinal,
    attempts,
  });
  const batch = (requestKey: string, slots: ReturnType<typeof slot>[]) =>
    ({ id: batchId, requestKey, slots }) as unknown as LogoConceptBatch;

  it("draws into the batch it opened, and shows each empty slot as drawing until its image is saved", () => {
    const working = run("running", [
      { key: "batch", output: { batchId } },
      { key: "image.2", output: { state: "succeeded" } },
    ]);
    expect(logoRunBatchId(working)).toBe(batchId);
    const own = batch(
      runId,
      [0, 1, 2, 3, 4, 5].map((ordinal) =>
        slot(ordinal, ordinal === 2 ? [{ state: "succeeded", requestKey: runId }] : []),
      ),
    );
    expect([...logoDrawingSlotIds(working, own)].map((id) => Number(id.at(-1)))).toEqual([0, 1, 3, 4, 5]);
    expect(logoDrawingSlotIds(run("succeeded", working.outputs), own).size).toBe(0);
  });
  it("marks the slots a stopped round never drew, and nothing while it still draws", () => {
    const own = batch(runId, [slot(0, [{ state: "succeeded", requestKey: runId }]), slot(1, [])]);
    expect([...logoUndrawnSlotIds(run("cancelled", []), own)]).toEqual(["55555555-8888-4888-8888-000000000001"]);
    expect(logoUndrawnSlotIds(run("running", []), own).size).toBe(0);
  });
  it("retrying draws again only the slots whose last image failed", () => {
    const earlier = batch("dddddddd-4444-4444-8444-444444444444", [
      slot(0, [{ state: "succeeded", requestKey: "x" }]),
      slot(1, [{ state: "failed", requestKey: "x" }]),
    ]);
    expect([...logoDrawingSlotIds(run("running", []), earlier)]).toEqual(["55555555-8888-4888-8888-000000000001"]);
  });
  it("reads a refinement's state in the screen's request words", () => {
    expect(
      ["queued", "running", "succeeded", "failed", "cancelled"].map((status) =>
        logoRefineRequestStatus(run(status as GenerationRun["status"], [], "logo.refine")),
      ),
    ).toEqual(["admitted", "running", "succeeded", "failed", "failed"]);
  });
});
