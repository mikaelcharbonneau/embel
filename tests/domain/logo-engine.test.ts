import { describe, expect, it } from "vitest";
import type { GenerationRun } from "@/domain/generations";
import { logoRunEndSentence } from "@/domain/logo-engine";

const run = (over: Partial<GenerationRun>): GenerationRun => ({
  id: "00000000-0000-4000-8000-000000005000",
  kind: "logo.refine",
  status: "failed",
  credits: 1,
  errorCode: null,
  cancelRequested: false,
  createdAt: "2026-11-14T10:00:00.000Z",
  finishedAt: "2026-11-14T10:02:00.000Z",
  inputRevision: 1,
  outputs: [],
  ...over,
});
const returned = "Credits for anything not delivered were returned, so you can try again.";

describe("what the Logo step says about a run that ended without its result", () => {
  it("says nothing without a run, while a run works, or after one that succeeded", () => {
    expect(logoRunEndSentence(null)).toBeNull();
    expect(logoRunEndSentence(run({ status: "queued", finishedAt: null }))).toBeNull();
    expect(logoRunEndSentence(run({ status: "running", finishedAt: null }))).toBeNull();
    // A stop was asked but the run is still working: "Stopping…" is the progress line's job.
    expect(logoRunEndSentence(run({ status: "running", cancelRequested: true, finishedAt: null }))).toBeNull();
    expect(logoRunEndSentence(run({ status: "succeeded" }))).toBeNull();
    // The database keeps the stop request on a run that finished anyway.
    expect(logoRunEndSentence(run({ status: "succeeded", cancelRequested: true }))).toBeNull();
  });

  it("says a stopped refinement was stopped, not that it failed", () => {
    expect(logoRunEndSentence(run({ status: "cancelled", cancelRequested: true }))).toBe(
      "The change to your logo was stopped.",
    );
    // Stopped by a pause rather than by the person: still stopped, still not an error.
    expect(logoRunEndSentence(run({ status: "cancelled" }))).toBe("The change to your logo was stopped.");
  });

  it("says a failed refinement didn’t finish, that credits came back and that it can be tried again", () => {
    expect(logoRunEndSentence(run({ errorCode: "provider_unavailable" }))).toBe(
      `The change to your logo didn’t finish. ${returned}`,
    );
    expect(logoRunEndSentence(run({ errorCode: null }))).toBe(`The change to your logo didn’t finish. ${returned}`);
    expect(logoRunEndSentence(run({ errorCode: "run_timed_out" }))).toBe(
      `The change to your logo took too long and didn’t finish. ${returned}`,
    );
    expect(logoRunEndSentence(run({ errorCode: "start_failed" }))).toBe(
      `The change to your logo couldn’t start. ${returned}`,
    );
  });

  it("speaks for a concepts round only when it drew nothing", () => {
    const concepts = { kind: "logo.concepts", credits: 6 };
    const batch = { key: "batch", output: { batchId: "00000000-0000-4000-8000-000000000300" } };
    expect(logoRunEndSentence(run({ ...concepts, status: "cancelled", outputs: [batch] }))).toBe(
      "Drawing was stopped before any concept was ready.",
    );
    expect(logoRunEndSentence(run({ ...concepts, errorCode: "run_timed_out", outputs: [batch] }))).toBe(
      `Drawing your concepts took too long and didn’t finish. ${returned}`,
    );
    expect(logoRunEndSentence(run({ ...concepts, errorCode: "start_failed" }))).toBe(
      `Drawing your concepts couldn’t start. ${returned}`,
    );
    expect(logoRunEndSentence(run({ ...concepts }))).toBe(`Drawing your concepts didn’t finish. ${returned}`);
    // Some concepts arrived: their cards, and the cards that failed, already say what happened.
    const drew = [batch, { key: "image.2", output: {} }];
    expect(logoRunEndSentence(run({ ...concepts, status: "cancelled", outputs: drew }))).toBeNull();
    expect(logoRunEndSentence(run({ ...concepts, errorCode: "run_timed_out", outputs: drew }))).toBeNull();
  });

  it("says nothing for style notes, which the person never asked for by a click", () => {
    expect(logoRunEndSentence(run({ kind: "logo.style_note" }))).toBeNull();
    expect(logoRunEndSentence(run({ kind: "naming.generate" }))).toBeNull();
  });

  it("never names a price", () => {
    for (const status of ["failed", "cancelled"] as const)
      for (const kind of ["logo.refine", "logo.concepts"])
        expect(logoRunEndSentence(run({ status, kind }))).not.toMatch(/[$€£]|\d/u);
  });
});
