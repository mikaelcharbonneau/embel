import { getWorkflowMetadata, sleep } from "workflow";
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

/** Runs one Strategy operation (kinds strategy.*) on OpenAI background mode. */
export async function strategyGeneration(runId: string) {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  const run = await claimRun(runId, workflowRunId);
  if (run.status !== "running") return { status: run.status };
  try {
    const prepared = await prepareStrategy(run);
    let correction: { code: string; previousText: string | null } | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // No paid call starts after a cancel or while the engine is paused.
      const state = await checkRun(runId);
      if (state.status !== "running") return { status: state.status };
      if (state.cancelRequested || state.paused)
        return await finishRun(runId, "cancelled", state.paused ? "generation_paused" : "cancelled");
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
