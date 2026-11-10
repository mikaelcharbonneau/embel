import { FatalError, getStepMetadata, RetryableError } from "workflow";
import type { IdentitySystemSpecification } from "@/domain/identity-jobs";
import type { ClaimedRun } from "./engine-steps";
import type {
  BoardResult,
  IdentityRunDeps,
  PreparedSpecification,
  SpecificationPoll,
  SpecificationResult,
  SpecificationSend,
} from "@/server/engine/identity-run";

// Step functions only. Server modules load inside each step body so nothing
// Node-specific (pg, fs, child processes, the server-only guard) enters the
// workflow sandbox bundle.

type Components = IdentitySystemSpecification["components"];

/** Backoff 2 s, 4 s, 8 s. Outside a workflow (tests, direct calls) there is no attempt count. */
function stepAttempt(): number {
  try {
    return getStepMetadata().attempt;
  } catch {
    return 1;
  }
}
/** Provider and run failures become the workflow's retry decision, as for Logo:
 * 429, 5xx and connections that never opened retry; known run problems fail at
 * once. Database outages keep the default retries. */
function stepFailure(error: unknown): unknown {
  const name = error instanceof Error ? error.name : "";
  if (name === "EngineProviderError") {
    const { disposition, retryAfterMs } = error as Error & { disposition: string; retryAfterMs: number | null };
    if (disposition === "retry")
      return new RetryableError("provider_unavailable", { retryAfter: retryAfterMs ?? 2 ** stepAttempt() * 1000 });
    return new FatalError(disposition === "rejected" ? "provider_request_rejected" : "provider_outcome_unknown");
  }
  if (name === "IdentityRunError") return new FatalError((error as Error & { code: string }).code);
  if (error instanceof Error && ["provider_unconfigured", "storage_unconfigured"].includes(error.message))
    return new FatalError(error.message);
  if (error instanceof Error && /invalid_run_input|run_not_running/u.test(error.message))
    return new FatalError(error.message.includes("run_not_running") ? "run_not_running" : "invalid_run_input");
  return error;
}

async function engineDb(): Promise<IdentityRunDeps["db"]> {
  const { engineCall } = await import("@/server/engine/database");
  return {
    check: (runId) => engineCall("engine_check", [runId]),
    begin: (runId) => engineCall("engine_identity_begin", [runId]),
    saveBoard: (runId, ordinal, board, responseId, cost) =>
      engineCall("engine_identity_save_board", [runId, ordinal, JSON.stringify(board), responseId, cost]),
    saveOutput: (runId, key, output, responseId, cost) =>
      engineCall<boolean>("engine_save_output", [runId, key, JSON.stringify(output), responseId, cost]),
  };
}
async function textDeps(): Promise<Pick<IdentityRunDeps, "db" | "openai" | "now">> {
  const { engineOpenAI } = await import("@/server/engine/openai");
  return { db: await engineDb(), openai: engineOpenAI(), now: () => new Date() };
}
async function boardDeps(): Promise<IdentityRunDeps> {
  const [{ randomUUID }, { engineOpenAI }, { engineImages }, { engineStorage }, { inspectIdentityRaster }] =
    await Promise.all([
      import("node:crypto"),
      import("@/server/engine/openai"),
      import("@/server/engine/openai-images"),
      import("@/server/engine/storage"),
      import("@/features/logo-vector/server/converter"),
    ]);
  return {
    db: await engineDb(),
    openai: engineOpenAI(),
    images: engineImages(),
    storage: engineStorage(),
    newId: randomUUID,
    now: () => new Date(),
    inspect: (bytes, mimeType) => inspectIdentityRaster(bytes, mimeType, AbortSignal.timeout(60_000)),
  };
}

/** Validates the frozen round; returns the directions still to make. */
export async function beginIdentityDirections(run: ClaimedRun): Promise<{ pending: number[]; prior: Components[] }> {
  "use step";
  const { beginIdentityDirections: begin } = await import("@/server/engine/identity-run");
  try {
    return await begin({ db: await engineDb() }, run);
  } catch (error) {
    throw stepFailure(error);
  }
}
beginIdentityDirections.maxRetries = 2;

export async function prepareSpecification(
  run: ClaimedRun,
  ordinal: number,
  prior: Components[],
): Promise<PreparedSpecification> {
  "use step";
  const { prepareSpecification: prepare } = await import("@/server/engine/identity-run");
  try {
    return await prepare(await textDeps(), run, ordinal, prior);
  } catch (error) {
    throw stepFailure(error);
  }
}
prepareSpecification.maxRetries = 2;

/** One paid create, once: a step that ran again after a crash finds its marker and
 * fails the direction instead of paying twice. Nothing-sent failures come back as `retry`. */
export async function createSpecification(
  run: ClaimedRun,
  prepared: Extract<PreparedSpecification, { request: unknown }>,
  attempt: number,
): Promise<SpecificationSend> {
  "use step";
  const { createSpecification: create } = await import("@/server/engine/identity-run");
  try {
    return await create(await textDeps(), run, prepared, attempt);
  } catch (error) {
    throw stepFailure(error);
  }
}
createSpecification.maxRetries = 0;

export async function pollSpecification(runId: string, responseId: string): Promise<SpecificationPoll> {
  "use step";
  const { pollSpecification: poll } = await import("@/server/engine/identity-run");
  try {
    return await poll(await textDeps(), runId, responseId);
  } catch (error) {
    throw stepFailure(error);
  }
}
pollSpecification.maxRetries = 2;

export async function settleSpecification(
  run: ClaimedRun,
  ordinal: number,
  attempt: number,
  responseId: string,
  prior: Components[],
): Promise<SpecificationResult> {
  "use step";
  const { settleSpecification: settle } = await import("@/server/engine/identity-run");
  try {
    return await settle(await textDeps(), run, ordinal, attempt, responseId, prior);
  } catch (error) {
    throw stepFailure(error);
  }
}
settleSpecification.maxRetries = 2;

export async function stopSpecification(
  run: ClaimedRun,
  ordinal: number,
  attempt: number,
  responseId: string,
  code: string,
): Promise<SpecificationResult> {
  "use step";
  const { stopSpecification: stop } = await import("@/server/engine/identity-run");
  try {
    return await stop(await textDeps(), run, ordinal, attempt, responseId, code);
  } catch (error) {
    throw stepFailure(error);
  }
}
stopSpecification.maxRetries = 2;

/** One paid board, once: no automatic retry, because a step that ran again after a
 * crash could pay twice. Nothing-drawn failures come back as `retry` instead. */
export async function drawBoard(
  run: ClaimedRun,
  ordinal: number,
  specification: IdentitySystemSpecification,
  attempt: number,
): Promise<BoardResult> {
  "use step";
  const { drawBoard: draw } = await import("@/server/engine/identity-run");
  try {
    return await draw(await boardDeps(), run, ordinal, specification, attempt);
  } catch (error) {
    throw stepFailure(error);
  }
}
drawBoard.maxRetries = 0;

/** Records a direction that won't get a board (idempotent). */
export async function recordBoardFailure(run: ClaimedRun, ordinal: number, code: string): Promise<BoardResult> {
  "use step";
  const { recordBoardFailure: record } = await import("@/server/engine/identity-run");
  try {
    return await record({ db: await engineDb() }, run, ordinal, code);
  } catch (error) {
    throw stepFailure(error);
  }
}
recordBoardFailure.maxRetries = 3;
