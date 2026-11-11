import { describe, expect, it } from "vitest";
import {
  strategyAssistantHistorySchema,
  strategyAvailabilitySchema,
  strategyJobInputSchema,
  strategyJobResultSchema,
  strategyJobSchema,
} from "../../src/domain/strategy-jobs";
import { contextSnapshotSchema } from "../../src/domain/projects";

const context = contextSnapshotSchema.parse({ description: "Explicit local strategy contract fixture." });
const policy = {
  version: 1,
  pricingVersion: "2026-10-03",
  handlerVersion: "strategy-openai-v1",
  model: "fixture-model",
  maxInputTokens: 32768,
  maxOutputTokens: 4096,
  maxWebSearchCalls: 0,
  inputMicrousdPerMillionTokens: 2_000_000,
  cachedInputMicrousdPerMillionTokens: 100_000,
  cacheWriteMicrousdPerMillionTokens: 2_500_000,
  outputMicrousdPerMillionTokens: 10_000_000,
  webSearchMicrousdPerCall: 10_000,
  maximumCostMicrousd: 122_880,
};
const result = {
  version: 1,
  operation: "strategy.reformulate",
  provider: "openai",
  model: "fixture-model",
  responseId: "fixture-response",
  requestId: null,
  generatedAt: "2026-10-03T12:00:00Z",
  usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: 0 },
  proposal: {
    message: "Explicit local result fixture, not live output.",
    activity: "Fixture activity",
    offering: "Fixture offering",
    knownAudience: "",
    questions: [],
  },
};

