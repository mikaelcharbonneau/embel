import { z } from "zod";

/**
 * The lifecycle of one generation run, declared once (docs/state-machines.md).
 *
 * The database owns the truth: the status column's CHECK constraint lists the
 * statuses, and only three SQL functions move a run (start_generation,
 * engine_claim, finish_generation_run). This file is the TypeScript mirror that
 * every server module, workflow and screen reads, so nobody writes
 * `status === "queued" || status === "running"` by hand again.
 * tests/domain/generation-run.test.ts fails when this file and the migrations disagree.
 */
export const GENERATION_RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export const generationRunStatusSchema = z.enum(GENERATION_RUN_STATUSES);
export type GenerationRunStatus = (typeof GENERATION_RUN_STATUSES)[number];

/** Work is admitted or under way: the run holds its project-and-kind slot and can be stopped. */
export const ACTIVE_RUN_STATUSES = ["queued", "running"] as const satisfies readonly GenerationRunStatus[];
/** The run is over. Nothing moves it again and its credits are settled. */
export const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly GenerationRunStatus[];
export type ActiveRunStatus = (typeof ACTIVE_RUN_STATUSES)[number];
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

/**
 * Which status may follow which, and the SQL function that makes the move.
 *
 * queued    -> running    engine_claim (the workflow picked the run up)
 * queued    -> cancelled  cancel_generation before a workflow started, or engine_claim while paused
 * queued    -> failed     expire_overdue_generation_runs (start_failed after 10 minutes)
 * running   -> succeeded  engine_finish
 * running   -> failed     engine_finish, or expire_overdue_generation_runs (run_timed_out)
 * running   -> cancelled  engine_finish after a stop request or a pause
 *
 * A stop request is not a status. cancel_generation only sets cancel_requested_at;
 * the run stays queued or running until the workflow notices (see runPhase).
 */
