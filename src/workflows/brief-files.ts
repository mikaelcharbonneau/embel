import { getWorkflowMetadata, sleep } from "workflow";
import { runStopDecision } from "../server/engine/stop-check";
import { pollFileReading, settleFileReading, startFileReading, stopFileReading } from "./brief-files-steps";
import { checkRun, claimRun, finishRun } from "./engine-steps";

/** Seconds between lookups: quick at first, then every 5 s, for at most 3 minutes. */
const POLL_DELAYS = [2, 3, 4, ...Array.from({ length: 34 }, () => 5)];

/** Reads the files of a brand outside a Strategy run (kind brief.read_files): files added in the
 * side chat. One request, no credits; the reading is saved as the run's `files` output, where every
 * later Strategy run and naming round finds it. */
export async function briefFilesGeneration(runId: string) {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  const run = await claimRun(runId, workflowRunId);
  if (run.status !== "running") return { status: run.status };
  try {
    const stop = runStopDecision(await checkRun(runId));
    if (stop.action === "quit") return { status: stop.status };
    if (stop.action === "cancel") return await finishRun(runId, "cancelled", stop.code);
    const started = await startFileReading(run);
    if (started.state === "none") return await finishRun(runId, "failed", "invalid_run_input");
    if (started.state === "known") return await finishRun(runId, "succeeded", null);
    for (const seconds of POLL_DELAYS) {
      await sleep(`${seconds}s`);
      const polled = await pollFileReading(runId, started.responseId);
      if (polled.state === "terminal")
        return (await settleFileReading(run, started.responseId))
          ? await finishRun(runId, "succeeded", null)
          : await finishRun(runId, "failed", "files_unreadable");
      if (polled.state === "stop") {
        await stopFileReading(run, started.responseId, polled.code);
        return await finishRun(runId, "cancelled", polled.code);
      }
    }
    await stopFileReading(run, started.responseId, "provider_timeout");
    return await finishRun(runId, "failed", "provider_timeout");
  } catch (error) {
    await finishRun(runId, "failed", "generation_failed");
    throw error;
  }
}