describe("strategy job contracts", () => {
  it("binds versioned policy and full saved context to the accepted cap", () => {
    expect(
      strategyJobInputSchema.parse({ version: 1, context, policy, acceptedMaxCostMicrousd: 122_880 }).context,
    ).toEqual(context);
    expect(strategyJobInputSchema.safeParse({ version: 1, context, policy, acceptedMaxCostMicrousd: 1 }).success).toBe(
      false,
    );
    expect(
      strategyJobInputSchema.safeParse({
        version: 1,
        context,
        policy: { ...policy, handlerVersion: "unreviewed-v2" },
        acceptedMaxCostMicrousd: 122_880,
      }).success,
    ).toBe(false);
  });
  it("rejects fabricated result provenance, invalid usage and mismatched operation output", () => {
    expect(strategyJobResultSchema.safeParse(result).success).toBe(true);
    for (const invalid of [
      { ...result, provider: "user" },
      { ...result, operation: "strategy.competitors" },
      { ...result, usage: { ...result.usage, cachedInputTokens: 101 } },
    ]) {
      expect(strategyJobResultSchema.safeParse(invalid).success).toBe(false);
    }
    const job = {
      id: "11111111-1111-4111-8111-111111111111",
      owner_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      project_id: "22222222-2222-4222-8222-222222222222",
      operation: "strategy.reformulate",
      input_revision: 1,
      state: "partial",
      progress: 50,
      reserved_cost_microusd: 100,
      actual_cost_microusd: 50,
      error_code: null,
      cancel_requested_at: null,
      created_at: "2026-10-03T12:00:00Z",
      finished_at: null,
      results: [{ stepKey: "proposal", output: result }],
    };
    expect(strategyJobSchema.safeParse(job).success).toBe(true);
    expect(strategyJobSchema.safeParse({ ...job, operation: "strategy.competitors" }).success).toBe(false);
    expect(strategyJobSchema.safeParse({ ...job, results: [...job.results, ...job.results] }).success).toBe(false);
    const application = {
      jobId: job.id,
      stepKey: "proposal",
      inputRevision: 1,
      appliedRevision: 2,
      appliedAt: "2026-10-04T12:00:00Z",
    };
    const applied = { ...job, results: [{ ...job.results[0], application }] };
    expect(strategyJobSchema.safeParse(applied).success).toBe(true);
    for (const change of [
      { jobId: job.project_id },
      { stepKey: "other" },
      { inputRevision: 2, appliedRevision: 3 },
      { appliedRevision: 3 },
      { appliedAt: "invalid" },
    ]) {
      expect(
        strategyJobSchema.safeParse({
          ...job,
          results: [{ ...job.results[0], application: { ...application, ...change } }],
        }).success,
      ).toBe(false);
    }
  });
  it("never lets a model approve competitor or audience choices, or invent audience sources", () => {
    const competitor = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Fixture",
      relevance: "Fixture",
      origin: "research",
      selected: false,
      sources: [
        { url: "https://example.com/fixture", title: "Local fixture source", retrievedAt: "2026-10-03T12:00:00Z" },
      ],
    };
    const research = {
      ...result,
      operation: "strategy.competitors",
      proposal: { message: "Local research fixture", competitors: [competitor] },
    };
    expect(strategyJobResultSchema.safeParse(research).success).toBe(true);
    expect(
      strategyJobResultSchema.safeParse({
        ...research,
        proposal: { ...research.proposal, competitors: [{ ...competitor, selected: true }] },
      }).success,
    ).toBe(false);
    expect(
      strategyJobResultSchema.safeParse({
        ...research,
        proposal: { ...research.proposal, competitors: [{ ...competitor, sources: [] }] },
      }).success,
    ).toBe(false);
    const segment = {
      id: competitor.id,
      label: "Fixture",
      needs: [],
      reason: "Fixture",
      selected: false,
      origin: "proposal",
      sources: [],
    };
    const audience = {
      ...result,
      operation: "strategy.audience",
      proposal: { message: "Local audience fixture", segments: [segment] },
    };
    expect(strategyJobResultSchema.safeParse(audience).success).toBe(true);
    expect(
      strategyJobResultSchema.safeParse({
        ...audience,
        proposal: { ...audience.proposal, segments: [{ ...segment, sources: competitor.sources }] },
      }).success,
    ).toBe(false);
  });
  it("keeps availability honest", () => {
    expect(strategyAvailabilitySchema.safeParse({ status: "available", operations: [] }).success).toBe(false);
    expect(
      strategyAvailabilitySchema.safeParse({ status: "unavailable", operations: [], reason: "worker_unavailable" })
        .success,
    ).toBe(true);
    expect(
      strategyAvailabilitySchema.safeParse({
        status: "unavailable",
        operations: [],
        reason: "subscription_unavailable",
      }).success,
    ).toBe(false);
    expect(
      strategyAvailabilitySchema.safeParse({
        status: "available",
        operations: [
          { operation: "strategy.reformulate", billingMode: "chatgpt_subscription", policyIdentity: "a".repeat(64) },
        ],
      }).success,
    ).toBe(false);
  });
  it("validates server history: source identity, uniqueness, chronology, size and full typed proposals", () => {
    const entry = {
      jobId: crypto.randomUUID(),
      ownerId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      stepKey: "respond",
      inputRevision: 1,
      completedAt: "2026-10-03T12:00:00Z",
      output: result,
    };
    const history = (entries: unknown[]) => ({ entries, truncated: false });
    expect(strategyAssistantHistorySchema.parse(history([entry])).entries).toEqual([entry]);
    for (const entries of [
      [entry, entry],
      [{ ...entry, ownerId: "untrusted-owner" }],
      [{ ...entry, output: { ...result, reasoning: "synthetic forbidden reasoning" } }],
      [{ ...entry, output: { ...result, proposal: { ...result.proposal, approved: true } } }],
      [entry, { ...entry, jobId: crypto.randomUUID(), completedAt: "2026-10-04T12:00:00Z" }],
      Array.from({ length: 6 }, () => ({ ...entry, jobId: crypto.randomUUID() })),
      Array.from({ length: 5 }, () => ({
        ...entry,
        jobId: crypto.randomUUID(),
        output: { ...result, proposal: { ...result.proposal, message: "é".repeat(6000) } },
      })),
    ]) {
      expect(strategyAssistantHistorySchema.safeParse(history(entries)).success).toBe(false);
    }
  });
});
