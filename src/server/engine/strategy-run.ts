import "server-only";
import type { ClaimedJob, StepOutcome } from "@/domain/jobs";
import { strategyOperationSchema, type StrategyJobInput, type StrategyOperation } from "@/domain/strategy-jobs";
import type { OpenAIResponsesTransport, ResponsesRequest } from "../ai/openai-transport";
import { calculateStrategyCost, evaluateStrategyResponse, prepareStrategyResponse } from "../ai/strategy-response";
import { EngineProviderError, isTerminal, responseUsage, type EngineOpenAI } from "./openai";
import { enginePolicyIdentity, engineStrategyPolicy, strategyRunInputSchema } from "./strategy";

// The Strategy workflow's step logic, with the provider and the engine database passed in
// so tests can stub both. Each function is one durable step; none of them retries itself.

/** The run as engine_claim returns it. */
export type ClaimedStrategyRun = { id: string; ownerId: string; projectId: string; kind: string; input: unknown };
export type EngineRunCheck = { status: string; cancelRequested: boolean; paused: boolean };
export type StrategyRunDeps = {
  openai: EngineOpenAI;
  check(runId: string): Promise<EngineRunCheck>;
  save(runId: string, outputKey: string, output: unknown, responseId: string | null, costMicrousd: number): Promise<boolean>;
};

/** A known, permanent reason the run can't continue. Its code becomes the run's error code. */
export class StrategyRunError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StrategyRunError";
  }
}

export type PreparedStrategy = { request: ResponsesRequest; requestKey: string };
export type Correction = { code: string; previousText: string | null };
export type AttemptResult =
  | { state: "succeeded" }
  | { state: "stopped"; code: string }
  | { state: "failed"; code: string; correctable: boolean; previousText: string | null };
export type PollResult = { state: "pending" } | { state: "terminal" } | { state: "stop"; code: string };

const ERROR_CODE = /^[a-z_]{1,64}$/u;
export const engineErrorCode = (code: string) => ERROR_CODE.test(code) ? code : "generation_failed";
/** Output the model can fix when told what was wrong: unreadable or unmatched JSON, or
 * competitors whose sources the search never returned. One corrective re-prompt at most. */
const CORRECTABLE = new Set(["provider_invalid_output", "provider_research_unusable", "provider_research_missing"]);

/** Validates the frozen input against this deployment's policy and the run's own turn. */
export function readStrategyRun(run: ClaimedStrategyRun): { operation: StrategyOperation; input: StrategyJobInput; job: ClaimedJob } {
  const operation = strategyOperationSchema.safeParse(run.kind);
  const parsed = strategyRunInputSchema.safeParse(run.input);
  if (!operation.success || !parsed.success || parsed.data.request.version !== 3) throw new StrategyRunError("invalid_run_input");
  const { revision, request } = parsed.data;
  if (JSON.stringify(request.policy) !== JSON.stringify(engineStrategyPolicy(operation.data)) || request.policyIdentity !== enginePolicyIdentity(operation.data)) {
    throw new StrategyRunError("policy_mismatch");
  }
  if (request.assistantHistory.entries.some(entry => entry.jobId === run.id)) throw new StrategyRunError("invalid_run_input");
  return { operation: operation.data, input: request, job: {
    id: run.id, ownerId: run.ownerId, projectId: run.projectId, operation: operation.data, input: request, inputRevision: revision,
    // The engine meters credits at admission, not cost reservations.
    leaseToken: "engine", status: "running", reservedCostMicrousd: 0, actualCostMicrousd: 0,
  } };
}

/** Builds the exact request once; the workflow keeps it, so every retry sends the same one.
 * Counting input tokens is free and has no side effect. */
export async function prepareStrategyAttempt(run: ClaimedStrategyRun, openai: EngineOpenAI): Promise<PreparedStrategy> {
  const { operation, input, job } = readStrategyRun(run);
  const transport: OpenAIResponsesTransport = {
    countInputTokens: request => openai.countInputTokens(request),
    createResponse: () => Promise.reject(new Error("Not used while preparing")),
  };
  const prepared = await prepareStrategyResponse({ job, operation, input, transport, signal: new AbortController().signal, unmeteredExecution: true });
  if (prepared.kind === "failure") {
    const code = prepared.outcome.status === "succeeded" ? "generation_failed" : prepared.outcome.code;
    if (code === "input_token_count_unavailable") throw new EngineProviderError("retry", null);
    throw new StrategyRunError(engineErrorCode(code));
  }
  return { request: prepared.request, requestKey: prepared.requestKey };
}

