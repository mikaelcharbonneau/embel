import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
// The workflow runs in-process: sleeps return at once and the run id is fixed. Every step
// runs its real code against the fake database and fake OpenAI below. No live inference.
const doubles = vi.hoisted(() => ({ engineCall: vi.fn(), openai: null as unknown, sleeps: 0 }));
vi.mock("workflow", async importOriginal => ({
  ...await importOriginal<object>(), getWorkflowMetadata: () => ({ workflowRunId: "wrun_naming_fixture" }),
  sleep: vi.fn(async () => { doubles.sleeps++; }),
}));
vi.mock("../../src/server/engine/database", () => ({ engineCall: doubles.engineCall }));
vi.mock("../../src/server/engine/openai", async importOriginal => ({ ...await importOriginal<object>(), engineOpenAI: () => doubles.openai }));
import { FatalError, RetryableError } from "workflow";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { namingStrategyBasis } from "../../src/domain/project-naming";
import type { NamingApproach } from "../../src/domain/naming-brain-preferences";
import { namingEnginePolicy, namingRunInputSchema } from "../../src/server/engine/naming";
import {
  createNamingAttempt, NAMING_REQUEST_CANDIDATES, namingCostMicrousd, namingResponseRequest, planNamingRequests, pollNamingAttempts, readNamingRun,
  settleNamingAttempt, stopNamingAttempts, type ClaimedNamingRun, type NamingRequestPlan, type NamingRunDeps, type NamingRunState,
} from "../../src/server/engine/naming-run";
import { EngineProviderError, type BackgroundResponse, type EngineOpenAI } from "../../src/server/engine/openai";
import { namingGeneration } from "../../src/workflows/naming";
import { createNamingResponse } from "../../src/workflows/naming-steps";

const owner = "aaaaaaaa-1111-4111-8111-111111111111", project = "bbbbbbbb-2222-4222-8222-222222222222", runId = "cccccccc-3333-4333-8333-333333333333";
const empty: NamingRunState = { savedCount: 0, identities: [], approaches: [] };

function input(approaches: NamingApproach[] = ["invented"], exclusions: string[] = ["takenname"]) {
  return namingRunInputSchema.parse({ version: 1, kind: "initial", revision: 4, policy: namingEnginePolicy(), exclusions, brief: {
    version: 1, contextRevision: 4, preferencesVersion: 2, likedExamples: [{ value: "Liked Fixture" }], strongSeeds: [], recentExamples: [{ value: "Recent Fixture" }], steeringInstruction: null,
    preferences: { version: 2, creativeLocale: "en", notes: "", minimumGraphemes: null, maximumGraphemes: null, approaches, directness: "all", sourceLanguages: [], heritageNotes: "", culturalNotes: "", requiredText: [], excludedText: [] },
    strategyBasis: namingStrategyBasis(contextSnapshotSchema.parse({ description: "Synthetic fixture: a garden planning service." })) } });
}
const claimed = (value: unknown = input()): ClaimedNamingRun => ({ id: runId, ownerId: owner, projectId: project, kind: "naming.generate", input: value });

/** The plan a request was built from, read back from its JSON schema. */
const requested = (request: Record<string, unknown>) => {
  const schema = (request.text as { format: { schema: { properties: { candidates: { maxItems: number; items: { properties: { primaryApproach: { enum: NamingApproach[] } } } } } } } }).format.schema;
  return { target: schema.properties.candidates.maxItems, approaches: schema.properties.candidates.items.properties.primaryApproach.enum, key: (request.metadata as { embel_request: string }).embel_request };
};
let serial = 0;
const names = (count: number, approach: NamingApproach = "invented") => Array.from({ length: count }, () => {
  const value = `Fixturename${++serial}`;
  return { value, rationale: "Synthetic imagery for this brief.", primaryApproach: approach, construction: approach === "invented" ? [] : [value] };
});
const usage = { input_tokens: 2_000, output_tokens: 4_000, total_tokens: 6_000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
function reply(id: string, candidates: unknown, status = "completed", model = "gpt-6-luna") {
  return { id, status, model, usage, output: [{ type: "reasoning", summary: [] }, { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: typeof candidates === "string" ? candidates : JSON.stringify({ candidates }) }] }] };
}
const background = (body: { id: string; status: string }): BackgroundResponse => ({ id: body.id, status: body.status as BackgroundResponse["status"], body, requestId: null });

