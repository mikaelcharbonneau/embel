import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { initializeGuidedInterview } from "../../src/domain/guided-interview";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { strategyAvailabilitySchema, type StrategyJobResult } from "../../src/domain/strategy-jobs";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { buildStrategyRunInput, engineStrategyAvailability, selectAssistantHistory, strategyEngineEnabled } from "../../src/server/engine/strategy";

// The input a Strategy run freezes, built from the owner's own saved data (synthetic fixtures).
const owner = "aaaaaaaa-1111-4111-8111-111111111111", project = "bbbbbbbb-2222-4222-8222-222222222222";
const legacyJob = "dddddddd-4444-4444-8444-444444444444", engineRun = "eeeeeeee-5555-4555-8555-555555555555";
const now = "2026-11-09T20:00:00.000Z";

function context(stage: "competitors" | "audience" = "audience", revision = 3, answered = false) {
  let value = initializeGuidedInterview(contextSnapshotSchema.parse({ description: "Synthetic bakery brief", intake: { conversation: [{ id: "first-message", kind: "user_message", text: "Office bread", createdAt: now }] } }), {
    id: "current-turn", userMessageId: "first-message", stage, purpose: stage === "competitors" ? "research" : "propose", inputRevision: revision,
  });
  if (answered) value = contextSnapshotSchema.parse({ ...value, intake: { ...value.intake, guidedInterview: { ...value.intake.guidedInterview!, answers: [{ stage, turnId: "current-turn", optionIds: [], customText: null, confirmedAt: now }] } } });
  return value;
}
function result(operation: StrategyJobResult["operation"], message: string): StrategyJobResult {
  const proposal = operation === "strategy.reformulate" ? { message, activity: "", offering: "", knownAudience: "", questions: [] } : { message, competitors: [] };
  return { version: 1, provider: "openai", model: "gpt-6.1-sol", responseId: "resp_synthetic", requestId: null, generatedAt: now,
    usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: 0 }, operation, proposal } as StrategyJobResult;
}

type Rows = Record<string, unknown>;
/** A read-only stand-in for the owner's Supabase client: each table answers from fixtures. */
function auth(tables: Record<string, Rows[] | Rows | null>, rpc: (name: string) => unknown = () => ({ data: null, error: null })): AuthenticatedContext {
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "in", "lt", "like", "order", "limit"]) builder[method] = () => builder;
    builder.maybeSingle = async () => ({ data: tables[table] ?? null, error: null });
    builder.then = (resolve: (value: unknown) => void) => resolve({ data: tables[table] ?? [], error: null });
    return builder;
  };
  return { userId: owner, client: { from, rpc: async (name: string) => rpc(name) } } as unknown as AuthenticatedContext;
}
function tables(revision = 3, saved = context()) {
  return {
    projects: { id: project, owner_id: owner, scope: "complete_brand", title: "Synthetic", current_revision: revision, created_at: now },
    project_revisions: { project_id: project, owner_id: owner, revision, context: saved, input_hash: "x", created_at: now },
    jobs: [{ id: legacyJob, owner_id: owner, project_id: project, operation: "strategy.competitors", input_revision: 1 }],
    job_steps: [{ job_id: legacyJob, step_key: "step-a", output: result("strategy.competitors", "Older reply"), completed_at: "2026-11-09T19:00:00.000+00:00" }],
    generation_runs: [{ id: engineRun, owner_id: owner, project_id: project, kind: "strategy.reformulate", input_revision: 2 }],
    generation_outputs: [{ run_id: engineRun, output_key: "result", output: result("strategy.reformulate", "Newer reply"), created_at: "2026-11-09T19:30:00.000+00:00" }],
  };
}

describe("freezing a Strategy run's input", () => {
  it("freezes the revision's context, the hosted policy and earlier replies from both job systems, newest first", async () => {
    const input = await buildStrategyRunInput(auth(tables()), project, "strategy.audience", { expectedRevision: 3 });
    expect(input.revision).toBe(3);
    expect(input.request).toMatchObject({ version: 3, spendControl: "uncapped", policy: { model: "gpt-6.1-sol", handlerVersion: "strategy-openai-guided-v1" } });
    if (input.request.version !== 3) throw new Error("Expected the uncapped contract");
    expect(input.request.context.intake.guidedInterview?.turns.at(-1)).toMatchObject({ id: "current-turn", inputRevision: 3 });
    expect(input.request.assistantHistory.entries.map(entry => [entry.jobId, entry.inputRevision, entry.output.proposal.message]))
      .toEqual([[engineRun, 2, "Newer reply"], [legacyJob, 1, "Older reply"]]);
  });
  it("refuses a stale revision, another operation, or a turn already answered", async () => {
    await expect(buildStrategyRunInput(auth(tables(4)), project, "strategy.audience", { expectedRevision: 3 })).rejects.toMatchObject({ code: "conflict" });
    await expect(buildStrategyRunInput(auth(tables()), project, "strategy.competitors", { expectedRevision: 3 })).rejects.toMatchObject({ code: "conflict" });
    await expect(buildStrategyRunInput(auth(tables(3, context("audience", 3, true))), project, "strategy.audience", { expectedRevision: 3 })).rejects.toMatchObject({ code: "conflict" });
    await expect(buildStrategyRunInput(auth(tables()), project, "strategy.audience", { expectedRevision: 3, context: {} })).rejects.toMatchObject({ code: "invalid_input" });
  });
  it("keeps at most five replies and drops older ones that would not fit", () => {
    const entries = Array.from({ length: 7 }, (_, index) => ({ jobId: `0000000${index}-0000-4000-8000-000000000000`, ownerId: owner, projectId: project, stepKey: "result",
      inputRevision: index + 1, completedAt: `2026-11-09T1${index}:00:00.000Z`, output: result("strategy.reformulate", `Reply ${index}`) }));
    const history = selectAssistantHistory(entries, {});
    expect(history.entries.map(entry => entry.inputRevision)).toEqual([7, 6, 5, 4, 3]);
    expect(history.truncated).toBe(true);
    const crowded = selectAssistantHistory(entries, { filler: "x".repeat(55_900) });
    expect(crowded).toEqual({ entries: [], truncated: true });
  });
});

describe("the Strategy switch", () => {
  const catalog = (enabled: (kind: string) => boolean) => () => ({ data: { plans: [], kinds: ["engine.probe", "strategy.audience", "strategy.competitors", "strategy.personality", "strategy.positioning", "strategy.reformulate", "strategy.slogan"]
    .map(kind => ({ kind, credits: 1, enabled: enabled(kind) })) }, error: null });
  it("turns on only when every Strategy kind is enabled, and stays off when the catalog can't be read", async () => {
    expect(await strategyEngineEnabled(auth({}, catalog(() => true)))).toBe(true);
    expect(await strategyEngineEnabled(auth({}, catalog(kind => kind !== "strategy.slogan")))).toBe(false);
    expect(await strategyEngineEnabled(auth({}, () => ({ data: null, error: { message: "function does not exist", code: "42883" } })))).toBe(false);
  });
  it("offers every operation to the guided interview without a cost", () => {
    const availability = strategyAvailabilitySchema.parse(engineStrategyAvailability());
    expect(availability.operations).toHaveLength(6);
    expect(availability.operations.every(operation => "interviewVersion" in operation && operation.interviewVersion === 1 && !("maximumCostMicrousd" in operation))).toBe(true);
  });
});
