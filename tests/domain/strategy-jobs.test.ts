import { describe, expect, it } from "vitest";
import { applyStrategyJobSchema, applyStrategyJobResponseSchema, enqueueStrategyJobSchema, strategyAvailabilitySchema, strategyJobInputSchema, strategyJobResultSchema, strategyJobSchema } from "../../src/domain/strategy-jobs";
import { contextSnapshotSchema } from "../../src/domain/projects";

const context = contextSnapshotSchema.parse({ description: "Explicit local strategy contract fixture." });
const policy = {
  version: 1, pricingVersion: "2026-10-03", handlerVersion: "strategy-openai-v1", model: "fixture-model",
  maxInputTokens: 32768, maxOutputTokens: 4096, maxWebSearchCalls: 0,
  inputMicrousdPerMillionTokens: 2_000_000, cachedInputMicrousdPerMillionTokens: 100_000,
  cacheWriteMicrousdPerMillionTokens: 2_500_000, outputMicrousdPerMillionTokens: 10_000_000,
  webSearchMicrousdPerCall: 10_000, maximumCostMicrousd: 122_880,
};
const result = {
  version: 1, operation: "strategy.reformulate", provider: "openai", model: "fixture-model", responseId: "fixture-response", requestId: null,
  generatedAt: "2026-10-03T12:00:00Z", usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: 0 },
  proposal: { message: "Explicit local result fixture, not live output.", activity: "Fixture activity", offering: "Fixture offering", knownAudience: "", questions: [] },
};

describe("strategy job contracts", () => {
  const request = { operation: "strategy.reformulate", expectedRevision: 1, idempotencyKey: "fixture-request-0001", acceptedMaxCostMicrousd: 122_880 };
  it("accepts only a revision, bounded cap, operation and idempotency key from a caller", () => {
    expect(enqueueStrategyJobSchema.parse(request)).toEqual(request);
    for (const extra of [{ ownerId: "forged" }, { model: "forged" }, { context }, { prompt: "forged" }, { policy }, { output: result }]) {
      expect(enqueueStrategyJobSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
  });
  it.each([{ expectedRevision: 0 }, { operation: "identity.image" }, { idempotencyKey: "short" }, { idempotencyKey: "spaces are not safe" }, { acceptedMaxCostMicrousd: -1 }, { acceptedMaxCostMicrousd: 0.1 }])("rejects malformed enqueue field %j", invalid => {
    expect(enqueueStrategyJobSchema.safeParse({ ...request, ...invalid }).success).toBe(false);
  });
  it("binds versioned policy and full saved context to the accepted cap", () => {
    expect(strategyJobInputSchema.parse({ version: 1, context, policy, acceptedMaxCostMicrousd: 122_880 }).context).toEqual(context);
    expect(strategyJobInputSchema.safeParse({ version: 1, context, policy, acceptedMaxCostMicrousd: 1 }).success).toBe(false);
    expect(strategyJobInputSchema.safeParse({ version: 1, context, policy: { ...policy, handlerVersion: "unreviewed-v2" }, acceptedMaxCostMicrousd: 122_880 }).success).toBe(false);
  });
  it("rejects fabricated result provenance, invalid usage and mismatched operation output", () => {
    expect(strategyJobResultSchema.safeParse(result).success).toBe(true);
    for (const invalid of [{ ...result, provider: "user" }, { ...result, operation: "strategy.competitors" }, { ...result, usage: { ...result.usage, cachedInputTokens: 101 } }]) {
      expect(strategyJobResultSchema.safeParse(invalid).success).toBe(false);
    }
    const job = {
      id: "11111111-1111-4111-8111-111111111111", owner_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", project_id: "22222222-2222-4222-8222-222222222222",
      operation: "strategy.reformulate", input_revision: 1, state: "partial", progress: 50, reserved_cost_microusd: 100, actual_cost_microusd: 50,
      error_code: null, cancel_requested_at: null, created_at: "2026-10-03T12:00:00Z", finished_at: null,
      results: [{ stepKey: "proposal", output: result }],
    };
    expect(strategyJobSchema.safeParse(job).success).toBe(true);
    expect(strategyJobSchema.safeParse({ ...job, operation: "strategy.competitors" }).success).toBe(false);
    expect(strategyJobSchema.safeParse({ ...job, results: [...job.results, ...job.results] }).success).toBe(false);
    const application = { jobId: job.id, stepKey: "proposal", inputRevision: 1, appliedRevision: 2, appliedAt: "2026-10-04T12:00:00Z" };
    const applied = { ...job, results: [{ ...job.results[0], application }] };
    expect(strategyJobSchema.safeParse(applied).success).toBe(true);
    for (const change of [{ jobId: job.project_id }, { stepKey: "other" }, { inputRevision: 2, appliedRevision: 3 }, { appliedRevision: 3 }, { appliedAt: "invalid" }]) {
      expect(strategyJobSchema.safeParse({ ...job, results: [{ ...job.results[0], application: { ...application, ...change } }] }).success).toBe(false);
    }
    const project = { id: job.project_id, owner_id: job.owner_id, scope: "complete_brand", title: "Local fixture", current_revision: 2, created_at: job.created_at, context };
    expect(applyStrategyJobResponseSchema.safeParse({ project, application }).success).toBe(true);
    expect(applyStrategyJobResponseSchema.safeParse({ project }).success).toBe(false);
    expect(applyStrategyJobResponseSchema.safeParse({ project: { ...project, current_revision: 3 }, application }).success).toBe(false);
  });
  it("never lets a model approve competitor or audience choices, or invent audience sources", () => {
    const competitor = { id: "11111111-1111-4111-8111-111111111111", name: "Fixture", relevance: "Fixture", origin: "research", selected: false, sources: [{ url: "https://example.com/fixture", title: "Local fixture source", retrievedAt: "2026-10-03T12:00:00Z" }] };
    const research = { ...result, operation: "strategy.competitors", proposal: { message: "Local research fixture", competitors: [competitor] } };
    expect(strategyJobResultSchema.safeParse(research).success).toBe(true);
    expect(strategyJobResultSchema.safeParse({ ...research, proposal: { ...research.proposal, competitors: [{ ...competitor, selected: true }] } }).success).toBe(false);
    expect(strategyJobResultSchema.safeParse({ ...research, proposal: { ...research.proposal, competitors: [{ ...competitor, sources: [] }] } }).success).toBe(false);
    const segment = { id: competitor.id, label: "Fixture", needs: [], reason: "Fixture", selected: false, origin: "proposal", sources: [] };
    const audience = { ...result, operation: "strategy.audience", proposal: { message: "Local audience fixture", segments: [segment] } };
    expect(strategyJobResultSchema.safeParse(audience).success).toBe(true);
    expect(strategyJobResultSchema.safeParse({ ...audience, proposal: { ...audience.proposal, segments: [{ ...segment, sources: competitor.sources }] } }).success).toBe(false);
  });
  it("keeps apply input source-bound and availability honest", () => {
    expect(applyStrategyJobSchema.safeParse({ expectedRevision: 1, stepKey: "proposal" }).success).toBe(true);
    expect(applyStrategyJobSchema.safeParse({ expectedRevision: 1, stepKey: "proposal", output: result }).success).toBe(false);
    expect(strategyAvailabilitySchema.safeParse({ status: "available", operations: [] }).success).toBe(false);
    expect(strategyAvailabilitySchema.safeParse({ status: "unavailable", operations: [], reason: "worker_unavailable" }).success).toBe(true);
  });
});
