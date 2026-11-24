import type { BriefFileNotes } from "@/domain/brief-files";
import type { BriefFilesDeps, FileReadingPoll, FileReadingStart } from "@/server/engine/brief-files-run";
import type { ClaimedRun } from "./engine-steps";

// Step functions only (reading the files attached to a brand's first prompt). Server modules load
// inside each step body so nothing Node-specific enters the workflow sandbox bundle.

async function deps(): Promise<BriefFilesDeps> {
  const [{ engineCall }, { engineOpenAI }, { engineStorage }, { runLogoReferenceOnWhiteProcess }] = await Promise.all([
    import("@/server/engine/database"),
    import("@/server/engine/openai"),
    import("@/server/engine/storage"),
    import("../server/image-process/process"),
  ]);
  return {
    openai: engineOpenAI(),
    storage: engineStorage(),
    onWhite: (bytes, mimeType) => runLogoReferenceOnWhiteProcess({ bytes, mimeType }, AbortSignal.timeout(60_000)),
    check: (runId) => engineCall("engine_check", [runId]),
    save: (runId, outputKey, output, responseId, costMicrousd) =>
      engineCall<boolean>("engine_save_output", [runId, outputKey, JSON.stringify(output), responseId, costMicrousd]),
  };
}

/** Decides whether this run reads files and sends the one request. Never retried: a create that may
 * have gone through is not sent twice. */
export async function startFileReading(run: ClaimedRun): Promise<FileReadingStart> {
  "use step";
  const { startFileReading: start } = await import("@/server/engine/brief-files-run");
  return start(await deps(), run);
}
startFileReading.maxRetries = 0;

export async function pollFileReading(runId: string, responseId: string): Promise<FileReadingPoll> {
  "use step";
  const { pollFileReading: poll } = await import("@/server/engine/brief-files-run");
  return poll(await deps(), runId, responseId);
}
pollFileReading.maxRetries = 2;

export async function settleFileReading(run: ClaimedRun, responseId: string): Promise<BriefFileNotes | null> {
  "use step";
  const { settleFileReading: settle } = await import("@/server/engine/brief-files-run");
  return settle(await deps(), run, responseId);
}
settleFileReading.maxRetries = 2;

export async function stopFileReading(run: ClaimedRun, responseId: string, code: string): Promise<void> {
  "use step";
  const { stopFileReading: stop } = await import("@/server/engine/brief-files-run");
  return stop(await deps(), run, responseId, code);
}
stopFileReading.maxRetries = 2;
