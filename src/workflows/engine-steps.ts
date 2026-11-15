import { FatalError } from "workflow";
import type { GenerationRunStatus } from "@/domain/generation-run";

// Step functions only. Server modules load inside each step body so nothing
// Node-specific (pg, fs, the server-only guard) enters the workflow sandbox bundle.

export type RunStatus = GenerationRunStatus;
export type ClaimedRun = {
  id: string;
  ownerId: string;
  projectId: string;
  kind: string;
  status: RunStatus;
  input: Record<string, unknown>;
  cancelRequested: boolean;
};
export type RunCheck = { status: RunStatus; cancelRequested: boolean; paused: boolean };

async function call<T>(
  name: "engine_claim" | "engine_check" | "engine_save_output" | "engine_finish",
  args: readonly unknown[],
): Promise<T> {
  const { engineCall } = await import("@/server/engine/database");
  try {
    return await engineCall<T>(name, args);
  } catch (error) {
    // Ownership or state conflicts never fix themselves; everything else may be a passing outage.
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : "";
    if (
      code === "P0002" ||
      code === "22023" ||
      message.includes("claim_conflict") ||
      message.includes("run_not_running")
    ) {
      throw new FatalError(message.slice(0, 80) || "engine_state_conflict");
    }
    throw error;
  }
}

/** Moves a queued run to running for this workflow run, or returns why it can't run. */
export async function claimRun(runId: string, workflowRunId: string): Promise<ClaimedRun> {
  "use step";
  return call<ClaimedRun>("engine_claim", [runId, workflowRunId]);
}

/** Reads the cancel request and the engine-wide stop switch between paid steps. Null when the
 * run is gone (its account was deleted). Always pass the answer to runStopDecision. */
export async function checkRun(runId: string): Promise<RunCheck | null> {
  "use step";
  return call<RunCheck | null>("engine_check", [runId]);
}

/** Saves one output once; a replayed step returns false instead of duplicating it. */
export async function saveOutput(
  runId: string,
  outputKey: string,
  output: unknown,
  providerResponseId: string | null,
  costMicrousd: number,
): Promise<boolean> {
  "use step";
  return call<boolean>("engine_save_output", [
    runId,
    outputKey,
    JSON.stringify(output),
    providerResponseId,
    Math.max(0, Math.round(costMicrousd)),
  ]);
}

/** Ends the run; a failed or cancelled run gets its credits back. */
export async function finishRun(
  runId: string,
  status: "succeeded" | "failed" | "cancelled",
  errorCode: string | null,
): Promise<{ id: string; status: RunStatus; errorCode: string | null }> {
  "use step";
  return call("engine_finish", [runId, status, errorCode]);
}
