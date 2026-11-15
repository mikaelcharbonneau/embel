import { describe, expect, it } from "vitest";
import type { StrategyJob, StrategyOverview } from "@/domain/strategy-jobs";
import { AccountRequestError } from "@/components/workspace/account-api";
import {
  idleStrategyAction,
  strategyJobsReport,
  strategyRunPhase,
  strategyStartFailure,
  type StrategyAction,
} from "@/components/workspace/strategy-jobs-view";

// Synthetic fixtures: only the fields the view reads matter.
const job = (state: StrategyJob["state"]) => ({ id: state, state }) as StrategyJob;
const overview = (...states: StrategyJob["state"][]) => ({ jobs: states.map(job) }) as unknown as StrategyOverview;
const report = (
  states: StrategyJob["state"][] | null,
  action: Partial<StrategyAction> = {},
  readError: string | null = null,
) =>
  strategyJobsReport({
    overview: states ? overview(...states) : null,
    readError,
    action: { ...idleStrategyAction, ...action },
  });
const start = (httpStatus: number | null) => ({
  during: "start" as const,
  httpStatus,
  sentence: `start ${httpStatus}`,
});

describe("what the Strategy jobs hook reports (J8)", () => {
  it("reads the newest working request as the shared run phase", () => {
    expect(strategyRunPhase([])).toBeNull();
    expect(strategyRunPhase([job("succeeded"), job("failed"), job("needs_reconciliation")])).toBeNull();
    expect(strategyRunPhase([job("succeeded"), job("queued")])).toBe("queued");
    expect(strategyRunPhase([job("running")])).toBe("running");
    expect(strategyRunPhase([job("cancel_requested")])).toBe("stopping");
    // Strategy polls an old partial job as if it were working.
    expect(strategyRunPhase([job("partial")])).toBe("running");
  });

  it("allows a start only once the first status has answered", () => {
    expect(report(null)).toMatchObject({
      pending: false,
      actionError: null,
      view: { canStart: false, working: false },
    });
    expect(report([]).view).toMatchObject({ canStart: true, working: false, message: null, sentence: null });
    expect(report(null, {}, "No status.").view).toMatchObject({
      canStart: false,
      retry: "load",
      message: "load_failed",
      sentence: "No status.",
    });
  });

  it("shows this tab's own request as working until it is answered", () => {
    expect(report([], { sending: "start" })).toMatchObject({
      pending: true,
      pendingLabel: "Submitting your request…",
      view: { working: true, canStart: false, canStop: false },
    });
    expect(report(["running"], { sending: "stop" })).toMatchObject({
      pending: true,
      view: { working: true, stopping: true, canStop: false },
    });
  });

  it("keeps a working run working whatever failed around it", () => {
    expect(report(["running"], {}, "Status could not be checked.").view).toMatchObject({
      working: true,
      canStop: true,
      message: "updates_delayed",
      sentence: "Status could not be checked.",
    });
    expect(report(["running"], { problem: { during: "stop", sentence: "Stop failed." } })).toMatchObject({
      actionError: "Stop failed.",
      view: { working: true, canStop: true, retry: "stop", message: "stop_unconfirmed", sentence: "Stop failed." },
    });
    expect(report(["cancel_requested"]).view).toMatchObject({ stopping: true, canStop: false, message: "stopping" });
  });

  it("offers Try again only where it can help", () => {
    expect(report([], { problem: start(402) }).view).toMatchObject({
      message: "out_of_credits",
      retry: null,
      canStart: true,
      sentence: "start 402",
    });
    expect(report([], { problem: start(429) }).view).toMatchObject({ message: "daily_limit", retry: null });
    expect(report([], { problem: start(409) }).view).toMatchObject({ message: "start_refused", retry: "start" });
    for (const status of [null, 408, 500, 502, 503])
      expect(report([], { problem: start(status) }).view).toMatchObject({
        message: "start_unconfirmed",
        retry: "start",
        keepRequest: true,
        canStart: false,
      });
  });

  it("keeps a message for something that was never sent", () => {
    expect(report([], { problem: { during: "local", sentence: "Your draft changed." } })).toMatchObject({
      actionError: "Your draft changed.",
      view: { canStart: true, retry: null, message: null, sentence: "Your draft changed." },
    });
  });

  it("reads a failed start once: the answer's status and whether a run may exist", () => {
    expect(strategyStartFailure(new AccountRequestError(402))).toEqual({ httpStatus: 402, uncertain: false });
    expect(strategyStartFailure(new AccountRequestError(429))).toEqual({ httpStatus: 429, uncertain: false });
    expect(strategyStartFailure(new AccountRequestError(503))).toEqual({ httpStatus: 503, uncertain: true });
    expect(strategyStartFailure(new TypeError("Failed to fetch"))).toEqual({ httpStatus: null, uncertain: true });
  });
});