export const GENERATION_RUN_TRANSITIONS = Object.freeze({
  queued: ["running", "cancelled", "failed"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<GenerationRunStatus, readonly GenerationRunStatus[]>);

export function isActiveRunStatus(status: GenerationRunStatus): status is ActiveRunStatus {
  return (ACTIVE_RUN_STATUSES as readonly GenerationRunStatus[]).includes(status);
}
export function isTerminalRunStatus(status: GenerationRunStatus): status is TerminalRunStatus {
  return !isActiveRunStatus(status);
}
export function canRunMove(from: GenerationRunStatus, to: GenerationRunStatus): boolean {
  return (GENERATION_RUN_TRANSITIONS[from] as readonly GenerationRunStatus[]).includes(to);
}

/** The two facts a run's phase is read from, in the browser's shape. */
export type RunLifecycle = { status: GenerationRunStatus; cancelRequested: boolean };

export const isActiveRun = (run: Pick<RunLifecycle, "status">) => isActiveRunStatus(run.status);
/** Stop was asked and the run has not ended yet. The flag alone is not enough:
 * the database keeps cancel_requested_at on a run that has since finished. */
export const isRunStopping = (run: RunLifecycle) => isActiveRunStatus(run.status) && run.cancelRequested;
/** Stop can still be asked: the run is working and nobody asked yet. */
export const canStopRun = (run: RunLifecycle) => isActiveRunStatus(run.status) && !run.cancelRequested;

/** What a run is doing, as one word. "stopping" exists only here: it is an active
 * run with a stop request, which the database stores as two separate columns. */
export type RunPhase = GenerationRunStatus | "stopping";
export function runPhase(run: RunLifecycle): RunPhase {
  return isRunStopping(run) ? "stopping" : run.status;
}

/**
 * What the browser may conclude when a request to start a run is refused, from the
 * HTTP status alone.
 *
 * "final"     nothing was admitted or charged; show the reason and let the person act.
 * "uncertain" a run may exist; look it up before offering Start again.
 *
 * 503 is uncertain on purpose: it usually means generation is switched off, but the
 * start route also answers 503 when a run was admitted and its workflow failed to
 * start. A possibly admitted run is never treated as "nothing happened".
 */
export type StartRefusal = "final" | "uncertain";
const FINAL_START_REFUSALS: readonly number[] = [400, 401, 402, 403, 404, 409, 413, 422, 429];
export function startRefusal(httpStatus: number): StartRefusal {
  return FINAL_START_REFUSALS.includes(httpStatus) ? "final" : "uncertain";
}

/**
 * What a step screen (Naming, Logo, Creative direction) lets the person do, from the
 * run's phase and the last thing that went wrong (docs/state-machines.md, rule 4).
 * The three screens call this one function; each looks its own sentences up by `message`.
 */
export type StepProblem =
  /** The start request was refused (`httpStatus`) or never answered (`null`). */
  | { during: "start"; httpStatus: number | null }
  | { during: "stop" }
  /** The first read failed, so the screen has nothing to show yet. */
  | { during: "load" }
  /** A later status check failed. */
  | { during: "check" };
export type StepMessageKind =
  | "stopping"
  | "updates_delayed"
  | "stop_unconfirmed"
  | "load_failed"
  | "out_of_credits"
  | "daily_limit"
  | "start_refused"
  | "start_unconfirmed";
export type StepSituation = {
  /** The newest run as the server reports it, or null when there is none. */
  phase: RunPhase | null;
  /** The first read has answered. */
  loaded: boolean;
  problem: StepProblem | null;
  /** A request this tab sent that has not been answered yet. */
  sending?: "start" | "stop" | null;
};
export type StepView = {
  /** Show progress: a run is working, or a start was just sent. */
  working: boolean;
  /** Stop was asked (the server says so, or this tab's Stop is on its way): say so, never offer Stop again. */
  stopping: boolean;
  canStop: boolean;
  /** A new request may be started. False while one is unconfirmed: only Try again may repeat it. */
  canStart: boolean;
  /** What Try again repeats, or null when there is nothing to repeat or it would be refused again. */
  retry: "start" | "stop" | "load" | null;
  /** The start may have been admitted: keep the request and its key, so Try again returns the run it started. */
  keepRequest: boolean;
  message: StepMessageKind | null;
};

/** The order of the checks is the priority. */
export function stepView({ phase, loaded, problem, sending = null }: StepSituation): StepView {
  const active = phase === "stopping" || (phase !== null && isActiveRunStatus(phase));
  const view: StepView = {
    working: false,
    stopping: false,
    canStop: false,
    canStart: false,
    retry: null,
    keepRequest: false,
    message: null,
  };
  if (active) {
    // A run is working: it never looks ended, whatever failed around it.
    const stopping = phase === "stopping" || sending === "stop";
    const stopFailed = !stopping && problem?.during === "stop";
    const delayed = problem?.during === "check" || problem?.during === "load";
    return {
      ...view,
      working: true,
      stopping,
      canStop: !stopping,
      retry: stopFailed ? "stop" : null,
      message: stopFailed ? "stop_unconfirmed" : delayed ? "updates_delayed" : stopping ? "stopping" : null,
    };
  }
  if (sending === "start") return { ...view, working: true };
  if (problem?.during === "start") {
    if (problem.httpStatus === null || startRefusal(problem.httpStatus) === "uncertain")
      return { ...view, retry: "start", keepRequest: true, message: "start_unconfirmed" };
    // Nothing started. Credits and today's limit would refuse the same request again, so no Try again.
    if (problem.httpStatus === 402) return { ...view, canStart: loaded, message: "out_of_credits" };
    if (problem.httpStatus === 429) return { ...view, canStart: loaded, message: "daily_limit" };
    return { ...view, canStart: loaded, retry: "start", message: "start_refused" };
  }
  if (problem?.during === "load") return { ...view, canStart: loaded, retry: "load", message: "load_failed" };
  // A failed Stop or check with no run working needs no words: the next check shows what is true.
  return { ...view, canStart: loaded };
}
