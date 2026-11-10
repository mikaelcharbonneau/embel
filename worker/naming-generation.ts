import { z } from "zod";
import { allocateBrainstormApproaches, filterNamingBrainstormCandidates, type ApproachSlot } from "../src/domain/naming-brainstorm";
import {
  cleanGeneratedCandidate, NAMING_HEARTBEAT_MS, NAMING_LEASE_SECONDS, NAMING_MAX_ROUNDS, NAMING_ROUND_TIMEOUT_MS, NAMING_RUN_DEADLINE_MS, NAMING_RUN_TARGET,
  namingSavedCandidateSchema, type NamingClaim, type NamingGenerationPolicy, type NamingRunErrorCode, type NamingRunInput, type NamingSavedCandidate, type NamingUsage,
} from "../src/domain/naming-generation";
import { NAMING_GENERATION_FORMAT, NAMING_GENERATION_PROFILE, namingGenerationWireSchema, type NamingGenerationWire } from "../src/domain/naming-generation-wire";
import { NamingProviderError, type NamingGenerationProvider } from "../src/server/ai/naming-generation-provider";
import { NAMING_PROMPT_EXCLUSION_LIMITS, namingPrompt, namingReplyCandidates, namingReplyFormat } from "../src/server/ai/naming-prompt";

/** One `naming.generate` run per claim: at most three background rounds whose
 * cleaned names SQL saves. See docs/naming-generation-contract.md, "Worker loop". */
export type NamingGenerationGateway = { invoke(action: string, args: unknown, observation?: boolean): Promise<unknown> };
/** What the next request is built from. `identities` are the project's names at
 * claim time; `saved` are the names this process sent to `round_saved`. */
export type NamingRoundState = { jobId: string; identities: readonly string[]; saved: readonly NamingSavedCandidate[]; savedCount: number };
export type NamingRoundPlan = { candidateTarget: number; slots: ApproachSlot[] };
export type NamingGenerationTiming = { heartbeatMs: number; pollMs: number; roundTimeoutMs: number; deadlineMs: number; requestTimeoutMs: number; cancelTimeoutMs: number; retryDelaysMs: readonly number[] };
export const NAMING_GENERATION_TIMING: Readonly<NamingGenerationTiming> = Object.freeze({
  heartbeatMs: NAMING_HEARTBEAT_MS, pollMs: 2_000, roundTimeoutMs: NAMING_ROUND_TIMEOUT_MS, deadlineMs: NAMING_RUN_DEADLINE_MS,
  // One provider HTTP call; a database action gets 3 attempts in all.
  requestTimeoutMs: 30_000, cancelTimeoutMs: 5_000, retryDelaysMs: Object.freeze([250, 1_000]),
});

const exclusions = (state: NamingRoundState) => [...new Set([...state.identities, ...state.saved.map(row => row.identityKey)])];
/** Round 1 asks for 120 names; later rounds ask for what is missing plus 20, at most 60.
 * Each open place goes to the least represented selected approach. */
export function planNamingRound(input: NamingRunInput, state: NamingRoundState, round: number): NamingRoundPlan {
  const remaining = Math.max(0, NAMING_RUN_TARGET - state.savedCount), candidateTarget = round === 1 ? 120 : Math.min(60, remaining + 20);
  return { candidateTarget, slots: allocateBrainstormApproaches(input.brief.preferences.approaches, state.saved.map(row => row.primaryApproach), remaining, candidateTarget) };
}