type Script = { reply?: (target: number) => unknown; status?: string; pending?: number; create?: Error; cancel?: "cancelled" | "completed" };
/** OpenAI stand-in: each request key gets its script; responses finish after `pending` lookups. */
function fakeOpenAI(scripts: Record<string, Script> = {}) {
  const created: { key: string; target: number; request: Record<string, unknown> }[] = [], cancelled: string[] = [];
  const responses = new Map<string, { script: Script; target: number; pending: number }>();
  const body = (id: string) => {
    const row = responses.get(id)!;
    return reply(id, row.script.reply ? row.script.reply(row.target) : names(row.target), row.script.status ?? "completed");
  };
  const openai: EngineOpenAI = {
    countInputTokens: vi.fn(async () => 1),
    create: vi.fn(async (request: Record<string, unknown>) => {
      const plan = requested(request), script = scripts[plan.key] ?? {};
      created.push({ key: plan.key, target: plan.target, request });
      if (script.create) throw script.create;
      const id = `resp_${plan.key.replace(/\./gu, "_")}`;
      responses.set(id, { script, target: plan.target, pending: script.pending ?? 0 });
      return background({ id, status: "queued" });
    }),
    retrieve: vi.fn(async (id: string) => {
      const row = responses.get(id);
      if (!row) throw new EngineProviderError("rejected", 404);
      if (row.pending > 0) { row.pending--; return background({ id, status: "in_progress" }); }
      return background(body(id));
    }),
    cancel: vi.fn(async (id: string) => {
      cancelled.push(id);
      const row = responses.get(id)!;
      return background(row.script.cancel === "completed" ? body(id) : { ...reply(id, [], "cancelled"), status: "cancelled" });
    }),
  };
  return { openai, created, cancelled };
}

/** The engine database stand-in, following engine_* rules: one claim, saves only while running,
 * each output key once, names deduplicated against the project and capped at 100 per run. */
function fakeDatabase(value: unknown = input(), options: { cancelAfterSaves?: number; projectNames?: string[] } = {}) {
  const run = { status: "queued", cancelRequested: false, errorCode: null as string | null };
  const outputs = new Map<string, { output: Record<string, unknown>; responseId: string | null; cost: number }>();
  const saved: { identityKey: string; key: string }[] = [], project = new Set(options.projectNames ?? ["takenname"]);
  doubles.engineCall.mockImplementation(async (name: string, args: unknown[]) => {
    switch (name) {
      case "engine_claim":
        if (run.status === "queued") run.status = "running";
        return { id: runId, ownerId: owner, projectId: project, kind: "naming.generate", status: run.status, input: value, cancelRequested: run.cancelRequested };
      case "engine_check": return { status: run.status, cancelRequested: run.cancelRequested, paused: false };
      case "engine_save_output": case "engine_save_names": {
        const [, key, json, responseId, cost] = args as [string, string, string, string | null, number];
        if (run.status !== "running") throw new Error("run_not_running");
        const output = JSON.parse(json) as Record<string, unknown>;
        const replay = outputs.has(key);
        if (!replay) outputs.set(key, { output, responseId, cost });
        if (options.cancelAfterSaves !== undefined && outputs.size >= options.cancelAfterSaves) run.cancelRequested = true;
        if (name === "engine_save_output") return !replay;
        if (!replay) for (const item of output.names as { identityKey: string }[]) {
          if (saved.length >= 100 || project.has(item.identityKey)) continue;
          project.add(item.identityKey); saved.push({ identityKey: item.identityKey, key });
        }
        return { saved: !replay, inserted: saved.filter(row => row.key === key).map(row => row.identityKey), savedCount: saved.length };
      }
      case "engine_finish": {
        const [, status, error] = args as [string, string, string | null];
        if (run.status === "queued" || run.status === "running") { run.status = status; run.errorCode = status === "succeeded" ? null : error; }
        return { id: runId, status: run.status, errorCode: run.errorCode };
      }
    }
    throw new Error(`unexpected ${name}`);
  });
  return { run, outputs, saved };
}

