import { FatalError, getStepMetadata, RetryableError } from "workflow";
import type { ClaimedRun } from "./engine-steps";
import type { NamingOpenRequest, NamingPollResult, NamingRequestPlan, NamingRunDeps, NamingRunState, NamingSettleResult } from "@/server/engine/naming-run";

export type { NamingOpenRequest, NamingRequestPlan, NamingRunState } from "@/server/engine/naming-run";

// Step functions only. Server modules load inside each step body so nothing Node-specific
// (pg, fs, crypto, the server-only guard) enters the workflow sandbox bundle.

/** Turns a provider or run failure into the workflow's retry decision, with the Naming
 * screen's own codes:
 * - 429, 500, 502, 503 and connections that never opened retry with backoff (3 attempts),
 *   then fail as "provider_unavailable";
 * - other 4xx fail at once as "provider_rejected";
 * - a create whose outcome is unknown fails at once as "send_interrupted" instead of risking
 *   a second paid response.
 * Database outages and other unexpected errors keep the step's default retries. */
function stepFailure(error: unknown): unknown {
  const name = error instanceof Error ? error.name : "";
  if (name === "EngineProviderError") {
    const { disposition, retryAfterMs } = error as Error & { disposition: string; retryAfterMs: number | null };
    if (disposition === "retry") return new RetryableError("provider_unavailable", { retryAfter: retryAfterMs ?? 2 ** stepAttempt() * 1000 });
    return new FatalError(disposition === "rejected" ? "provider_rejected" : "send_interrupted");
  }
  if (name === "NamingRunError") return new FatalError((error as Error & { code: string }).code);
  if (error instanceof Error && error.message === "provider_unconfigured") return new FatalError("provider_unconfigured");
  return error;
}

/** Backoff 2 s, 4 s, 8 s. Outside a workflow (tests, direct calls) there is no attempt count. */
function stepAttempt(): number {
  try { return getStepMetadata().attempt; } catch { return 1; }
}

/** A save after the run already ended has nothing left to record on; a project being
 * deleted won't take new names. */
function saveFailure(error: unknown): null {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("run_not_running")) return null;
  if (message.includes("project_deleted") || message.includes("project_not_found")) throw new FatalError("project_unavailable");
  throw error;
}

async function deps(): Promise<NamingRunDeps> {
  const [{ engineCall }, { engineOpenAI }, { namingSaveResultSchema }] = await Promise.all([
    import("@/server/engine/database"), import("@/server/engine/openai"), import("@/server/engine/naming-run"),
  ]);
  return {
    openai: engineOpenAI(),
    check: runId => engineCall("engine_check", [runId]),
    async save(runId, outputKey, output, responseId, costMicrousd) {
      try { return await engineCall<boolean>("engine_save_output", [runId, outputKey, JSON.stringify(output), responseId, Math.max(0, Math.round(costMicrousd))]); }
      catch (error) { return saveFailure(error) ?? false; }
    },
    async saveNames(runId, outputKey, output, responseId, costMicrousd) {
      try { return namingSaveResultSchema.parse(await engineCall("engine_save_names", [runId, outputKey, JSON.stringify(output), responseId, Math.max(0, Math.round(costMicrousd))])); }
      catch (error) { return saveFailure(error); }
    },
  };
}

/** Validates the frozen input and plans the round's requests. */
export async function planNamingRound(run: ClaimedRun, state: NamingRunState, round: number): Promise<NamingRequestPlan[]> {
  "use step";
  const { planNamingRound: plan } = await import("@/server/engine/naming-run");
  try { return plan(run, state, round); }
  catch (error) { throw stepFailure(error); }
}
planNamingRound.maxRetries = 1;

/** One paid OpenAI background create; returns the response id the workflow polls. */
export async function createNamingResponse(run: ClaimedRun, plan: NamingRequestPlan, state: NamingRunState): Promise<{ responseId: string }> {
  "use step";
  const [{ createNamingAttempt }, { engineOpenAI }] = await Promise.all([import("@/server/engine/naming-run"), import("@/server/engine/openai")]);
  try { return await createNamingAttempt(engineOpenAI(), run, plan, state); }
  catch (error) { throw stepFailure(error); }
}
createNamingResponse.maxRetries = 2;

/** Checks for a cancel or pause, then looks the open responses up by id. */
export async function pollNamingResponses(runId: string, responseIds: string[]): Promise<NamingPollResult> {
  "use step";
  const { pollNamingAttempts } = await import("@/server/engine/naming-run");
  try { return await pollNamingAttempts(await deps(), runId, responseIds); }
  catch (error) { throw stepFailure(error); }
}
pollNamingResponses.maxRetries = 2;

/** Checks a finished reply and saves its names, or the reason it gave none, with its cost. */
export async function settleNamingResponse(run: ClaimedRun, plan: NamingRequestPlan, state: NamingRunState, responseId: string): Promise<NamingSettleResult> {
  "use step";
  const { settleNamingAttempt } = await import("@/server/engine/naming-run");
  try { return await settleNamingAttempt(await deps(), run, plan, state, responseId); }
  catch (error) { throw stepFailure(error); }
}
settleNamingResponse.maxRetries = 2;

/** Cancels the open responses at OpenAI and records their cost; finished ones keep their names. */
export async function stopNamingResponses(run: ClaimedRun, open: NamingOpenRequest[], state: NamingRunState, code: string): Promise<NamingRunState> {
  "use step";
  const { stopNamingAttempts } = await import("@/server/engine/naming-run");
  try { return await stopNamingAttempts(await deps(), run, open, state, code); }
  catch (error) { throw stepFailure(error); }
}
stopNamingResponses.maxRetries = 2;

/** Records a request that could not be sent, or whose create had an unknown outcome. */
export async function recordNamingFailure(runId: string, plan: NamingRequestPlan, code: string): Promise<void> {
  "use step";
  const { recordNamingFailure: record } = await import("@/server/engine/naming-run");
  try { await record(await deps(), runId, plan, code); }
  catch (error) { throw stepFailure(error); }
}
recordNamingFailure.maxRetries = 2;