export function buildNamingRoundRequest(input: NamingRunInput, state: NamingRoundState, round: number, policy: NamingGenerationPolicy): NamingGenerationWire {
  const { candidateTarget, slots } = planNamingRound(input, state, round);
  const schema = namingReplyFormat(candidateTarget, slots), excluded = exclusions(state);
  for (const limit of NAMING_PROMPT_EXCLUSION_LIMITS) {
    const parsed = namingGenerationWireSchema.safeParse({ model: policy.model, background: true, store: true, stream: false, reasoning: { effort: policy.reasoningEffort }, max_output_tokens: 16000,
      input: namingPrompt({ candidateTarget, slots, brief: input.brief, excluded, limit }),
      text: { verbosity: "low", format: { type: "json_schema", name: NAMING_GENERATION_FORMAT, strict: true, schema } },
      metadata: { embel_generation_profile: NAMING_GENERATION_PROFILE, embel_job_id: state.jobId, embel_run_id: input.runId, embel_round: String(round) } });
    if (parsed.success) return parsed.data;
  }
  throw Error("naming_request_too_large");
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
/** A completed reply → the cleaned names to save (possibly none), or null when it
 * has no usable JSON. Never throws on provider content. */
export function parseRoundCandidates(response: unknown, context: { input: NamingRunInput; state: NamingRoundState; round: number; policy: NamingGenerationPolicy }): NamingSavedCandidate[] | null {
  if (!record(response) || response.model !== context.policy.model) return null;
  const { candidateTarget, slots } = planNamingRound(context.input, context.state, context.round);
  const raw = namingReplyCandidates(response, candidateTarget);
  if (!raw) return null;
  // Text is cleaned before any check; only checked names leave this module.
  const accepted = filterNamingBrainstormCandidates(raw.map(cleanGeneratedCandidate), context.input.brief.preferences, exclusions(context.state),
    NAMING_RUN_TARGET - context.state.savedCount, slots, context.round >= NAMING_MAX_ROUNDS);
  return accepted.flatMap(({ value, rationale, primaryApproach, identityKey }) => {
    const parsed = namingSavedCandidateSchema.safeParse({ value, rationale, primaryApproach, identityKey });
    return parsed.success ? [parsed.data] : [];
  });
}

const usageSchema = z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative() });
function usageOf(response: Record<string, unknown>): NamingUsage | null {
  const usage = usageSchema.safeParse(response.usage);
  return usage.success && [usage.data.input_tokens, usage.data.output_tokens, usage.data.total_tokens].every(Number.isSafeInteger)
    ? { inputTokens: usage.data.input_tokens, outputTokens: usage.data.output_tokens, totalTokens: usage.data.total_tokens } : null;
}
const heartbeatSchema = z.object({ cancelRequested: z.boolean() });
const savedSchema = z.object({ inserted: z.number().int().min(0).max(NAMING_RUN_TARGET), savedCount: z.number().int().min(0).max(NAMING_RUN_TARGET) });
const finishSchema = z.object({ state: z.enum(["succeeded", "failed", "cancelled"]), savedCount: z.number().int().min(0).max(NAMING_RUN_TARGET) });
const TERMINAL_RESPONSES = new Set(["completed", "failed", "incomplete", "cancelled"]);
/** After these, another round would most likely fail the same way. */
const STOPPING_CODES = new Set<NamingRunErrorCode>(["provider_rejected", "save_failed"]);
type Halt = "stopped" | "lease_lost" | "cancelled" | "deadline";
type Polled = { kind: "terminal"; response: Record<string, unknown> } | { kind: "unreadable"; code: NamingRunErrorCode } | { kind: "timeout" } | { kind: "halted" };

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms); signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Runs one claimed job to a settled outcome and returns a short state: the
 * `finish` state (`succeeded`, `failed`, `cancelled`), or `stopped`, `lease_lost`
 * or `unsettled` when it leaves the job for `expire`/`recover`. It never throws
 * for provider or database errors, never re-sends a round, and only polls a
 * round whose receipt number is saved.
 */
