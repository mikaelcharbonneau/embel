import { describe, expect, it } from "vitest";
import {
  chatGPTStrategyJobInputSchema,
  chatGPTStrategyResultSchema,
  enqueueStrategyJobSchema,
  strategyAvailabilitySchema,
  strategyJobResultSchema,
  strategyJobSummarySchema,
} from "@/domain/strategy-jobs";

const policyIdentity = "a".repeat(64);
const limits = {
  maxInputBytes: 131_072,
  maxOutputBytes: 262_144,
  deadlineMs: 240_000,
  maxObservedWebSearchCalls: 2,
  maxRequestsPerHour: 20,
  maxQueuedJobs: 3,
};
const result = {
  version: 1,
  provider: "openai",
  billingMode: "chatgpt_subscription",
  model: "fixture-model",
  responseId: "fixture-response",
  requestId: null,
  generatedAt: "2026-10-03T12:00:00Z",
  usage: null,
  operation: "strategy.reformulate",
  proposal: {
    message: "A synthetic local fixture.",
    activity: "",
    offering: "",
    knownAudience: "",
    questions: ["Who should it serve?"],
  },
};

describe("ChatGPT subscription strategy contracts", () => {
  it("accepts actual unknown usage without inventing paid API cache or dollar fields", () => {
    expect(chatGPTStrategyResultSchema.parse(result)).toEqual(result);
    expect(strategyJobResultSchema.parse(result)).toEqual(result);
    expect(
      chatGPTStrategyResultSchema.safeParse({
        ...result,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      }).success,
    ).toBe(true);
    expect(
      chatGPTStrategyResultSchema.safeParse({
        ...result,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 29 },
      }).success,
    ).toBe(false);
    expect(chatGPTStrategyResultSchema.safeParse({ ...result, accountId: "do-not-publish" }).success).toBe(false);
  });

  it("requires an explicit subscription enqueue discriminator and forbids currency acceptance", () => {
    const request = {
      operation: "strategy.reformulate",
      expectedRevision: 1,
      idempotencyKey: "subscription-fixture-0001",
      billingMode: "chatgpt_subscription",
      acceptedPolicyIdentity: policyIdentity,
    };
    expect(enqueueStrategyJobSchema.parse(request)).toEqual(request);
    expect(enqueueStrategyJobSchema.safeParse({ ...request, acceptedPolicyIdentity: undefined }).success).toBe(false);
    expect(
      enqueueStrategyJobSchema.safeParse({ ...request, acceptedPolicyIdentity: "not-an-approved-policy" }).success,
    ).toBe(false);
    expect(enqueueStrategyJobSchema.safeParse({ ...request, acceptedMaxCostMicrousd: 0 }).success).toBe(false);
    expect(enqueueStrategyJobSchema.safeParse({ ...request, ownerId: crypto.randomUUID() }).success).toBe(false);
    const missingMode = {
      operation: request.operation,
      expectedRevision: request.expectedRevision,
      idempotencyKey: request.idempotencyKey,
    };
    expect(enqueueStrategyJobSchema.safeParse(missingMode).success).toBe(false);
  });

  it("exposes operator app limits without pretending to know remaining plan quota or a zero-dollar estimate", () => {
    const availability = {
      status: "available",
      operations: [{ operation: "strategy.reformulate", billingMode: "chatgpt_subscription", limits, policyIdentity }],
    };
    expect(strategyAvailabilitySchema.parse(availability)).toEqual(availability);
    expect(
      strategyAvailabilitySchema.safeParse({
        ...availability,
        operations: [{ ...availability.operations[0], maximumCostMicrousd: 0 }],
      }).success,
    ).toBe(false);
  });

  it("keeps subscription job inputs immutable and separate from paid API policy", () => {
    const input = {
      version: 1,
      billingMode: "chatgpt_subscription",
      context: {},
      policy: {
        version: 1,
        billingMode: "chatgpt_subscription",
        handlerVersion: "strategy-chatgpt-v1",
        registrationId: "fixture-registration",
        model: "fixture-model",
        limits,
      },
    };
    expect(chatGPTStrategyJobInputSchema.parse(input).context.description).toBe("");
    expect(chatGPTStrategyJobInputSchema.parse(input)).toHaveProperty("assistantHistory", {
      entries: [],
      truncated: false,
    });
    expect(chatGPTStrategyJobInputSchema.safeParse({ ...input, acceptedMaxCostMicrousd: 0 }).success).toBe(false);
    expect(
      chatGPTStrategyJobInputSchema.safeParse({ ...input, assistantHistory: { entries: [], truncated: false } })
        .success,
    ).toBe(false);
  });

  it("validates versioned server history, source identity, uniqueness, chronology and full typed proposals", () => {
    const entry = {
      jobId: crypto.randomUUID(),
      ownerId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      stepKey: "respond",
      inputRevision: 1,
      completedAt: "2026-10-03T12:00:00Z",
      output: result,
    };
    const input = {
      version: 2,
      billingMode: "chatgpt_subscription",
      context: {},
      policy: {
        version: 1,
        billingMode: "chatgpt_subscription",
        handlerVersion: "strategy-chatgpt-v1",
        registrationId: "fixture-registration",
        model: "fixture-model",
        limits,
      },
      assistantHistory: { entries: [entry], truncated: false },
    };
    expect(chatGPTStrategyJobInputSchema.parse(input).assistantHistory.entries).toEqual([entry]);
    for (const entries of [
      [entry, entry],
      [{ ...entry, ownerId: "untrusted-owner" }],
      [{ ...entry, output: { ...result, reasoning: "synthetic forbidden reasoning" } }],
      [{ ...entry, output: { ...result, proposal: { ...result.proposal, approved: true } } }],
      [entry, { ...entry, jobId: crypto.randomUUID(), completedAt: "2026-10-04T12:00:00Z" }],
    ]) {
      expect(
        chatGPTStrategyJobInputSchema.safeParse({ ...input, assistantHistory: { entries, truncated: false } }).success,
      ).toBe(false);
    }
    const six = Array.from({ length: 6 }, () => ({ ...entry, jobId: crypto.randomUUID() }));
    expect(
      chatGPTStrategyJobInputSchema.safeParse({ ...input, assistantHistory: { entries: six, truncated: false } })
        .success,
    ).toBe(false);
    const large = Array.from({ length: 5 }, () => ({
      ...entry,
      jobId: crypto.randomUUID(),
      output: { ...result, proposal: { ...result.proposal, message: "é".repeat(6000) } },
    }));
    expect(
      chatGPTStrategyJobInputSchema.safeParse({ ...input, assistantHistory: { entries: large, truncated: false } })
        .success,
    ).toBe(false);
  });

  it("rejects browser-authored assistant history on enqueue", () => {
    const request = {
      operation: "strategy.reformulate",
      expectedRevision: 1,
      idempotencyKey: "subscription-fixture-0001",
      billingMode: "chatgpt_subscription",
      acceptedPolicyIdentity: policyIdentity,
    };
    expect(
      enqueueStrategyJobSchema.safeParse({ ...request, assistantHistory: { entries: [], truncated: false } }).success,
    ).toBe(false);
  });

  it("omits monetary fields from public subscription summaries while keeping the owner and revision", () => {
    const summary = {
      id: crypto.randomUUID(),
      owner_id: crypto.randomUUID(),
      project_id: crypto.randomUUID(),
      operation: "strategy.reformulate",
      input_revision: 1,
      state: "queued",
      progress: 0,
      billingMode: "chatgpt_subscription",
      policyIdentity,
      error_code: null,
      cancel_requested_at: null,
      created_at: "2026-10-03T12:00:00Z",
      finished_at: null,
    };
    expect(strategyJobSummarySchema.parse(summary)).toEqual(summary);
  });
});