/** The original request, or after an unusable reply, the same conversation with that reply
 * and one instruction to correct it. */
export function attemptRequest(prepared: PreparedStrategy, correction: Correction | null): ResponsesRequest {
  if (!correction) return prepared.request;
  const instruction = correction.code === "provider_research_missing"
    ? "Your previous reply did not complete the required web search. Search first, then answer in the required JSON format."
    : "Your previous reply could not be used: it did not match the required JSON schema, or it named competitors, websites or sources that your completed searches did not return. Reply again with JSON that matches the schema exactly. Copy sourceUrls and websites only from sources your completed searches returned, and leave out anything you could not verify.";
  const input = Array.isArray(prepared.request.input) ? prepared.request.input : [];
  return { ...prepared.request, input: [...input, ...(correction.previousText ? [{ role: "assistant", content: correction.previousText }] : []), { role: "user", content: instruction }] };
}

/** One paid background create. Never repeated when its outcome is uncertain. */
export async function createStrategyAttempt(openai: EngineOpenAI, prepared: PreparedStrategy, attempt: number, correction: Correction | null) {
  const response = await openai.create(attemptRequest(prepared, correction), attempt === 1 ? prepared.requestKey : `${prepared.requestKey}:${attempt}`);
  return { responseId: response.id };
}

/** Between polls: stop when the run was cancelled, the engine paused or the run ended
 * elsewhere; otherwise look the response up by id. */
export async function pollStrategyAttempt(deps: StrategyRunDeps, runId: string, responseId: string): Promise<PollResult> {
  const state = await deps.check(runId);
  if (state.status !== "running") return { state: "stop", code: "cancelled" };
  if (state.cancelRequested || state.paused) return { state: "stop", code: state.paused ? "generation_paused" : "cancelled" };
  const response = await deps.openai.retrieve(responseId);
  return isTerminal(response.status) ? { state: "terminal" } : { state: "pending" };
}

function costOf(body: unknown, input: StrategyJobInput): number {
  const observed = responseUsage(body);
  return observed ? calculateStrategyCost(observed.usage, observed.searchCalls, input) : 0;
}

/** Interprets a finished response with the existing Strategy schemas, saves the result or
 * the failed attempt with its response id and cost, and says whether to re-prompt. */
export async function settleStrategyAttempt(deps: StrategyRunDeps, run: ClaimedStrategyRun, responseId: string, attempt: number): Promise<AttemptResult> {
  const { operation, input, job } = readStrategyRun(run);
  const response = await deps.openai.retrieve(responseId);
  if (!isTerminal(response.status)) throw new EngineProviderError("retry", null);
  const outcome: StepOutcome = evaluateStrategyResponse({ job, operation, input, raw: { body: response.body, requestId: response.requestId }, unmeteredExecution: true });
  if (outcome.status === "succeeded") {
    await deps.save(run.id, "result", outcome.result, response.id, outcome.costMicrousd);
    return { state: "succeeded" };
  }
  const code = engineErrorCode(outcome.code);
  await deps.save(run.id, `attempt.${attempt}`, { code }, response.id, outcome.costMicrousd);
  const correctable = CORRECTABLE.has(outcome.code);
  const partial = outcome.result && typeof outcome.result === "object" && !Array.isArray(outcome.result) ? (outcome.result as { partialText?: unknown }).partialText : undefined;
  return { state: "failed", code, correctable, previousText: correctable && typeof partial === "string" && partial ? partial.slice(0, 16_000) : null };
}

/** Cancels the open response at OpenAI (idempotent) and records what it cost so far. */
export async function stopStrategyAttempt(deps: StrategyRunDeps, run: ClaimedStrategyRun, responseId: string, attempt: number, code: string): Promise<AttemptResult> {
  const { input } = readStrategyRun(run);
  let body: unknown = null;
  try { body = (await deps.openai.cancel(responseId)).body; }
  catch (error) {
    // A response OpenAI no longer knows can't be cancelled; anything transient is retried.
    if (!(error instanceof EngineProviderError) || error.disposition !== "rejected") throw error;
  }
  await deps.save(run.id, `attempt.${attempt}`, { code }, responseId, costOf(body, input));
  return code === "provider_timeout" ? { state: "failed", code, correctable: false, previousText: null } : { state: "stopped", code };
}