export async function runNamingGeneration(options: { gateway: NamingGenerationGateway; claim: NamingClaim; provider: NamingGenerationProvider; policy: NamingGenerationPolicy;
  signal: AbortSignal; now?: () => number; timing?: Partial<NamingGenerationTiming> }): Promise<string> {
  const { gateway, claim, provider, policy } = options, input = claim.input, timing = { ...NAMING_GENERATION_TIMING, ...options.timing }, now = options.now ?? Date.now;
  const deadlineAt = now() + timing.deadlineMs, halt = new AbortController();
  let reason: Halt | null = null, cancelRequested = claim.run.state === "cancel_requested", stopRounds = false, beating: Promise<void> | null = null;
  const stopWith = (value: Halt) => { if (reason) return; reason = value; halt.abort(); };
  const onStop = () => stopWith("stopped");
  options.signal.addEventListener("abort", onStop, { once: true });
  if (options.signal.aborted) onStop();
  if (cancelRequested) stopWith("cancelled");
  const left = () => reason === "stopped" || reason === "lease_lost";
  /** The job is left for `expire`/`recover`; only `finish` reports a terminal state. */
  const abandoned = () => left() ? reason! : "unsettled";
  const state: NamingRoundState & { saved: NamingSavedCandidate[] } = { jobId: claim.job.id, identities: claim.identities, saved: [], savedCount: claim.run.savedCount };
  const claimed = [...claim.rounds].sort((a, b) => a.round - b.round), rounds = claimed.map(row => ({ round: row.round, state: row.state }));

  /** Every database action gets 3 attempts with a short backoff. The SQL actions
   * replay safely: a repeated begin, save or failure returns the first result. */
  async function act(action: string, args: Record<string, unknown>): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try { return await gateway.invoke(action, args); }
      catch (error) {
        if (attempt >= timing.retryDelaysMs.length || left()) throw error;
        await pause(timing.retryDelaysMs[attempt]!, options.signal);
      }
    }
  }
  const beat = async () => {
    try {
      if (heartbeatSchema.parse(await act("heartbeat", { leaseSeconds: NAMING_LEASE_SECONDS })).cancelRequested) { cancelRequested = true; stopWith("cancelled"); }
    } catch { if (!options.signal.aborted) stopWith("lease_lost"); }
  };
  const heartbeat = setInterval(() => { beating ??= beat().finally(() => { beating = null; }); }, timing.heartbeatMs);
  heartbeat.unref();
  const deadline = setTimeout(() => stopWith("deadline"), Math.max(0, deadlineAt - now()));
  deadline.unref();

  async function cancelResponse(responseId: string) { await provider.cancel(responseId, AbortSignal.timeout(timing.cancelTimeoutMs)).catch(() => {}); }
  async function finish(): Promise<string> {
    // Without the lease or during shutdown, the next claim or `expire` settles the job.
    if (left()) return abandoned();
    try { return finishSchema.parse(await act("finish", {})).state; } catch { return abandoned(); }
  }
  /** False means the job is left for `expire`; otherwise the round is terminal. */
  async function fail(round: number, code: NamingRunErrorCode, responseId: string | null, usage: NamingUsage | null): Promise<boolean> {
    if (left()) return false;
    try { await act("round_failed", { round, code, responseId, usage }); }
    catch { return false; }
    rounds.find(row => row.round === round)!.state = "failed";
    if (STOPPING_CODES.has(code)) stopRounds = true;
    return true;
  }
  async function save(round: number, responseId: string, candidates: NamingSavedCandidate[], usage: NamingUsage | null): Promise<boolean> {
    try { state.savedCount = savedSchema.parse(await act("round_saved", { round, responseId, model: policy.model, usage, candidates })).savedCount; }
    catch { return fail(round, "save_failed", responseId, usage); }
    state.saved.push(...candidates); rounds.find(row => row.round === round)!.state = "saved";
    return true;
  }
  async function poll(responseId: string, limitMs: number): Promise<Polled> {
    const until = now() + limitMs;
    for (;;) {
      if (halt.signal.aborted) return { kind: "halted" };
      try {
        const { response } = await provider.retrieve(responseId, AbortSignal.any([halt.signal, AbortSignal.timeout(Math.max(1, Math.min(timing.requestTimeoutMs, until - now())))]));
        if (response.id !== responseId) return { kind: "unreadable", code: "invalid_output" };
        if (typeof response.status === "string" && TERMINAL_RESPONSES.has(response.status)) return { kind: "terminal", response };
      } catch (error) {
        if (halt.signal.aborted) return { kind: "halted" };
        // A missing or refused response stays unreadable; rate limits, network
        // and server errors are retried until the round's limit.
        if (error instanceof NamingProviderError && error.code === "protocol_limit") return { kind: "unreadable", code: "invalid_output" };
        if (error instanceof NamingProviderError && error.code === "request_rejected" && error.status !== 429) return { kind: "unreadable", code: "response_failed" };
      }
      if (now() >= until) return { kind: "timeout" };
      await pause(Math.min(timing.pollMs, until - now()), halt.signal);
    }
  }
  /** Poll a round whose receipt number is saved, then save or fail it. */
  async function settle(round: number, responseId: string): Promise<boolean> {
    const polled = await poll(responseId, Math.min(timing.roundTimeoutMs, Math.max(0, deadlineAt - now())));
    switch (polled.kind) {
      case "terminal": {
        const usage = usageOf(polled.response);
        if (polled.response.status !== "completed") return fail(round, "response_failed", responseId, usage);
        const candidates = parseRoundCandidates(polled.response, { input, state, round, policy });
        return candidates ? save(round, responseId, candidates, usage) : fail(round, "invalid_output", responseId, usage);
      }
      case "unreadable": return fail(round, polled.code, responseId, null);
      // A round cut short by the run's deadline also did not finish in time.
      case "timeout": await cancelResponse(responseId); return fail(round, "response_timeout", responseId, null);
      case "halted":
        // A shutdown or lost lease leaves the receipt for the next claim to poll.
        if (left()) return false;
        await cancelResponse(responseId);
        return fail(round, reason === "deadline" ? "response_timeout" : "response_failed", responseId, null);
    }
  }
  try {
    // A request whose receipt number was never saved cannot be resumed.
    if (rounds.some(row => row.state === "sending" || row.state === "interrupted")) return await finish();
    for (const row of claimed) {
      if (row.state !== "sent" || !row.responseId) continue;
      if (!await settle(row.round, row.responseId)) return abandoned();
    }
    while (state.savedCount < NAMING_RUN_TARGET && rounds.length < NAMING_MAX_ROUNDS && !cancelRequested && !reason && !stopRounds && deadlineAt - now() >= timing.roundTimeoutMs) {
      const round = rounds.length + 1;
      let request: NamingGenerationWire;
      try { request = buildNamingRoundRequest(input, state, round, policy); } catch { break; }
      try { await act("round_begin", { round, request }); } catch { return await finish(); }
      rounds.push({ round, state: "sending" });
      let receipt: Awaited<ReturnType<NamingGenerationProvider["create"]>>;
      // Only a shutdown or the request's own timeout interrupts the create call:
      // a cancel or deadline waits for the receipt number so the work can be stopped.
      try { receipt = await provider.create(request, AbortSignal.any([options.signal, AbortSignal.timeout(timing.requestTimeoutMs)])); }
      catch (error) {
        if (error instanceof NamingProviderError && error.code === "request_rejected") { if (!await fail(round, "provider_rejected", null, null)) return abandoned(); continue; }
        // The request may exist without a saved receipt number. It is never sent again.
        return await finish();
      }
      try { await act("round_sent", { round, responseId: receipt.responseId, requestId: receipt.requestId }); }
      catch { if (!left()) await cancelResponse(receipt.responseId); return await finish(); }
      rounds.at(-1)!.state = "sent";
      if (!await settle(round, receipt.responseId)) return abandoned();
    }
    return await finish();
  } catch {
    // Defensive: an unexpected local error still settles the run.
    return await finish();
  } finally {
    clearInterval(heartbeat); clearTimeout(deadline); options.signal.removeEventListener("abort", onStop);
    await beating;
  }
}
