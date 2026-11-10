import "server-only";
import { z } from "zod";
import {
  allocateBrainstormApproaches,
  filterNamingBrainstormCandidates,
  type ApproachSlot,
} from "@/domain/naming-brainstorm";
import { namingApproachSchema, type NamingApproach } from "@/domain/naming-brain-preferences";
import {
  cleanGeneratedCandidate,
  namingSavedCandidateSchema,
  NAMING_RUN_TARGET,
  type NamingSavedCandidate,
} from "@/domain/naming-generation";
import {
  NAMING_GENERATION_FORMAT,
  NAMING_GENERATION_PROFILE,
  NAMING_GENERATION_REQUEST_BYTES,
} from "@/domain/naming-generation-wire";
import type { ResponsesRequest } from "../ai/openai-transport";
import { LUNA_PRICES } from "../ai/config";
import {
  NAMING_PROMPT_EXCLUSION_LIMITS,
  namingPrompt,
  namingReplyCandidates,
  namingReplyFormat,
} from "../ai/naming-prompt";
import { NAMING_KIND, namingEnginePolicy, namingRunInputSchema, type NamingRunInput } from "./naming";
import {
  EngineProviderError,
  isTerminal,
  responseUsage,
  type BackgroundResponse,
  type EngineOpenAI,
  type ResponseUsage,
} from "./openai";

// The Naming workflow's step logic, with the provider and the engine database passed in so
// tests can stub both. Each exported function is one durable step; none of them retries itself.
//
// Why rounds used to come up short: one request asked for 120 names, so its reply ran close
// to the output limit and the round's time limit. A reply cut off there ("incomplete") or a
// round that timed out saved nothing at all. Here a round sends up to three smaller requests
// side by side (about 40 names each), saves each reply's names as soon as it finishes, and
// keeps every saved name whatever happens to the other requests or later rounds.

export const NAMING_MAX_ROUNDS = 3;
/** Names one request asks for, at most. Small enough to finish well inside the output limit. */
export const NAMING_REQUEST_CANDIDATES = 40;
export const NAMING_MAX_PARALLEL = 3;
const FIRST_ROUND_CANDIDATES = 120,
  LATER_ROUND_CANDIDATES = 80,
  MAX_OUTPUT_TOKENS = 16_000;

/** The run as engine_claim returns it. */
export type ClaimedNamingRun = { id: string; ownerId: string; projectId: string; kind: string; input: unknown };
export type EngineRunCheck = { status: string; cancelRequested: boolean; paused: boolean };
/** What a run has saved so far: the database's count, the identities this run proposed and
 * the approaches of the names it saved. Plain data, carried by the workflow between steps. */
export type NamingRunState = { savedCount: number; identities: string[]; approaches: NamingApproach[] };
/** One OpenAI request of a round and its share of the round's approach plan. */
export type NamingRequestPlan = {
  key: string;
  round: number;
  index: number;
  candidateTarget: number;
  admit: number;
  slots: ApproachSlot[];
  finalFill: boolean;
};
export type NamingOpenRequest = { plan: NamingRequestPlan; responseId: string };
export type NamingPollResult = { state: "pending"; finished: string[] } | { state: "stop"; code: string };
export type NamingSettleResult = { state: NamingRunState; code: string | null };
export type NamingTokens = { inputTokens: number; outputTokens: number; totalTokens: number };

export const namingSaveResultSchema = z.object({
  saved: z.boolean(),
  inserted: z.array(z.string()).max(NAMING_RUN_TARGET),
  savedCount: z.number().int().min(0).max(NAMING_RUN_TARGET),
});
export type NamingSaveResult = z.infer<typeof namingSaveResultSchema>;
export type NamingRunDeps = {
  openai: EngineOpenAI;
  check(runId: string): Promise<EngineRunCheck>;
  /** engine_save_output; false when the run already ended. */
  save(
    runId: string,
    outputKey: string,
    output: unknown,
    responseId: string | null,
    costMicrousd: number,
  ): Promise<boolean>;
  /** engine_save_names; null when the run already ended. */
  saveNames(
    runId: string,
    outputKey: string,
    output: unknown,
    responseId: string,
    costMicrousd: number,
  ): Promise<NamingSaveResult | null>;
};

