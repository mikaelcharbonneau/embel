import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { contextSnapshotSchema } from "../../src/domain/projects";
import { namingStrategyBasis } from "../../src/domain/project-naming";
import { namingBrainstormIdentity } from "../../src/domain/naming-brainstorm";
import type { NamingApproach } from "../../src/domain/naming-brain-preferences";
import { namingClaimSchema, namingRunInputSchema, type NamingClaim, type NamingGenerationPolicy, type NamingRound, type NamingSavedCandidate } from "../../src/domain/naming-generation";
import type { NamingGenerationWire } from "../../src/domain/naming-generation-wire";
import { createNamingGenerationProvider, NamingProviderError, type NamingGenerationProvider } from "../../src/server/ai/naming-generation-provider";
import { buildNamingRoundRequest, parseRoundCandidates, planNamingRound, runNamingGeneration, type NamingGenerationGateway, type NamingGenerationTiming, type NamingRoundState } from "../../worker/naming-generation";

/** Synthetic data only: a fake gateway stands in for SQL and a fake provider for
 * OpenAI. Provider tests use an inert fetch; nothing reaches a network. */
const id = (n: number) => `62000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = "a".repeat(64), model = "gpt-fixture-naming";
const policy: NamingGenerationPolicy = { version: 2, operation: "naming.generate", model, reasoningEffort: "low" };
const fast: Partial<NamingGenerationTiming> = { heartbeatMs: 1_000_000, pollMs: 1, roundTimeoutMs: 500, deadlineMs: 20_000, requestTimeoutMs: 1_000, cancelTimeoutMs: 100, retryDelaysMs: [0, 0] };
const OWNED = namingBrainstormIdentity("Ownedname");

function runInput(approaches: NamingApproach[] = ["invented"]) {
  return namingRunInputSchema.parse({ version: 3, kind: "steer", runId: id(3), target: 100, policyIdentity: hash, brief: { version: 1, contextRevision: 1, preferencesVersion: 1,
    preferences: { version: 2, creativeLocale: "en", notes: "", minimumGraphemes: null, maximumGraphemes: null, approaches, directness: "all", sourceLanguages: ["French"], heritageNotes: "", culturalNotes: "", requiredText: [], excludedText: [] },
    strategyBasis: namingStrategyBasis(contextSnapshotSchema.parse({ description: "Synthetic fixture: a garden planning service." })),
    likedExamples: [{ value: "Liked Fixture" }], strongSeeds: [{ value: "Seed Fixture", rationale: "A synthetic seed rationale." }], recentExamples: [{ value: "Recent Fixture" }],
    steeringInstruction: "Warmer, more tactile synthetic names." } });
}
function claimFor(options: { approaches?: NamingApproach[]; rounds?: NamingRound[]; savedCount?: number; identities?: string[] } = {}): NamingClaim {
  const input = runInput(options.approaches);
  return namingClaimSchema.parse({
    job: { id: id(4), owner_id: id(1), project_id: id(2), lease_token: id(6), operation: "naming.generate", attempts: 1, max_attempts: 3 },
    run: { runId: input.runId, jobId: id(4), kind: input.kind, state: "running", target: 100, savedCount: options.savedCount ?? 0, errorCode: null, usage: null, createdAt: "2026-11-08T12:00:00Z", finishedAt: null },
    input, rounds: options.rounds ?? [], identities: options.identities ?? [OWNED],
  });
}
const roundState = (claim: NamingClaim, saved: NamingSavedCandidate[] = [], savedCount = saved.length): NamingRoundState => ({ jobId: claim.job.id, identities: claim.identities, saved, savedCount });
const promptJson = (request: NamingGenerationWire) => JSON.parse(request.input.split("\n").at(-1)!) as Record<string, unknown> & { approachPlan: { approach: NamingApproach; admit: number; request: number }[]; excludedIdentities: string[] };
/** Valid synthetic names that follow a request's approach plan. */
function namesFor(request: NamingGenerationWire, count: number, prefix: string) {
  const requested = promptJson(request).approachPlan.flatMap(row => Array.from({ length: row.request }, () => row.approach));
  return Array.from({ length: count }, (_, index) => {
    const primaryApproach = requested[index % requested.length]!, value = `${prefix}name${index}`;
    return { value, rationale: "Fixture imagery for this synthetic brief.", primaryApproach, construction: primaryApproach === "invented" ? [] : primaryApproach === "real_words" ? [value] : ["Fixture"] };
  });
}
const message = (text: string) => ({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
const completed = (candidates: unknown[], extra: Record<string, unknown> = {}) => ({ status: "completed", model, output: [{ type: "reasoning", summary: [] }, message(JSON.stringify({ candidates }))], usage: { input_tokens: 80, output_tokens: 60, total_tokens: 140 }, ...extra });

type Reply = { pending?: number; final: Record<string, unknown> } | Error;
function fakeProvider(script: (request: NamingGenerationWire, index: number) => Reply, seeded: Record<string, { pending?: number; final: Record<string, unknown> }> = {}) {
  const created: NamingGenerationWire[] = [], retrieved: string[] = [], cancelled: string[] = [];
  const responses = new Map(Object.entries(seeded).map(([key, value]) => [key, { pending: value.pending ?? 0, final: value.final }]));
  const provider: NamingGenerationProvider = {
    async create(request) {
      created.push(structuredClone(request)); const reply = script(request, created.length);
      if (reply instanceof Error) throw reply;
      const responseId = `resp_fake_${created.length}`; responses.set(responseId, { pending: reply.pending ?? 0, final: reply.final });
      return { responseId, requestId: `req_fake_${created.length}`, status: "queued" };
    },
    async retrieve(responseId) {
      retrieved.push(responseId); const row = responses.get(responseId);
      if (!row) throw new NamingProviderError("request_rejected", null, 404);
      if (row.pending > 0) { row.pending--; return { response: { id: responseId, status: "in_progress", model }, requestId: null }; }
      return { response: { ...row.final, id: responseId }, requestId: "req_read" };
    },
    async cancel(responseId) { cancelled.push(responseId); },
  };
  return { provider, created, retrieved, cancelled };
}
/** Mirrors the contract's SQL rules closely enough for the worker loop. */
function fakeGateway(claim: NamingClaim, options: { fail?: Record<string, number>; cancelOnSave?: boolean } = {}) {
  const calls: { action: string; args: Record<string, unknown>; raw: string }[] = [], failures = { ...options.fail }, waiting: (() => void)[] = [];
  const rounds = new Map(claim.rounds.map(row => [row.round, { state: row.state as string, code: row.errorCode }]));
  const identities = new Set(claim.identities); let savedCount = claim.run.savedCount, cancel = false;
  const gateway: NamingGenerationGateway = { async invoke(action, args) {
    const raw = JSON.stringify(args), a = args as Record<string, unknown>; calls.push({ action, args: JSON.parse(raw), raw });
    if ((failures[action] ?? 0) > 0) { failures[action]!--; throw Error("synthetic database failure"); }
    switch (action) {
      case "heartbeat": { const result = { cancelRequested: cancel }; setTimeout(() => waiting.splice(0).forEach(resolve => resolve()), 0); return result; }
      case "round_begin": if (cancel) throw Error("naming_cancel_requested"); rounds.set(Number(a.round), { state: "sending", code: null }); return { round: a.round, state: "sending" };
      case "round_sent": rounds.get(Number(a.round))!.state = "sent"; return { round: a.round, state: "sent" };
      case "round_saved": {
        let inserted = 0;
        for (const candidate of a.candidates as NamingSavedCandidate[]) { if (savedCount >= 100 || identities.has(candidate.identityKey)) continue; identities.add(candidate.identityKey); savedCount++; inserted++; }
        rounds.get(Number(a.round))!.state = "saved";
        if (options.cancelOnSave) { cancel = true; await new Promise<void>(resolve => waiting.push(resolve)); }
        return { inserted, savedCount };
      }
      case "round_failed": Object.assign(rounds.get(Number(a.round))!, { state: "failed", code: a.code }); return { round: a.round, state: "failed" };
      case "finish": return { state: cancel ? "cancelled" : savedCount ? "succeeded" : "failed", savedCount };
    }
    throw Error("unexpected_action");
  } };
  return { gateway, calls, rounds, actions: () => calls.map(call => call.action), args: (action: string) => calls.filter(call => call.action === action).map(call => call.args), savedCount: () => savedCount };
}
const run = (claim: NamingClaim, gateway: NamingGenerationGateway, provider: NamingGenerationProvider, timing: Partial<NamingGenerationTiming> = {}, signal = new AbortController().signal) =>
  runNamingGeneration({ gateway, claim, provider, policy, signal, timing: { ...fast, ...timing } });

describe("Naming round request", () => {
  it("allocates approaches, bounds the reply and freezes background metadata", () => {
    const claim = claimFor({ approaches: ["real_words", "invented", "other_languages"] }), request = buildNamingRoundRequest(claim.input, roundState(claim), 1, { ...policy, reasoningEffort: "medium" });
    const plan = promptJson(request).approachPlan;
    expect(plan.map(row => row.approach)).toEqual(["real_words", "invented", "other_languages"]);
    expect(plan.reduce((sum, row) => sum + row.admit, 0)).toBe(100); expect(plan.reduce((sum, row) => sum + row.request, 0)).toBe(120);
    expect(plan.map(({ approach, admit, request }) => ({ approach, admit, request }))).toEqual([{ approach: "real_words", admit: 34, request: 41 }, { approach: "invented", admit: 33, request: 40 }, { approach: "other_languages", admit: 33, request: 39 }]);
    expect(request).toMatchObject({ model, background: true, store: true, stream: false, reasoning: { effort: "medium" }, max_output_tokens: 16000,
      metadata: { embel_generation_profile: "naming_generation_v2", embel_job_id: claim.job.id, embel_run_id: claim.input.runId, embel_round: "1" } });
    const schema = request.text.format.schema as { properties: { candidates: { maxItems: number; items: { properties: { primaryApproach: { enum: string[] } } } } } };
    expect(schema.properties.candidates.maxItems).toBe(120); expect(schema.properties.candidates.items.properties.primaryApproach.enum).toEqual(["real_words", "invented", "other_languages"]);
    expect(request).not.toHaveProperty("tools"); expect(request).not.toHaveProperty("previous_response_id");
  });
  it("asks later rounds for what is missing plus 20 and favors under-represented approaches", () => {
    const claim = claimFor({ approaches: ["real_words", "invented"] });
    const saved = Array.from({ length: 70 }, (_, index): NamingSavedCandidate => ({ value: `Savedname${index}`, rationale: "Synthetic.", primaryApproach: index < 50 ? "invented" : "real_words", identityKey: `savedname${index}` }));
    const later = planNamingRound(claim.input, roundState(claim, saved), 2);
    expect(later.candidateTarget).toBe(50);
    // 50 invented and 20 real words are saved, so all 30 open places go to real words.
    expect(later.slots).toEqual([{ approach: "real_words", admit: 30, request: 50 }]);
    expect(planNamingRound(claim.input, roundState(claim, [], 10), 2).candidateTarget).toBe(60);
    const request = buildNamingRoundRequest(claim.input, roundState(claim, saved), 3, policy);
    expect(request.metadata.embel_round).toBe("3"); expect(promptJson(request).excludedIdentities).toEqual(expect.arrayContaining([OWNED, "savedname0", "savedname69"]));
  });
  it("puts steering, seeds, likes and recent names in the prompt, without retired pattern summaries", () => {
    const claim = claimFor(), json = promptJson(buildNamingRoundRequest(claim.input, roundState(claim), 1, policy));
    expect(json).toMatchObject({ steering: "Warmer, more tactile synthetic names.", seeds: [{ value: "Seed Fixture", rationale: "A synthetic seed rationale." }], likes: ["Liked Fixture"], recentNamesToAvoid: ["Recent Fixture"], excludedIdentities: [OWNED] });
    expect(json).not.toHaveProperty("patterns"); expect(json.product).toMatchObject({ description: "Synthetic fixture: a garden planning service." });
  });
  it("shortens the exclusion hint so a large project stays within the request bound", () => {
    const identities = Array.from({ length: 5000 }, (_, index) => `${"x".repeat(300)}${index}`), claim = claimFor({ identities });
    const request = buildNamingRoundRequest(claim.input, roundState(claim), 1, policy);
    expect(new TextEncoder().encode(JSON.stringify(request)).byteLength).toBeLessThanOrEqual(131_072);
    expect(promptJson(request).excludedIdentities).toEqual(identities.slice(-100));
  });
});

describe("Naming reply parsing", () => {
  const claim = claimFor(), context = { input: claim.input, state: roundState(claim), round: 1, policy };
  const request = buildNamingRoundRequest(claim.input, roundState(claim), 1, policy);
  it("keeps a NUL character in an explanation away from the database without throwing", () => {
    const names = [{ value: "Nulfixture", rationale: "Before\u0000after, a synthetic rationale.", primaryApproach: "invented", construction: [] }, ...namesFor(request, 5, "Clean")];
    const response = completed(names);
    expect(JSON.stringify(response)).toContain("\\u0000");
    let parsed: NamingSavedCandidate[] | null = null;
    expect(() => { parsed = parseRoundCandidates(response, context); }).not.toThrow();
    expect(parsed).not.toBeNull(); expect(JSON.stringify(parsed)).not.toMatch(/\u0000|\\u0000/u);
    expect(parsed!.map(row => row.value)).toEqual(expect.arrayContaining(["Cleanname0", "Cleanname4"]));
    // The explanation is repaired, so the good name is kept.
    expect(parsed!.find(row => row.value === "Nulfixture")?.rationale).toBe("Beforeafter, a synthetic rationale.");
  });
  it("returns null for a reply without one usable JSON list", () => {
    expect(parseRoundCandidates({ status: "completed", model, output: [message('{"candidates": [')] }, context)).toBeNull();
    expect(parseRoundCandidates(completed(namesFor(request, 121, "Over")), context)).toBeNull();
    expect(parseRoundCandidates({ ...completed([]), output: [message("{\"candidates\":[]}"), message("{\"candidates\":[]}")] }, context)).toBeNull();
    expect(parseRoundCandidates({ ...completed([]), output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "no" }] }] }, context)).toBeNull();
    expect(parseRoundCandidates({ ...completed(namesFor(request, 3, "Late")), status: "incomplete" }, context)).toBeNull();
  });
  it("refuses a reply from another model", () => {
    expect(parseRoundCandidates(completed(namesFor(request, 3, "Other"), { model: "gpt-unapproved" }), context)).toBeNull();
  });
  it("drops duplicates, owned names and invalid items, and maps saved fields only", () => {
    const valid = namesFor(request, 3, "Dupe");
    const parsed = parseRoundCandidates(completed([...valid, { ...valid[0]!, value: "DUPENAME0" }, { ...valid[1]!, value: "Ownedname" }, { value: "", rationale: "", primaryApproach: "invented", construction: [] }, "not an object"]), context)!;
    expect(parsed.map(row => row.value)).toEqual(["Dupename0", "Dupename1", "Dupename2"]);
    expect(parsed[0]).toEqual({ value: "Dupename0", rationale: "Fixture imagery for this synthetic brief.", primaryApproach: "invented", identityKey: "dupename0" });
  });
});

describe("Naming worker loop", () => {
  it("saves 100 names in one round", async () => {
    const claim = claimFor(), g = fakeGateway(claim), p = fakeProvider(request => ({ pending: 2, final: completed([{ value: "Ownedname", rationale: "Fixture imagery for this synthetic brief.", primaryApproach: "invented", construction: [] }, ...namesFor(request, 119, "One")]) }));
    expect(await run(claim, g.gateway, p.provider)).toBe("succeeded");
    expect(g.actions()).toEqual(["round_begin", "round_sent", "round_saved", "finish"]);
    expect(p.created).toHaveLength(1); expect(p.retrieved).toEqual(["resp_fake_1", "resp_fake_1", "resp_fake_1"]);
    expect(g.args("round_begin")[0]).toEqual({ round: 1, request: p.created[0] });
    expect(g.args("round_sent")[0]).toEqual({ round: 1, responseId: "resp_fake_1", requestId: "req_fake_1" });
    const saved = g.args("round_saved")[0]!;
    expect(saved).toMatchObject({ round: 1, responseId: "resp_fake_1", model, usage: { inputTokens: 80, outputTokens: 60, totalTokens: 140 } });
    expect(saved.candidates).toHaveLength(100); expect((saved.candidates as NamingSavedCandidate[]).some(row => row.identityKey === OWNED)).toBe(false);
    expect(g.savedCount()).toBe(100);
  });
  it("uses three rounds to reach 100 and excludes names saved earlier in the run", async () => {
    const claim = claimFor(), g = fakeGateway(claim), p = fakeProvider((request, index) => ({ final: completed(namesFor(request, 40, `Round${index}`)) }));
    expect(await run(claim, g.gateway, p.provider)).toBe("succeeded");
    expect(p.created.map(request => request.metadata.embel_round)).toEqual(["1", "2", "3"]);
    expect(p.created.map(request => (request.text.format.schema as { properties: { candidates: { maxItems: number } } }).properties.candidates.maxItems)).toEqual([120, 60, 40]);
    expect(promptJson(p.created[1]!).excludedIdentities).toEqual(expect.arrayContaining([OWNED, "round1name0", "round1name39"]));
    expect(g.args("round_saved").map(args => (args.candidates as unknown[]).length)).toEqual([40, 40, 20]);
    expect(g.savedCount()).toBe(100);
  });
  it("resumes a sent round by polling its receipt and never calls create", async () => {
    const claim = claimFor({ rounds: [{ roundId: id(30), round: 1, state: "sent", responseId: "resp_resumed_1", savedCount: 0, errorCode: null }] });
    const request = buildNamingRoundRequest(claim.input, roundState(claim), 1, policy), g = fakeGateway(claim);
    const p = fakeProvider(() => { throw Error("create must not be called"); }, { resp_resumed_1: { pending: 1, final: completed(namesFor(request, 120, "Resumed")) } });
    expect(await run(claim, g.gateway, p.provider)).toBe("succeeded");
    expect(p.created).toHaveLength(0); expect(p.retrieved).toEqual(["resp_resumed_1", "resp_resumed_1"]);
    expect(g.actions()).toEqual(["round_saved", "finish"]); expect(g.args("round_saved")[0]).toMatchObject({ round: 1, responseId: "resp_resumed_1" });
  });
  it("never re-sends a round whose receipt number was not saved", async () => {
    const claim = claimFor({ rounds: [{ roundId: id(30), round: 1, state: "sending", responseId: null, savedCount: 0, errorCode: null }] }), g = fakeGateway(claim), p = fakeProvider(() => Error("never"));
    expect(await run(claim, g.gateway, p.provider)).toBe("failed");
    expect(g.actions()).toEqual(["finish"]); expect(p.created).toHaveLength(0); expect(p.retrieved).toHaveLength(0);
  });
  it("records a rejected create as provider_rejected and stops", async () => {
    const claim = claimFor(), g = fakeGateway(claim), p = fakeProvider(() => new NamingProviderError("request_rejected", "req_rejected", 400));
    expect(await run(claim, g.gateway, p.provider)).toBe("failed");
    expect(g.actions()).toEqual(["round_begin", "round_failed", "finish"]);
    expect(g.args("round_failed")[0]).toEqual({ round: 1, code: "provider_rejected", responseId: null, usage: null }); expect(p.created).toHaveLength(1);
  });
  it("finishes without a receipt when the create outcome is unknown", async () => {
    const claim = claimFor(), g = fakeGateway(claim), p = fakeProvider(() => new NamingProviderError("outcome_unknown"));
    expect(await run(claim, g.gateway, p.provider)).toBe("failed");
    expect(g.actions()).toEqual(["round_begin", "finish"]); expect(p.created).toHaveLength(1); expect(p.retrieved).toHaveLength(0);
  });
  it("cancels a response that does not finish in time and continues with the next round", async () => {
    const claim = claimFor(), g = fakeGateway(claim), p = fakeProvider((request, index) => index === 1 ? { pending: Number.POSITIVE_INFINITY, final: {} } : { final: completed(namesFor(request, 60, `Later${index}`)) });
    expect(await run(claim, g.gateway, p.provider, { roundTimeoutMs: 40 })).toBe("succeeded");
    expect(p.cancelled).toEqual(["resp_fake_1"]);
    expect(g.args("round_failed")).toEqual([{ round: 1, code: "response_timeout", responseId: "resp_fake_1", usage: null }]);
    expect(g.actions()).toEqual(["round_begin", "round_sent", "round_failed", "round_begin", "round_sent", "round_saved", "round_begin", "round_sent", "round_saved", "finish"]);
    expect(g.savedCount()).toBe(100);
  });
  it("records failed and unusable replies with their own codes", async () => {
    const claim = claimFor(), g = fakeGateway(claim), p = fakeProvider((_request, index) => ({ final: index === 1 ? { status: "failed", model, output: [], usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 } } : { status: "completed", model, output: [message("not json")] } }));
    expect(await run(claim, g.gateway, p.provider)).toBe("failed");
    expect(g.args("round_failed").map(args => args.code)).toEqual(["response_failed", "invalid_output", "invalid_output"]);
    expect(g.args("round_failed")[0]!.usage).toEqual({ inputTokens: 5, outputTokens: 0, totalTokens: 5 });
  });
  it("records save_failed after three failed saves and stops paying for more rounds", async () => {
    const claim = claimFor(), g = fakeGateway(claim, { fail: { round_saved: 3 } }), p = fakeProvider(request => ({ final: completed(namesFor(request, 50, "Unsaved")) }));
    expect(await run(claim, g.gateway, p.provider)).toBe("failed");
    expect(g.actions()).toEqual(["round_begin", "round_sent", "round_saved", "round_saved", "round_saved", "round_failed", "finish"]);
    expect(g.args("round_failed")[0]).toMatchObject({ round: 1, code: "save_failed", responseId: "resp_fake_1" }); expect(p.created).toHaveLength(1);
  });
  it("stops before the next round when a heartbeat reports a cancel request", async () => {
    const claim = claimFor(), g = fakeGateway(claim, { cancelOnSave: true }), p = fakeProvider(request => ({ final: completed(namesFor(request, 30, "Stopped")) }));
    expect(await run(claim, g.gateway, p.provider, { heartbeatMs: 5 })).toBe("cancelled");
    expect(p.created).toHaveLength(1); expect(g.actions().filter(action => action === "round_begin")).toHaveLength(1);
    expect(g.args("heartbeat")[0]).toEqual({ leaseSeconds: 120 }); expect(g.actions().at(-1)).toBe("finish");
  });
  it("settles without throwing when finish keeps failing", async () => {
    const claim = claimFor(), g = fakeGateway(claim, { fail: { finish: Number.POSITIVE_INFINITY } }), p = fakeProvider(request => ({ final: completed(namesFor(request, 120, "Kept")) }));
    await expect(run(claim, g.gateway, p.provider)).resolves.toBe("unsettled");
    expect(g.actions().filter(action => action === "finish")).toHaveLength(3); expect(g.savedCount()).toBe(100);
  });
  it("stops at the run deadline: cancels the open response, records response_timeout and starts no new round", async () => {
    const claim = claimFor({ rounds: [{ roundId: id(30), round: 1, state: "sent", responseId: "resp_deadline_1", savedCount: 0, errorCode: null }] }), g = fakeGateway(claim);
    const p = fakeProvider(() => Error("never"), { resp_deadline_1: { pending: Number.POSITIVE_INFINITY, final: {} } });
    expect(await run(claim, g.gateway, p.provider, { deadlineMs: 40, roundTimeoutMs: 5_000 })).toBe("failed");
    expect(p.cancelled).toEqual(["resp_deadline_1"]); expect(p.created).toHaveLength(0);
    expect(g.args("round_failed")).toEqual([{ round: 1, code: "response_timeout", responseId: "resp_deadline_1", usage: null }]); expect(g.actions()).toEqual(["round_failed", "finish"]);
  });
  it("stops a cancelled run's response and reports unsettled when its failure cannot be saved", async () => {
    const claim = { ...claimFor({ rounds: [{ roundId: id(30), round: 1, state: "sent", responseId: "resp_cancelled_1", savedCount: 0, errorCode: null }] }) };
    claim.run = { ...claim.run, state: "cancel_requested" };
    const g = fakeGateway(claim, { fail: { round_failed: Number.POSITIVE_INFINITY } }), p = fakeProvider(() => Error("never"), { resp_cancelled_1: { pending: Number.POSITIVE_INFINITY, final: {} } });
    expect(await run(claim, g.gateway, p.provider)).toBe("unsettled");
    expect(p.cancelled).toEqual(["resp_cancelled_1"]); expect(p.created).toHaveLength(0);
    expect(g.actions()).toEqual(["round_failed", "round_failed", "round_failed"]);
  });
  it("leaves a sent round for the next claim when the lease is lost", async () => {
    const claim = claimFor(), g = fakeGateway(claim, { fail: { heartbeat: Number.POSITIVE_INFINITY } }), p = fakeProvider(() => ({ pending: Number.POSITIVE_INFINITY, final: {} }));
    expect(await run(claim, g.gateway, p.provider, { heartbeatMs: 5, roundTimeoutMs: 5_000 })).toBe("lease_lost");
    expect(g.actions().filter(action => !["heartbeat"].includes(action))).toEqual(["round_begin", "round_sent"]); expect(p.cancelled).toHaveLength(0);
  });
  it("sends no NUL character from a reply to the gateway", async () => {
    const claim = claimFor(), g = fakeGateway(claim);
    const p = fakeProvider(request => ({ final: completed([{ value: "Nulfixture", rationale: "Before\u0000after, a synthetic rationale.", primaryApproach: "invented", construction: [] }, ...namesFor(request, 100, "Clean")]) }));
    expect(await run(claim, g.gateway, p.provider)).toBe("succeeded");
    expect(g.calls.every(call => !/\u0000|\\u0000/u.test(call.raw))).toBe(true);
  });
});

describe("Naming background provider, inert HTTP only", () => {
  const request = () => buildNamingRoundRequest(claimFor().input, roundState(claimFor()), 1, policy);
  it("queues a background request without SDK retries and returns its receipt", async () => {
    const seen: { method: string; path: string; search: string; body: Record<string, unknown>; retries: string | null }[] = [];
    const provider = createNamingGenerationProvider({ apiKey: "synthetic-never-live", fetch: async (incoming, init) => {
      const http = new Request(incoming, init), url = new URL(http.url);
      seen.push({ method: http.method, path: url.pathname, search: url.search, body: await http.json() as Record<string, unknown>, retries: http.headers.get("x-stainless-retry-count") });
      return Response.json({ id: "resp_fixture_bg", object: "response", status: "queued", model, background: true, output: [] }, { headers: { "x-request-id": "req_fixture_bg" } });
    } });
    expect(await provider.create(request(), new AbortController().signal)).toEqual({ responseId: "resp_fixture_bg", requestId: "req_fixture_bg", status: "queued" });
    expect(seen).toHaveLength(1); expect(seen[0]).toMatchObject({ method: "POST", path: "/v1/responses", search: "", retries: "0", body: { background: true, store: true, stream: false, model } });
  });
  it.each([[400, "request_rejected"], [429, "request_rejected"], [500, "outcome_unknown"], ["lost", "outcome_unknown"]] as const)("sanitizes a %s failure", async (status, code) => {
    const fetcher = vi.fn(async () => { if (status === "lost") throw Error("private-provider-fixture"); return Response.json({ error: { message: "private-provider-fixture", type: "invalid_request_error" } }, { status, headers: { "x-request-id": "req_fixture" } }); });
    const failure = await createNamingGenerationProvider({ apiKey: "synthetic-never-live", fetch: fetcher }).create(request(), new AbortController().signal).catch(error => error);
    expect(failure).toBeInstanceOf(NamingProviderError); expect(failure.code).toBe(code); expect(failure.status).toBe(status === "lost" ? null : status);
    expect(JSON.stringify(failure)).not.toContain("private-provider-fixture"); expect(String(failure.message)).not.toContain("private-provider-fixture"); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects an invalid body, a malformed id, redirects and oversized replies before trusting them", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://unrelated.invalid" } }));
    const provider = createNamingGenerationProvider({ apiKey: "synthetic-never-live", fetch: fetcher });
    await expect(provider.create({ ...request(), stream: true } as unknown as NamingGenerationWire, new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected" });
    await expect(provider.retrieve("resp_../secret", new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(provider.create(request(), new AbortController().signal)).rejects.toMatchObject({ code: "outcome_unknown" });
    const oversized = createNamingGenerationProvider({ apiKey: "synthetic-never-live", fetch: async () => new Response("x".repeat(1_048_577), { headers: { "content-type": "application/json" } }) });
    await expect(oversized.retrieve("resp_fixture", new AbortController().signal)).rejects.toMatchObject({ code: "protocol_limit" });
  });
  it("polls with GET and cancels only that response", async () => {
    const calls: string[] = [];
    const provider = createNamingGenerationProvider({ apiKey: "synthetic-never-live", fetch: async (incoming, init) => {
      const http = new Request(incoming, init), url = new URL(http.url); calls.push(`${http.method} ${url.pathname}${url.search}`);
      return Response.json({ id: "resp_fixture", object: "response", model, status: "cancelled", output: [] }, { headers: { "x-request-id": "req_read" } });
    } });
    expect(await provider.retrieve("resp_fixture", new AbortController().signal)).toMatchObject({ response: { id: "resp_fixture", status: "cancelled" }, requestId: "req_read" });
    await provider.cancel("resp_fixture", new AbortController().signal);
    expect(calls).toEqual(["GET /v1/responses/resp_fixture", "POST /v1/responses/resp_fixture/cancel"]);
  });
});
