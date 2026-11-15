import { describe, expect, it } from "vitest";
import { runStopDecision, stopCode, type RunCheckState } from "../../src/server/engine/stop-check";

// Every combination engine_check can return, and what a workflow does with it (docs/state-machines.md, R3).
const STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"];
const combinations: RunCheckState[] = STATUSES.flatMap((status) =>
  [false, true].flatMap((cancelRequested) => [false, true].map((paused) => ({ status, cancelRequested, paused }))),
);

describe("the workflow stop check", () => {
  it.each(combinations)("decides $status, stop asked $cancelRequested, paused $paused", (check) => {
    const decision = runStopDecision(check);
    if (check.status !== "running") expect(decision).toEqual({ action: "quit", status: check.status });
    else if (check.paused) expect(decision).toEqual({ action: "cancel", code: "generation_paused" });
    else if (check.cancelRequested) expect(decision).toEqual({ action: "cancel", code: "cancelled" });
    else expect(decision).toEqual({ action: "continue" });
  });

  it.each(combinations)(
    "after a paid call, $status, stop asked $cancelRequested, paused $paused: a pause alone discards nothing",
    (check) => {
      const decision = runStopDecision(check, { afterPaidCall: true });
      if (check.status !== "running") expect(decision).toEqual({ action: "quit", status: check.status });
      else if (check.cancelRequested) expect(decision).toEqual({ action: "cancel", code: "cancelled" });
      else expect(decision).toEqual({ action: "continue" });
    },
  );

  it.each([null, undefined])("ends quietly when the run is gone (%s)", (missing) => {
    // engine_check returns NULL once an account deletion purged the run.
    expect(runStopDecision(missing)).toEqual({ action: "quit", status: "missing" });
    expect(runStopDecision(missing, { afterPaidCall: true })).toEqual({ action: "quit", status: "missing" });
  });

  it("only ever lets a paid call start for a running run with no stop request and no pause", () => {
    const allowed = [...combinations, null].filter((check) => runStopDecision(check).action === "continue");
    expect(allowed).toEqual([{ status: "running", cancelRequested: false, paused: false }]);
  });

  it("gives the poll steps one stop code", () => {
    expect(stopCode({ action: "continue" })).toBeNull();
    expect(stopCode({ action: "quit", status: "failed" })).toBe("cancelled");
    expect(stopCode({ action: "quit", status: "missing" })).toBe("cancelled");
    expect(stopCode({ action: "cancel", code: "cancelled" })).toBe("cancelled");
    expect(stopCode({ action: "cancel", code: "generation_paused" })).toBe("generation_paused");
  });
});