beforeEach(() => { doubles.engineCall.mockReset(); doubles.sleeps = 0; serial = 0; });

describe("reading a Naming run's frozen input", () => {
  it("accepts the Naming lane's policy and refuses another model, a malformed input or another kind", () => {
    expect(readNamingRun(claimed()).input.policy).toEqual({ version: 2, operation: "naming.generate", model: "gpt-6-luna", reasoningEffort: "low" });
    expect(() => readNamingRun(claimed({ ...input(), policy: { ...namingEnginePolicy(), model: "gpt-other" } }))).toThrow("policy_mismatch");
    expect(() => readNamingRun(claimed({ ...input(), policy: { ...namingEnginePolicy(), reasoningEffort: "medium" } }))).toThrow("policy_mismatch");
    expect(() => readNamingRun(claimed({ revision: 4 }))).toThrow("invalid_run_input");
    expect(() => readNamingRun({ ...claimed(), kind: "engine.probe" })).toThrow("invalid_run_input");
  });
});

describe("planning a round", () => {
  it("sends the first round as three requests of about 40 names that together admit 100", () => {
    const plans = planNamingRequests(input(["invented", "real_words", "compounds", "phrases"]), empty, 1);
    expect(plans.map(plan => plan.key)).toEqual(["round.1.1", "round.1.2", "round.1.3"]);
    expect(plans.reduce((sum, plan) => sum + plan.candidateTarget, 0)).toBe(120);
    expect(plans.reduce((sum, plan) => sum + plan.admit, 0)).toBe(100);
    expect(Math.max(...plans.map(plan => plan.candidateTarget))).toBeLessThanOrEqual(NAMING_REQUEST_CANDIDATES + 1);
    // Every approach is asked for, spread over different requests.
    for (const approach of ["invented", "real_words", "compounds", "phrases"]) expect(plans.filter(plan => plan.slots.some(slot => slot.approach === approach)).length).toBe(3);
    expect(plans.every(plan => plan.slots.every(slot => slot.admit > 0 && slot.request > 0) && !plan.finalFill)).toBe(true);
  });
  it("asks later rounds for what is missing plus 20, favoring under-represented approaches, and fills on the last round", () => {
    const state: NamingRunState = { savedCount: 70, identities: [], approaches: Array.from({ length: 70 }, () => "invented") };
    const second = planNamingRequests(input(["invented", "real_words"]), state, 2);
    expect(second.map(plan => plan.candidateTarget)).toEqual([25, 25]);
    expect(second.flatMap(plan => plan.slots).every(slot => slot.approach === "real_words")).toBe(true);
    const last = planNamingRequests(input(), { ...state, savedCount: 95 }, 3);
    expect(last).toEqual([expect.objectContaining({ key: "round.3.1", candidateTarget: 25, admit: 5, finalFill: true })]);
    expect(planNamingRequests(input(), { ...state, savedCount: 100 }, 2)).toEqual([]);
    expect(planNamingRequests(input(), empty, 4)).toEqual([]);
  });
});

describe("the OpenAI request", () => {
  const plan = planNamingRequests(input(), empty, 1)[0]!;
  it("uses the Naming lane's model and reasoning, a strict reply schema and a stable request key", async () => {
    const request = namingResponseRequest(runId, input(), plan, empty);
    expect(request).toMatchObject({ model: "gpt-6-luna", reasoning: { effort: "low" }, max_output_tokens: 16_000, metadata: { embel_run_id: runId, embel_request: "round.1.1" } });
    expect(requested(request)).toEqual({ target: plan.candidateTarget, approaches: ["invented"], key: "round.1.1" });
    expect(request.input).toContain("takenname");
    const { openai, created } = fakeOpenAI();
    await createNamingAttempt(openai, claimed(), plan, empty);
    expect(openai.create).toHaveBeenCalledWith(request, `naming:${runId}:round.1.1`);
    expect(created).toHaveLength(1);
  });
  it("shortens the exclusion hint for a large project instead of growing past the request bound", () => {
    const many = Array.from({ length: 1_000 }, (_, index) => `excludedidentity${"x".repeat(100)}${index}`);
    const request = namingResponseRequest(runId, input(["invented"], many), plan, empty);
    expect(new TextEncoder().encode(JSON.stringify(request)).byteLength).toBeLessThanOrEqual(131_072);
    expect(request.input).not.toContain(many[0]);
  });
  it("turns provider failures into retry, fail-now and never-resend decisions", async () => {
    const run = { ...claimed(), status: "running" as const, cancelRequested: false, input: input() as unknown as Record<string, unknown> };
    for (const [error, expected] of [
      [new EngineProviderError("retry", 429, 3000), RetryableError],
      [new EngineProviderError("rejected", 400), new FatalError("provider_rejected")],
      [new EngineProviderError("uncertain", null), new FatalError("send_interrupted")],
    ] as const) {
      doubles.openai = { ...fakeOpenAI().openai, create: vi.fn(async () => { throw error; }) };
      if (expected === RetryableError) await expect(createNamingResponse(run, plan, empty)).rejects.toBeInstanceOf(RetryableError);
      else await expect(createNamingResponse(run, plan, empty)).rejects.toThrow(expected);
    }
  });
});

