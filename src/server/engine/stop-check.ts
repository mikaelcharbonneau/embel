/**
 * The workflow stop check, declared once (docs/state-machines.md, R3).
 *
 * Every workflow and every engine step that is about to spend, or is waiting on a paid
 * request, asks `engine_check` and passes the answer here. No imports and no Node APIs:
 * the "use workflow" files load this module inside the workflow sandbox.
 *
 * continue  the run is running, nobody asked it to stop and the engine is not paused.
 * quit      the run is not running any more: it ended elsewhere (cancelled, timed out),
 *           or it is gone (`engine_check` answers NULL once an account deletion purged
 *           the run, reported as status "missing"). Nothing is left to finish: end the
 *           work without touching the run.
 * cancel    stop was asked, or the engine is paused: start no paid call and end the run
 *           as cancelled with this code. A pause wins over a stop request, as before.
 *
 * `afterPaidCall` is for the one place a paid result is already in hand and only free
 * work follows (storing and recording a drawn image or board): a pause alone does not
 * throw the paid result away, a stop request or an ended run still does.
 */
export type RunCheckState = { status: string; cancelRequested: boolean; paused: boolean };
export type RunStopDecision =
  | { action: "continue" }
  | { action: "quit"; status: string }
  | { action: "cancel"; code: "cancelled" | "generation_paused" };

export function runStopDecision(
  check: RunCheckState | null | undefined,
  options: { afterPaidCall?: boolean } = {},
): RunStopDecision {
  if (!check) return { action: "quit", status: "missing" };
  if (check.status !== "running") return { action: "quit", status: check.status };
  if (check.paused && !options.afterPaidCall) return { action: "cancel", code: "generation_paused" };
  if (check.cancelRequested) return { action: "cancel", code: "cancelled" };
  return { action: "continue" };
}

/** For steps that only report "stop" with a reason: null means carry on. */
export function stopCode(decision: RunStopDecision): "cancelled" | "generation_paused" | null {
  if (decision.action === "continue") return null;
  return decision.action === "cancel" ? decision.code : "cancelled";
}