/** A known, permanent reason the run can't continue. Its code becomes the run's error code. */
export class NamingRunError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "NamingRunError";
  }
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Validates the frozen input against this deployment's Naming policy. */
export function readNamingRun(run: ClaimedNamingRun): { input: NamingRunInput } {
  const parsed = namingRunInputSchema.safeParse(run.input);
  if (run.kind !== NAMING_KIND || !parsed.success) throw new NamingRunError("invalid_run_input");
  if (JSON.stringify(parsed.data.policy) !== JSON.stringify(namingEnginePolicy()))
    throw new NamingRunError("policy_mismatch");
  return { input: parsed.data };
}

const excludedIdentities = (input: NamingRunInput, state: NamingRunState) => [
  ...new Set([...input.exclusions, ...state.identities]),
];

/**
 * The requests of one round. The first round asks for 120 names, as before; later rounds ask
 * for what is missing plus 20, at most 80. The round's approach plan (each open place goes to
 * the least represented selected approach) is split across up to three requests of about 40
 * names, each approach spread over different requests.
 */
export function planNamingRequests(input: NamingRunInput, state: NamingRunState, round: number): NamingRequestPlan[] {
  const remaining = Math.max(0, NAMING_RUN_TARGET - state.savedCount);
  if (!remaining || round < 1 || round > NAMING_MAX_ROUNDS) return [];
  const roundTarget = round === 1 ? FIRST_ROUND_CANDIDATES : Math.min(LATER_ROUND_CANDIDATES, remaining + 20);
  const slots = allocateBrainstormApproaches(
    input.brief.preferences.approaches,
    state.approaches,
    remaining,
    roundTarget,
  );
  const count = Math.min(NAMING_MAX_PARALLEL, Math.ceil(roundTarget / NAMING_REQUEST_CANDIDATES));
  const parts = Array.from({ length: count }, () => ({ slots: [] as ApproachSlot[], candidateTarget: 0, admit: 0 }));
  for (const slot of [...slots].sort((a, b) => b.request - a.request || a.approach.localeCompare(b.approach))) {
    const pieces = Math.max(1, Math.min(count, slot.admit, slot.request));
    for (let piece = 0; piece < pieces; piece++) {
      const request = Math.floor(slot.request / pieces) + (piece < slot.request % pieces ? 1 : 0);
      const admit = Math.floor(slot.admit / pieces) + (piece < slot.admit % pieces ? 1 : 0);
      const target = parts
        .filter((part) => !part.slots.some((row) => row.approach === slot.approach))
        .reduce((a, b) => (b.candidateTarget < a.candidateTarget ? b : a));
      target.slots.push({ approach: slot.approach, admit, request });
      target.candidateTarget += request;
      target.admit += admit;
    }
  }
  return parts
    .filter((part) => part.slots.length)
    .map((part, index) => ({
      key: `round.${round}.${index + 1}`,
      round,
      index: index + 1,
      candidateTarget: part.candidateTarget,
      admit: part.admit,
      slots: part.slots,
      finalFill: round >= NAMING_MAX_ROUNDS,
    }));
}

/** The exact OpenAI request of one planned request: the shared Naming instructions, its
 * approach plan and the names to avoid. The exclusion hint shrinks if the request gets too large. */
export function namingResponseRequest(
  runId: string,
  input: NamingRunInput,
  plan: NamingRequestPlan,
  state: NamingRunState,
): ResponsesRequest {
  const schema = namingReplyFormat(plan.candidateTarget, plan.slots),
    excluded = excludedIdentities(input, state);
  for (const limit of NAMING_PROMPT_EXCLUSION_LIMITS) {
    const request = {
      model: input.policy.model,
      reasoning: { effort: input.policy.reasoningEffort },
      max_output_tokens: MAX_OUTPUT_TOKENS,
      input: namingPrompt({
        candidateTarget: plan.candidateTarget,
        slots: plan.slots,
        brief: input.brief,
        excluded,
        limit,
      }),
      text: { verbosity: "low", format: { type: "json_schema", name: NAMING_GENERATION_FORMAT, strict: true, schema } },
      metadata: { embel_generation_profile: NAMING_GENERATION_PROFILE, embel_run_id: runId, embel_request: plan.key },
    };
    if (bytes(request) <= NAMING_GENERATION_REQUEST_BYTES) return request;
  }
  throw new NamingRunError("invalid_run_input");
}

