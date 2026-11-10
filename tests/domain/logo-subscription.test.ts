import { describe, expect, it } from "vitest";
import * as contracts from "@/domain/logo-jobs";
const policy = {
  version: 1,
  billingMode: "chatgpt_subscription",
  handlerVersion: "logo-directions-v1",
  adapterVersion: "logo-directions-chatgpt-v1",
  registrationId: "fixture-account",
  model: "fixture-model",
  apiCharge: "verified_zero",
  limits: {
    maxInputBytes: 131072,
    maxOutputBytes: 262144,
    maxStreamBytes: 2097152,
    deadlineMs: 240000,
    maxObservedWebSearchCalls: 0,
    maxRequestsPerHour: 20,
    maxQueuedJobs: 3,
  },
};
const legacy = {
  provider: "openai",
  model: "fixture-model",
  providerRequestId: null,
  responseHash: "a".repeat(64),
  observedAt: "2026-10-07T00:00:00Z",
  billing: { status: "recorded", confirmedMicrousd: 0 },
  artifactHash: null,
};
const observation = {
  ...legacy,
  version: 2,
  billingMode: "chatgpt_subscription",
  registrationId: "fixture-account",
  responseId: "resp_fixture",
  usage: null,
};
describe("dedicated directions subscription contracts", () => {
  it("accepts an explicitly versioned subscription observation while retaining legacy image observations unchanged", () => {
    expect(contracts.logoProviderObservationSchema.safeParse(legacy).success).toBe(true);
    expect(contracts.logoProviderObservationSchema.safeParse(observation).success).toBe(true);
  });
  it("requires exact registration, validated usage, zero recorded API charge and no image accounting fields", () => {
    for (const patch of [
      { registrationId: "" },
      { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 4 } },
      { billing: { status: "recorded", confirmedMicrousd: 1 } },
      { artifactHash: "b".repeat(64) },
      { normalizedPixelHash: "a".repeat(64) },
      { responseId: "header-not-response" },
    ])
      expect(contracts.logoProviderObservationSchema.safeParse({ ...observation, ...patch }).success).toBe(false);
    expect(
      contracts.logoProviderObservationSchema.safeParse({
        ...observation,
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      }).success,
    ).toBe(true);
    expect(
      contracts.logoProviderObservationSchema.safeParse({ ...observation, responseId: null, responseHash: null })
        .success,
    ).toBe(true);
  });
  it("freezes a dedicated policy with tool-free bounded transport and queue limits", () => {
    expect(contracts).toHaveProperty("logoDirectionsSubscriptionPolicySchema");
    const schema = contracts.logoDirectionsSubscriptionPolicySchema;
    expect(schema.safeParse(policy).success).toBe(true);
    for (const patch of [
      { handlerVersion: "strategy-chatgpt-v1" },
      { adapterVersion: "wrong" },
      { apiCharge: "unknown" },
      { limits: { ...policy.limits, maxInputBytes: 131073 } },
      { limits: { ...policy.limits, maxOutputBytes: 262145 } },
      { limits: { ...policy.limits, maxStreamBytes: 2097153 } },
      { limits: { ...policy.limits, deadlineMs: 240001 } },
      { limits: { ...policy.limits, maxObservedWebSearchCalls: 1 } },
    ])
      expect(schema.safeParse({ ...policy, ...patch }).success).toBe(false);
  });
});
import { subscriptionFixture } from "../features/identity-directions/subscription-fixtures";
it("freezes policy and mode together on directions jobs and refuses mismatched handler or legacy policy injection", () => {
  const { job } = subscriptionFixture(),
    input = job.input as Record<string, unknown>;
  expect(contracts.logoDirectionsJobInputSchema.safeParse(input).success).toBe(true);
  const { policy: _policy, billingMode: _mode, ...legacyInput } = input;
  void _policy;
  void _mode;
  expect(contracts.logoDirectionsJobInputSchema.parse(legacyInput)).toEqual(legacyInput);
  expect(contracts.logoDirectionsJobInputSchema.safeParse({ ...legacyInput, policy }).success).toBe(false);
  expect(contracts.logoDirectionsJobInputSchema.safeParse({ ...input, handlerVersion: "other" }).success).toBe(false);
});
it("adds explicit subscription billing only to a paired zero-API directions quote", () => {
  const { policy } = subscriptionFixture(),
    heads = {
      projectRevision: 1,
      referenceRevision: 0,
      preferencesRevision: 0,
      workspaceRevision: 1,
      stageRevisions: { brief_references: 1, concepts: 0, vector: 0, refinements: 0, directions: 0, deliverables: 0 },
    },
    id = "64000000-0000-4000-8000-000000000001";
  const quote = {
    id,
    ownerId: id,
    projectId: id,
    request: { operation: "directions", expected: heads, approvedLogoId: id },
    inputHash: "a".repeat(64),
    expected: heads,
    policyIdentity: "b".repeat(64),
    handlerVersion: policy.handlerVersion,
    provider: "openai",
    model: policy.model,
    engine: null,
    estimatedCostMicrousd: 0,
    maxCostMicrousd: 0,
    externalProviderCostMicrousd: 0,
    expiresAt: "2026-10-07T00:00:00Z",
    conceptPlan: null,
    targetSlotIds: [],
    billingMode: "chatgpt_subscription",
    policy,
  };
  expect(contracts.logoCostQuoteSchema.safeParse(quote).success).toBe(true);
  for (const patch of [
    { policy: undefined },
    { billingMode: undefined },
    { maxCostMicrousd: 1 },
    { estimatedCostMicrousd: 1 },
    { externalProviderCostMicrousd: null },
    { provider: "other" },
    { model: "other" },
    { handlerVersion: "other" },
  ])
    expect(contracts.logoCostQuoteSchema.safeParse({ ...quote, ...patch }).success).toBe(false);
});
