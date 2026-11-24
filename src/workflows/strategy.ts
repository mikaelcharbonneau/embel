import { getWorkflowMetadata, sleep } from "workflow";
import { runStopDecision } from "../server/engine/stop-check";
import type { BriefFileNotes } from "../domain/brief-files";
import { pollFileReading, settleFileReading, startFileReading, stopFileReading } from "./brief-files-steps";
import { checkRun, claimRun, finishRun, type ClaimedRun } from "./engine-steps";
import {
  createStrategyResponse,
  pollStrategyResponse,
  prepareStrategy,
  settleStrategyResponse,
  stopStrategyResponse,
} from "./strategy-steps";

/** One paid attempt, plus one corrective re-prompt when the reply was unusable. */
const MAX_ATTEMPTS = 2;
/** Seconds between lookups: quick at first, then every 5 s, for at most 10 minutes. */
const POLL_DELAYS = [2, 3, 4, ...Array.from({ length: 118 }, () => 5)];
/** Reading attached files: the same rhythm, for at most 3 minutes. */
const FILE_POLL_DELAYS = [2, 3, 4, ...Array.from({ length: 34 }, () => 5)];

/** Runs one Strategy operation (kinds strategy.*) on OpenAI background mode. */
export async function strategyGeneration(runId: string) {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  const run = await claimRun(runId, workflowRunId);
  if (run.status !== "running") return { status: run.status };
  try {
    const prepared = await prepareStrategy(run, await readAttachedFiles(run));
    let correction: { code: string; previousText: string | null } | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // No paid call starts after a cancel or while the engine is paused.
      const stop = runStopDecision(await checkRun(runId));
      if (stop.action === "quit") return { status: stop.status };
      if (stop.action === "cancel") return await finishRun(runId, "cancelled", stop.code);
      const { responseId } = await createStrategyResponse(prepared, attempt, correction);
      const result = await followResponse(run, responseId, attempt);
      if (result.state === "succeeded") return await finishRun(runId, "succeeded", null);
      if (result.state === "stopped") return await finishRun(runId, "cancelled", result.code);
      if (!result.correctable || attempt === MAX_ATTEMPTS) return await finishRun(runId, "failed", result.code);
      correction = { code: result.code, previousText: result.previousText };
    }
    return await finishRun(runId, "failed", "generation_failed");
  } catch (error) {
    // A failed run returns its credits. Codes come from FatalError messages.
    const message = error instanceof Error ? error.message : "";
    await finishRun(runId, "failed", /^[a-z_]{1,64}$/u.test(message) ? message : "generation_failed");
    throw error;
  }
}

/** Sleeps and polls until the response finishes, the run is stopped, or time runs out. */
async function followResponse(run: ClaimedRun, responseId: string, attempt: number) {
  for (const seconds of POLL_DELAYS) {
    await sleep(`${seconds}s`);
    const polled = await pollStrategyResponse(run.id, responseId);
    if (polled.state === "terminal") return settleStrategyResponse(run, responseId, attempt);
    if (polled.state === "stop") return stopStrategyResponse(run, responseId, attempt, polled.code);
  }
  return stopStrategyResponse(run, responseId, attempt, "provider_timeout");
}

/**
 * The reading of the files attached to the brand's first prompt: the saved one, or, on the brand's
 * first run, a fresh one made here before the run's own request (no credit is charged for it). Files
 * add to the written brief, so nothing here ends the run: without a reading it goes ahead from the
 * brief alone and the next run reads the files. A stop asked meanwhile is acted on by the caller's
 * own check before its paid call.
 */
async function readAttachedFiles(run: ClaimedRun): Promise<BriefFileNotes | null> {
  try {
    if (runStopDecision(await checkRun(run.id)).action !== "continue") return null;
    const started = await startFileReading(run);
    if (started.state !== "created") return started.state === "known" ? started.notes : null;
    for (const seconds of FILE_POLL_DELAYS) {
      await sleep(`${seconds}s`);
      const polled = await pollFileReading(run.id, started.responseId);
      if (polled.state === "terminal") return await settleFileReading(run, started.responseId);
      if (polled.state === "stop") {
        await stopFileReading(run, started.responseId, polled.code);
        return null;
      }
    }
    await stopFileReading(run, started.responseId, "provider_timeout");
    return null;
  } catch {
    return null;
  }
}
