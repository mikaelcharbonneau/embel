import { describe, expect, it } from "vitest";
import { stepView, type StepProblem } from "@/domain/generation-run";

// One answer for Naming, Logo and Creative direction (docs/state-machines.md, "The same server situation").
const idle = { phase: null, loaded: true, problem: null } as const;
const start = (httpStatus: number | null): StepProblem => ({ during: "start", httpStatus });

describe("what a step screen lets the person do", () => {
  it("offers Start only once the first read answered and nothing is working", () => {
    expect(stepView(idle)).toMatchObject({
      working: false,
      canStart: true,
      canStop: false,
      retry: null,
      message: null,
    });
    expect(stepView({ ...idle, loaded: false }).canStart).toBe(false);
    for (const phase of ["succeeded", "failed", "cancelled"] as const)
      expect(stepView({ ...idle, phase })).toMatchObject({ working: false, canStart: true, canStop: false });
    for (const phase of ["queued", "running"] as const)
      expect(stepView({ ...idle, phase })).toMatchObject({ working: true, canStart: false, canStop: true });
    expect(stepView({ ...idle, sending: "start" })).toMatchObject({ working: true, canStart: false, canStop: false });
  });

  it("says stopping and never offers Stop again, from the server's state or this tab's request", () => {
    for (const view of [
      stepView({ ...idle, phase: "stopping" }),
      stepView({ ...idle, phase: "running", sending: "stop" }),
    ])
      expect(view).toMatchObject({ working: true, stopping: true, canStop: false, retry: null, message: "stopping" });
    // A Stop that failed here but reached the server is simply stopping.
    expect(stepView({ ...idle, phase: "stopping", problem: { during: "stop" } }).message).toBe("stopping");
  });

  it("offers Try again when Stop couldn't be confirmed and the run still works", () => {
    expect(stepView({ ...idle, phase: "running", problem: { during: "stop" } })).toMatchObject({
      working: true,
      canStop: true,
      retry: "stop",
      message: "stop_unconfirmed",
    });
    // The run ended meanwhile: nothing left to stop or to say.
    expect(stepView({ ...idle, phase: "cancelled", problem: { during: "stop" } })).toMatchObject({
      retry: null,
      message: null,
    });
  });

  it("keeps progress and Stop when a status check fails while the run works", () => {
    for (const during of ["check", "load"] as const)
      for (const phase of ["queued", "running"] as const)
        expect(stepView({ ...idle, phase, problem: { during } })).toMatchObject({
          working: true,
          canStop: true,
          retry: null,
          message: "updates_delayed",
        });
    expect(stepView({ ...idle, phase: "stopping", problem: { during: "check" } })).toMatchObject({
      working: true,
      stopping: true,
      canStop: false,
      message: "updates_delayed",
    });
    // With nothing working a failed check is quiet; the screen keeps checking.
    expect(stepView({ ...idle, problem: { during: "check" } })).toMatchObject({ message: null, canStart: true });
  });

  it("says a first load failed, with Try again", () => {
    expect(stepView({ phase: null, loaded: false, problem: { during: "load" } })).toMatchObject({
      working: false,
      canStart: false,
      retry: "load",
      message: "load_failed",
    });
  });

  it("offers no Try again that would be refused again: credits and today's limit", () => {
    expect(stepView({ ...idle, problem: start(402) })).toMatchObject({
      retry: null,
      keepRequest: false,
      message: "out_of_credits",
    });
    expect(stepView({ ...idle, problem: start(429) })).toMatchObject({
      // Today's limit has no end the browser knows: no new start until the screen clears the problem.
      canStart: false,
      retry: null,
      keepRequest: false,
      message: "daily_limit",
    });
    // Credits can come back (a new period, a plan): the screen's own balance read decides, not this.
    expect(stepView({ ...idle, problem: start(402) }).canStart).toBe(true);
  });

  it("shows the reason for any other final refusal and lets the person ask again", () => {
    for (const status of [400, 401, 403, 404, 409, 413, 422])
      expect(stepView({ ...idle, problem: start(status) })).toMatchObject({
        canStart: true,
        retry: "start",
        keepRequest: false,
        message: "start_refused",
      });
  });

  it("says a switched-off step is unavailable, with no Try again that would be refused at once", () => {
    expect(
      stepView({ ...idle, problem: { during: "start", httpStatus: 503, code: "generation_unavailable" } }),
    ).toMatchObject({
      working: false,
      // Nothing was admitted, so nothing is kept; the person can simply ask again later.
      canStart: true,
      retry: null,
      keepRequest: false,
      message: "unavailable",
    });
    // An admitted run whose workflow did not start, or a 503 with another code or none, stays unconfirmed.
    for (const code of ["start_unconfirmed", "integration_unavailable", null, undefined])
      expect(stepView({ ...idle, problem: { during: "start", httpStatus: 503, code } })).toMatchObject({
        canStart: false,
        retry: "start",
        keepRequest: true,
        message: "start_unconfirmed",
      });
  });

  it("keeps an unconfirmed request: only Try again, with the same key, until the run is found", () => {
    for (const status of [null, 408, 500, 502, 503])
      expect(stepView({ ...idle, problem: start(status) })).toMatchObject({
        working: false,
        canStart: false,
        retry: "start",
        keepRequest: true,
        message: "start_unconfirmed",
      });
    // The run it started is visible: the question is settled.
    expect(stepView({ ...idle, phase: "running", problem: start(503) })).toMatchObject({
      working: true,
      retry: null,
      message: null,
    });
  });
});
