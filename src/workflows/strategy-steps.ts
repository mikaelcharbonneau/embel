import { FatalError, getStepMetadata, RetryableError } from "workflow";
import type { ClaimedRun } from "./engine-steps";
import type { AttemptResult, Correction, PollResult, PreparedStrategy, StrategyRunDeps } from "@/server/engine/strategy-run";

// Step functions only. Server modules load inside each step body so nothing Node-specific
// (pg, fs, crypto, the server-only guard) enters the workflow sandbox bundle.

/** Turns a provider or run failure into the workflow's retry decision:
 * - 429, 500, 502, 503 and connections that never opened retry with backoff (3 attempts);
 * - other 4xx and invalid runs fail at once;
 * - a create whose outcome is unknown fails at once instead of risking a second paid response.
 * Database outages and other unexpected errors keep the step's default retries. */
function stepFailure(error: unknown): unknown {
  const name = error instanceof Error ? error.name : "";
  if (name === "EngineProviderError") {
    const { disposition, retryAfterMs } = error as Error & { disposition: string; retryAfterMs: number | null };
    if (disposition === "retry") return new RetryableError("provider_unavailable", { retryAfter: retryAfterMs ?? 2 ** stepAttempt() * 1000 });
    return new FatalError(disposition === "rejected" ? "provider_request_rejected" : "provider_outcome_unknown");
  }
  if (name === "StrategyRunError") return new FatalError((error as Error & { code: string }).code);
  if (error instanceof Error && error.message === "provider_unconfigured") return new FatalError("provider_unconfigured");
  return error;
}

/** Backoff 2 s, 4 s, 8 s. Outside a workflow (tests, direct calls) there is no attempt count. */
function stepAttempt(): number {
  try { return getStepMetadata().attempt; } catch { return 1; }
}

async function deps(): Promise<StrategyRunDeps> {
  const [{ engineCall }, { engineOpenAI }] = await Promise.all([import("@/server/engine/database"), import("@/server/engine/openai")]);
  return {
    openai: engineOpenAI(),
    check: runId => engineCall("engine_check", [runId]),
    async save(runId, outputKey, output, responseId, costMicrousd) {
      try { return await engineCall<boolean>("engine_save_output", [runId, outputKey, JSON.stringify(output), responseId, Math.max(0, Math.round(costMicrousd))]); }
      catch (error) {
        // A run that already ended keeps the outputs it has; there is nothing left to record on.
        if (error instanceof Error && error.message.includes("run_not_running")) return false;
        throw error;
      }
    },
  };
}

/** Validates the frozen input and builds the exact request every attempt sends. */
export async function prepareStrategy(run: ClaimedRun): Promise<PreparedStrategy> {
  "use step";
  const [{ prepareStrategyAttempt }, { engineOpenAI }] = await Promise.all([import("@/server/engine/strategy-run"), import("@/server/engine/openai")]);
  try { return await prepareStrategyAttempt(run, engineOpenAI()); }
  catch (error) { throw stepFailure(error); }
}
prepareStrategy.maxRetries = 2;

/** One paid OpenAI background create; returns the response id the workflow polls. */
export async function createStrategyResponse(prepared: PreparedStrategy, attempt: number, correction: Correction | null): Promise<{ responseId: string }> {
  "use step";
  const [{ createStrategyAttempt }, { engineOpenAI }] = await Promise.all([import("@/server/engine/strategy-run"), import("@/server/engine/openai")]);
  try { return await createStrategyAttempt(engineOpenAI(), prepared, attempt, correction); }
  catch (error) { throw stepFailure(error); }
}
createStrategyResponse.maxRetries = 2;

/** Checks for a cancel or pause, then looks the response up by id. */
export async function pollStrategyResponse(runId: string, responseId: string): Promise<PollResult> {
  "use step";
  const { pollStrategyAttempt } = await import("@/server/engine/strategy-run");
  try { return await pollStrategyAttempt(await deps(), runId, responseId); }
  catch (error) { throw stepFailure(error); }
}
pollStrategyResponse.maxRetries = 2;

/** Validates the finished response, saves the result or the failed attempt with its cost. */
export async function settleStrategyResponse(run: ClaimedRun, responseId: string, attempt: number): Promise<AttemptResult> {
  "use step";
  const { settleStrategyAttempt } = await import("@/server/engine/strategy-run");
  try { return await settleStrategyAttempt(await deps(), run, responseId, attempt); }
  catch (error) { throw stepFailure(error); }
}
settleStrategyResponse.maxRetries = 2;

/** Cancels the open response at OpenAI and records its cost so far. */
export async function stopStrategyResponse(run: ClaimedRun, responseId: string, attempt: number, code: string): Promise<AttemptResult> {
  "use step";
  const { stopStrategyAttempt } = await import("@/server/engine/strategy-run");
  try { return await stopStrategyAttempt(await deps(), run, responseId, attempt, code); }
  catch (error) { throw stepFailure(error); }
}
stopStrategyResponse.maxRetries = 2;