/** A finished reply → its checked names, or null when it has no usable JSON or came from
 * another model. Never throws on provider content; text is cleaned before any check. */
export function namingReplyNames(
  body: unknown,
  input: NamingRunInput,
  plan: NamingRequestPlan,
  state: NamingRunState,
): { names: NamingSavedCandidate[]; proposed: number } | null {
  if (!record(body) || body.model !== input.policy.model) return null;
  const raw = namingReplyCandidates(body, plan.candidateTarget);
  if (!raw) return null;
  const accepted = filterNamingBrainstormCandidates(
    raw.map(cleanGeneratedCandidate),
    input.brief.preferences,
    excludedIdentities(input, state),
    plan.admit,
    plan.slots,
    plan.finalFill,
  );
  const names = accepted.flatMap(({ value, rationale, primaryApproach, identityKey }) => {
    const parsed = namingSavedCandidateSchema.safeParse({ value, rationale, primaryApproach, identityKey });
    return parsed.success ? [parsed.data] : [];
  });
  return { names, proposed: raw.length };
}

/** gpt-6-luna Standard prices, rounded up to a whole microdollar. Not shown to people. */
export function namingCostMicrousd(usage: ResponseUsage): number {
  const details = usage.input_tokens_details,
    ordinary = usage.input_tokens - details.cached_tokens - details.cache_write_tokens;
  const numerator =
    BigInt(ordinary) * BigInt(LUNA_PRICES.inputMicrousdPerMillionTokens) +
    BigInt(details.cached_tokens) * BigInt(LUNA_PRICES.cachedInputMicrousdPerMillionTokens) +
    BigInt(details.cache_write_tokens) * BigInt(LUNA_PRICES.cacheWriteMicrousdPerMillionTokens) +
    BigInt(usage.output_tokens) * BigInt(LUNA_PRICES.outputMicrousdPerMillionTokens);
  return Number((numerator + 999_999n) / 1_000_000n);
}
const tokensOf = (usage: ResponseUsage): NamingTokens => ({
  inputTokens: usage.input_tokens,
  outputTokens: usage.output_tokens,
  totalTokens: usage.total_tokens,
});

/** Validates the run and plans one round. */
export function planNamingRound(run: ClaimedNamingRun, state: NamingRunState, round: number): NamingRequestPlan[] {
  return planNamingRequests(readNamingRun(run).input, state, round);
}

/** One paid background create. Its outcome is never guessed: an uncertain create is not re-sent. */
export async function createNamingAttempt(
  openai: EngineOpenAI,
  run: ClaimedNamingRun,
  plan: NamingRequestPlan,
  state: NamingRunState,
): Promise<{ responseId: string }> {
  const { input } = readNamingRun(run);
  const response = await openai.create(
    namingResponseRequest(run.id, input, plan, state),
    `naming:${run.id}:${plan.key}`,
  );
  return { responseId: response.id };
}

/** Between polls: stop when the run was cancelled, the engine paused or the run ended
 * elsewhere; otherwise look each open response up by id and list the finished ones. */
export async function pollNamingAttempts(
  deps: NamingRunDeps,
  runId: string,
  responseIds: readonly string[],
): Promise<NamingPollResult> {
  const state = await deps.check(runId);
  if (state.status !== "running") return { state: "stop", code: "cancelled" };
  if (state.cancelRequested || state.paused)
    return { state: "stop", code: state.paused ? "generation_paused" : "cancelled" };
  const finished: string[] = [];
  for (const responseId of responseIds) {
    try {
      if (isTerminal((await deps.openai.retrieve(responseId)).status)) finished.push(responseId);
    } catch (error) {
      // OpenAI no longer knows this response; settling records it as failed.
      if (error instanceof EngineProviderError && error.disposition === "rejected") finished.push(responseId);
      else throw error;
    }
  }
  return { state: "pending", finished };
}

async function recordFailure(
  deps: NamingRunDeps,
  runId: string,
  plan: NamingRequestPlan,
  state: NamingRunState,
  code: string,
  responseId: string | null,
  usage: NamingTokens | null,
  costMicrousd = 0,
): Promise<NamingSettleResult> {
  await deps.save(
    runId,
    plan.key,
    { state: "failed", round: plan.round, request: plan.index, code, usage },
    responseId,
    costMicrousd,
  );
  return { state, code };
}