describe("settling replies", () => {
  const plan: NamingRequestPlan = planNamingRequests(input(), empty, 1)[0]!;
  function deps(openai: EngineOpenAI, saveNames = vi.fn<NamingRunDeps["saveNames"]>(async () => ({ saved: true, inserted: ["fixturename1"], savedCount: 1 }))) {
    return { openai, check: vi.fn(async () => ({ status: "running", cancelRequested: false, paused: false })), save: vi.fn<NamingRunDeps["save"]>(async () => true), saveNames };
  }
  it("saves checked names with the response id and the cost from usage", async () => {
    const openai = { ...fakeOpenAI().openai, retrieve: vi.fn(async () => background(reply("resp_one", [...names(1), { value: "Two Words", rationale: "Not invented.", primaryApproach: "invented", construction: [] }, ...names(1).map(row => ({ ...row, value: "takenname" }))]))) };
    const run = deps(openai);
    const result = await settleNamingAttempt(run, claimed(), plan, empty, "resp_one");
    const [, key, output, responseId, cost] = run.saveNames.mock.calls[0]!;
    expect([key, responseId]).toEqual(["round.1.1", "resp_one"]);
    expect(output).toMatchObject({ state: "saved", round: 1, request: 1, model: "gpt-6-luna", usage: { inputTokens: 2_000, outputTokens: 4_000, totalTokens: 6_000 }, proposed: 3,
      names: [{ value: "Fixturename1", identityKey: "fixturename1", primaryApproach: "invented" }] });
    // 2,000 input tokens at $0.10/M plus 4,000 output at $0.50/M.
    expect(cost).toBe(200 + 2_000);
    expect(namingCostMicrousd({ ...usage, input_tokens: 1 })).toBe(2_001);
    expect(result).toEqual({ state: { savedCount: 1, identities: ["fixturename1"], approaches: ["invented"] }, code: null });
  });
  it("records an unreadable, cut-off or foreign reply with its cost, and keeps going", async () => {
    for (const [body, code] of [
      [reply("resp_x", "{not json"), "invalid_output"],
      [reply("resp_x", names(3), "incomplete"), "response_failed"],
      [reply("resp_x", names(3), "completed", "gpt-6.1-sol"), "invalid_output"],
      [reply("resp_x", names(plan.candidateTarget + 1)), "invalid_output"],
    ] as const) {
      const run = deps({ ...fakeOpenAI().openai, retrieve: vi.fn(async () => background(body)) });
      expect(await settleNamingAttempt(run, claimed(), plan, empty, "resp_x")).toEqual({ state: empty, code });
      expect(run.save).toHaveBeenCalledWith(runId, "round.1.1", { state: "failed", round: 1, request: 1, code, usage: { inputTokens: 2_000, outputTokens: 4_000, totalTokens: 6_000 } }, "resp_x", 2_200);
      expect(run.saveNames).not.toHaveBeenCalled();
    }
  });
  it("reports a reply whose names all exist as no_names, and a run that ended as nothing to record", async () => {
    const openai = { ...fakeOpenAI().openai, retrieve: vi.fn(async () => background(reply("resp_one", names(2)))) };
    expect((await settleNamingAttempt(deps(openai, vi.fn(async () => ({ saved: true, inserted: [], savedCount: 0 }))), claimed(), plan, empty, "resp_one")).code).toBe("no_names");
    expect(await settleNamingAttempt(deps(openai, vi.fn(async () => null)), claimed(), plan, empty, "resp_one")).toEqual({ state: empty, code: null });
  });
  it("polls every open response, stops on cancel or pause, and treats a forgotten response as finished", async () => {
    const { openai } = fakeOpenAI();
    const run = deps({ ...openai, retrieve: vi.fn(async (id: string) => {
      if (id === "resp_gone") throw new EngineProviderError("rejected", 404);
      return background({ id, status: id === "resp_done" ? "completed" : "in_progress" });
    }) });
    expect(await pollNamingAttempts(run, runId, ["resp_done", "resp_busy", "resp_gone"])).toEqual({ state: "pending", finished: ["resp_done", "resp_gone"] });
    run.check.mockResolvedValueOnce({ status: "running", cancelRequested: true, paused: false });
    expect(await pollNamingAttempts(run, runId, ["resp_busy"])).toEqual({ state: "stop", code: "cancelled" });
    run.check.mockResolvedValueOnce({ status: "running", cancelRequested: false, paused: true });
    expect(await pollNamingAttempts(run, runId, ["resp_busy"])).toEqual({ state: "stop", code: "generation_paused" });
    run.check.mockResolvedValueOnce({ status: "failed", cancelRequested: false, paused: false });
    expect(await pollNamingAttempts(run, runId, ["resp_busy"])).toEqual({ state: "stop", code: "cancelled" });
    await expect(pollNamingAttempts({ ...run, openai: { ...openai, retrieve: vi.fn(async () => { throw new EngineProviderError("retry", 503); }) } }, runId, ["resp_busy"]))
      .rejects.toMatchObject({ disposition: "retry" });
  });
  it("cancels open responses at OpenAI, keeping the names of one that finished first", async () => {
    const { openai } = fakeOpenAI();
    const run = deps({ ...openai, cancel: vi.fn(async (id: string) => background(id === "resp_done" ? reply(id, names(2)) : { ...reply(id, [], "cancelled"), status: "cancelled" })) });
    const plans = planNamingRequests(input(), empty, 1);
    const state = await stopNamingAttempts(run, claimed(), [{ plan: plans[0]!, responseId: "resp_done" }, { plan: plans[1]!, responseId: "resp_open" }], empty, "cancelled");
    expect(run.openai.cancel).toHaveBeenCalledTimes(2);
    expect(run.saveNames).toHaveBeenCalledOnce();
    expect(run.save).toHaveBeenCalledWith(runId, "round.1.2", expect.objectContaining({ state: "failed", code: "cancelled" }), "resp_open", 2_200);
    expect(state.savedCount).toBe(1);
  });
});

