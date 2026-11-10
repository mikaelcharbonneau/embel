import { getWorkflowMetadata, sleep } from "workflow";
import type { IdentitySystemSpecification } from "@/domain/identity-jobs";
import { checkRun, claimRun, finishRun, type ClaimedRun } from "./engine-steps";
import {
  beginIdentityDirections,
  createSpecification,
  drawBoard,
  pollSpecification,
  prepareSpecification,
  recordBoardFailure,
  settleSpecification,
  stopSpecification,
} from "./identity-steps";

type Components = IdentitySystemSpecification["components"];
/** Tries per call while nothing was sent (429, 5xx, no connection). */
const SEND_TRIES = 3;
/** Paid tries of one specification whose reply was unusable. */
const PAID_TRIES = 2;
/** How often a running round checks for Stop while its boards are drawn. */
const WATCH_SECONDS = 4;
/** Seconds between specification lookups: quick at first, then every 5 s, for at most
 * 4 minutes (the text policy's deadline). */
const POLL_DELAYS = [2, 3, 4, ...Array.from({ length: 46 }, () => 5)];

type End = { state: string; code?: string | null };
type Specified =
  | { state: "ready"; specification: IdentitySystemSpecification }
  | { state: "failed"; code: string }
  | { state: "stopped" };
const errorCode = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z_]{1,64}$/u.test(message) ? message : "generation_failed";
};
/** Milliseconds to wait before another try: what OpenAI asked for, or 4 s, 8 s; 1 to 60 s. */
const backoff = (attempt: number, retryAfterMs: number | null) =>
  Math.ceil(Math.max(1000, Math.min(retryAfterMs ?? 2 ** attempt * 2000, 60_000)) / 1000) * 1000;

/**
 * Makes one Creative directions round (kind identity.directions): three distinct
 * directions around the chosen logo. Each specification sees the round's earlier
 * ones, so they are written in turn; then the three boards are drawn at once, each
 * in its own steps. (A workflow invocation runs the steps it starts together and
 * waits for all of them, so a board started beside the next specification would
 * hold that specification back for as long as the board takes.) A failed direction
 * doesn't lose the others, and each board shows as soon as it is saved. Stop ends
 * the round within seconds; credits are kept only for delivered boards.
 */
export async function identityDirectionsGeneration(runId: string) {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  const run = await claimRun(runId, workflowRunId);
  if (run.status !== "running") return { status: run.status };
  try {
    const { pending, prior: saved } = await beginIdentityDirections(run);
    const prior: Components[] = [...saved];
    const specified: { ordinal: number; result: Specified }[] = [];
    let stopped = false;
    for (const ordinal of pending) {
      const result = await specify(run, ordinal, prior);
      if (result.state === "stopped") {
        stopped = true;
        break;
      }
      if (result.state === "ready") prior.push(result.specification.components);
      specified.push({ ordinal, result });
    }
    if (stopped) {
      const state = await checkRun(runId);
      if (state.status !== "running") return { status: state.status };
      return await finishRun(runId, "cancelled", state.paused ? "generation_paused" : "cancelled");
    }
    const boards: Promise<End>[] = specified.map(({ ordinal, result }) =>
      result.state === "ready"
        ? drawUntilSettled(run, ordinal, result.specification)
        : recordBoardFailure(run, ordinal, result.state === "failed" ? result.code : "generation_failed"),
    );
    let settled = false;
    const work = Promise.all(boards).then((ends) => {
      settled = true;
      return ends;
    });
    // After Stop the round returns early; boards still being drawn finish on their own.
    work.catch(() => undefined);
    while (!settled) {
      await Promise.race([work, sleep(`${WATCH_SECONDS}s`)]);
      if (settled) break;
      const state = await checkRun(runId);
      if (state.status !== "running") return { status: state.status };
      if (state.cancelRequested || state.paused)
        return await finishRun(runId, "cancelled", state.paused ? "generation_paused" : "cancelled");
    }
    const ends = await work;
    const state = await checkRun(runId);
    if (state.status !== "running") return { status: state.status };
    if (state.cancelRequested || state.paused)
      return await finishRun(runId, "cancelled", state.paused ? "generation_paused" : "cancelled");
    // The database keeps a credit per delivered board; a round with none fails with its first reason.
    const reason = ends.find((end) => end.state !== "succeeded")?.code ?? null;
    return await finishRun(runId, "succeeded", reason && /^[a-z_]{1,64}$/u.test(reason) ? reason : null);
  } catch (error) {
    await finishRun(runId, "failed", errorCode(error));
    throw error;
  }
}

/**
 * One direction's specification: up to three tries while nothing was sent, at most
 * two paid tries when a reply was unusable, and never another try after a create
 * whose outcome is unknown.
 */
async function specify(run: ClaimedRun, ordinal: number, prior: Components[]): Promise<Specified> {
  const prepared = await prepareSpecification(run, ordinal, prior);
  if ("failed" in prepared) return { state: "failed", code: prepared.failed };
  let paid = 0,
    last = "provider_unavailable";
  for (let attempt = 1; attempt <= SEND_TRIES; attempt++) {
    // No paid call starts after a Stop or while the engine is paused.
    const state = await checkRun(run.id);
    if (state.status !== "running" || state.cancelRequested || state.paused) return { state: "stopped" };
    const sent = await createSpecification(run, prepared, attempt);
    if (sent.state === "stopped") return sent;
    if (sent.state === "failed") return sent;
    if (sent.state === "retry") {
      if (attempt < SEND_TRIES) await sleep(backoff(attempt, sent.retryAfterMs));
      continue;
    }
    let polled: { state: string; code?: string } = { state: "pending" };
    for (const seconds of POLL_DELAYS) {
      await sleep(`${seconds}s`);
      polled = await pollSpecification(run.id, sent.responseId);
      if (polled.state !== "pending") break;
    }
    if (polled.state === "stop")
      return (await stopSpecification(run, ordinal, attempt, sent.responseId, polled.code ?? "cancelled")) as Specified;
    if (polled.state === "pending")
      return (await stopSpecification(run, ordinal, attempt, sent.responseId, "provider_timeout")) as Specified;
    const settled = await settleSpecification(run, ordinal, attempt, sent.responseId, prior);
    if (settled.state !== "invalid") return settled;
    last = settled.code;
    if (++paid >= PAID_TRIES) return { state: "failed", code: last };
  }
  return { state: "failed", code: last };
}

/** One board: up to three tries while nothing is drawn, never another after a send. */
async function drawUntilSettled(
  run: ClaimedRun,
  ordinal: number,
  specification: IdentitySystemSpecification,
): Promise<End> {
  for (let attempt = 1; attempt <= SEND_TRIES; attempt++) {
    const state = await checkRun(run.id);
    if (state.status !== "running" || state.cancelRequested || state.paused)
      return { state: "stopped", code: "cancelled" };
    let result;
    try {
      result = await drawBoard(run, ordinal, specification, attempt);
    } catch {
      // The step stopped answering after it may have sent the board.
      return recordBoardFailure(run, ordinal, "provider_outcome_unknown");
    }
    if (result.state !== "retry") return result;
    if (attempt < SEND_TRIES) await sleep(backoff(attempt, result.retryAfterMs));
  }
  return recordBoardFailure(run, ordinal, "provider_unavailable");
}