/** Saves one finished reply: its checked names with the response id and cost, or the reason
 * it gave none. A stopped request that still finished keeps its names. */
async function recordReply(
  deps: NamingRunDeps,
  runId: string,
  input: NamingRunInput,
  plan: NamingRequestPlan,
  state: NamingRunState,
  response: BackgroundResponse,
  stopCode: string | null,
): Promise<NamingSettleResult> {
  const observed = responseUsage(response.body);
  const usage = observed ? tokensOf(observed.usage) : null,
    cost = observed ? namingCostMicrousd(observed.usage) : 0;
  if (response.status !== "completed")
    return recordFailure(deps, runId, plan, state, stopCode ?? "response_failed", response.id, usage, cost);
  const reply = namingReplyNames(response.body, input, plan, state);
  if (!reply) return recordFailure(deps, runId, plan, state, "invalid_output", response.id, usage, cost);
  const saved = await deps.saveNames(
    runId,
    plan.key,
    {
      state: "saved",
      round: plan.round,
      request: plan.index,
      model: input.policy.model,
      usage,
      proposed: reply.proposed,
      names: reply.names,
    },
    response.id,
    cost,
  );
  // The run already ended; there is nothing left to record on.
  if (!saved) return { state, code: null };
  const inserted = new Set(saved.inserted);
  return {
    state: {
      savedCount: saved.savedCount,
      identities: [...new Set([...state.identities, ...reply.names.map((name) => name.identityKey)])],
      approaches: [
        ...state.approaches,
        ...reply.names
          .filter((name) => inserted.has(name.identityKey))
          .map((name) => namingApproachSchema.parse(name.primaryApproach)),
      ],
    },
    code: inserted.size ? null : "no_names",
  };
}

/** Reads a finished response and saves what it produced. */
export async function settleNamingAttempt(
  deps: NamingRunDeps,
  run: ClaimedNamingRun,
  plan: NamingRequestPlan,
  state: NamingRunState,
  responseId: string,
): Promise<NamingSettleResult> {
  const { input } = readNamingRun(run);
  let response: BackgroundResponse;
  try {
    response = await deps.openai.retrieve(responseId);
  } catch (error) {
    if (error instanceof EngineProviderError && error.disposition === "rejected")
      return recordFailure(deps, run.id, plan, state, "response_failed", responseId, null);
    throw error;
  }
  if (!isTerminal(response.status)) throw new EngineProviderError("retry", null);
  return recordReply(deps, run.id, input, plan, state, response, null);
}

/** Cancels each open response at OpenAI (idempotent) and records it with its cost so far.
 * A response that finished before the cancel keeps its names. */
export async function stopNamingAttempts(
  deps: NamingRunDeps,
  run: ClaimedNamingRun,
  open: readonly NamingOpenRequest[],
  state: NamingRunState,
  code: string,
): Promise<NamingRunState> {
  const { input } = readNamingRun(run);
  let current = state;
  for (const item of open) {
    let response: BackgroundResponse | null = null;
    try {
      response = await deps.openai.cancel(item.responseId);
    } catch (error) {
      // A response OpenAI no longer knows can't be cancelled; anything transient is retried.
      if (!(error instanceof EngineProviderError) || error.disposition !== "rejected") throw error;
    }
    current = (
      response && isTerminal(response.status)
        ? await recordReply(deps, run.id, input, item.plan, current, response, code)
        : await recordFailure(deps, run.id, item.plan, current, code, item.responseId, null)
    ).state;
  }
  return current;
}

/** Records a request that never reached OpenAI, or whose create had an unknown outcome. */
export async function recordNamingFailure(
  deps: NamingRunDeps,
  runId: string,
  plan: NamingRequestPlan,
  code: string,
): Promise<void> {
  await deps.save(
    runId,
    plan.key,
    { state: "failed", round: plan.round, request: plan.index, code, usage: null },
    null,
    0,
  );
}

/** The run's error code when it saved no names: "no_names" when replies came back but none
 * passed the checks, otherwise the last failure. */
export function namingFailureCode(codes: readonly string[]): string {
  if (codes.includes("no_names")) return "no_names";
  const last = codes.at(-1);
  return last && /^[a-z_]{1,64}$/u.test(last) ? last : "no_names";
}