describe("a whole Naming run", () => {
  it("fills 100 names in one round of three parallel requests and succeeds", async () => {
    const db = fakeDatabase(), { openai, created } = fakeOpenAI();
    doubles.openai = openai;
    expect(await namingGeneration(runId)).toMatchObject({ status: "succeeded" });
    expect(created.map(row => row.key)).toEqual(["round.1.1", "round.1.2", "round.1.3"]);
    expect(db.saved).toHaveLength(100);
    expect([...db.outputs.values()].every(row => row.cost === 2_200 && row.responseId?.startsWith("resp_"))).toBe(true);
    expect(db.run.status).toBe("succeeded");
  });

  it("keeps partial results: a broken or cut-off reply is topped up by the next round", async () => {
    const db = fakeDatabase(), { openai, created } = fakeOpenAI({
      "round.1.2": { reply: () => "{not json" }, "round.1.3": { status: "incomplete" },
    });
    doubles.openai = openai;
    expect(await namingGeneration(runId)).toMatchObject({ status: "succeeded" });
    expect(created.map(row => row.key)).toEqual(["round.1.1", "round.1.2", "round.1.3", "round.2.1", "round.2.2"]);
    expect(db.outputs.get("round.1.2")!.output).toMatchObject({ state: "failed", code: "invalid_output" });
    expect(db.outputs.get("round.1.3")!.output).toMatchObject({ state: "failed", code: "response_failed" });
    expect(db.saved).toHaveLength(100);
  });

  it("never re-sends a create whose outcome is unknown, and finishes with the names it has", async () => {
    const db = fakeDatabase(), { openai, created } = fakeOpenAI({
      "round.1.1": { create: new EngineProviderError("uncertain", null) },
      "round.2.1": { reply: target => names(Math.min(target, 10)) }, "round.2.2": { reply: () => [] },
      "round.3.1": { reply: () => [] }, "round.3.2": { reply: () => [] },
    });
    doubles.openai = openai;
    expect(await namingGeneration(runId)).toMatchObject({ status: "succeeded" });
    expect(created.filter(row => row.key === "round.1.1")).toHaveLength(1);
    expect(db.outputs.get("round.1.1")!.output).toMatchObject({ state: "failed", code: "send_interrupted" });
    expect(db.outputs.get("round.1.1")!.responseId).toBeNull();
    expect(db.saved.length).toBeGreaterThan(66);
    expect(db.saved.length).toBeLessThan(100);
    expect(created.length).toBe(7);
  });

  it("fails with the refusal and returns the credit when nothing could be sent", async () => {
    const rejected = { create: new EngineProviderError("rejected", 400) };
    const db = fakeDatabase(), { openai, created } = fakeOpenAI({ "round.1.1": rejected, "round.1.2": rejected, "round.1.3": rejected });
    doubles.openai = openai;
    expect(await namingGeneration(runId)).toMatchObject({ status: "failed", errorCode: "provider_rejected" });
    expect(created).toHaveLength(3);
    expect(db.saved).toHaveLength(0);
  });

  it("fails as no_names when every reply came back without a usable name", async () => {
    const db = fakeDatabase(undefined, { projectNames: [] }), { openai } = fakeOpenAI(Object.fromEntries(
      ["round.1.1", "round.1.2", "round.1.3", "round.2.1", "round.2.2", "round.3.1", "round.3.2"].map(key => [key, { reply: () => [] }])));
    doubles.openai = openai;
    expect(await namingGeneration(runId)).toMatchObject({ status: "failed", errorCode: "no_names" });
    expect(db.outputs.size).toBe(7);
  });

  it("stops on a cancel: cancels open responses at OpenAI, keeps saved names and ends cancelled", async () => {
    const db = fakeDatabase(input(), { cancelAfterSaves: 1 }), { openai, cancelled } = fakeOpenAI({
      "round.1.2": { pending: 50 }, "round.1.3": { pending: 50, cancel: "completed" },
    });
    doubles.openai = openai;
    expect(await namingGeneration(runId)).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
    expect(cancelled.sort()).toEqual(["resp_round_1_2", "resp_round_1_3"]);
    // The first reply and the one that finished before its cancel keep their names.
    expect(db.saved.map(row => row.key)).toEqual([...Array(34).fill("round.1.1"), ...Array(33).fill("round.1.3")]);
    expect(db.outputs.get("round.1.2")!.output).toMatchObject({ state: "failed", code: "cancelled" });
  });

  it("gives up on a response that never finishes after about four minutes and tops up", async () => {
    const db = fakeDatabase(), { openai, cancelled } = fakeOpenAI({ "round.1.3": { pending: 1_000 } });
    doubles.openai = openai;
    expect(await namingGeneration(runId)).toMatchObject({ status: "succeeded" });
    expect(cancelled).toEqual(["resp_round_1_3"]);
    expect(db.outputs.get("round.1.3")!.output).toMatchObject({ state: "failed", code: "response_timeout" });
    expect(db.saved).toHaveLength(100);
    expect(doubles.sleeps).toBeGreaterThanOrEqual(50);
  });

  it("does nothing for a run that was cancelled before its workflow claimed it", async () => {
    const db = fakeDatabase();
    db.run.status = "cancelled";
    const { openai, created } = fakeOpenAI();
    doubles.openai = openai;
    expect(await namingGeneration(runId)).toEqual({ status: "cancelled" });
    expect(created).toHaveLength(0);
  });
});
