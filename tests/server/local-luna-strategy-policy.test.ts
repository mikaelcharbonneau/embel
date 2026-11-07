import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { guidedStrategyPolicy, isHostedStrategyPolicy, LOCAL_STRATEGY_MODEL, matchesStrategyPolicy, readOpenAIStrategyConfiguration, strategyPolicy } from "../../src/server/ai/config";
import { strategyJobPolicySchema } from "../../src/domain/strategy-jobs";
import { calculateStrategyCost } from "../../src/server/ai/strategy-response";
import { inputFixture } from "./openai-fixtures";

const operations = ["strategy.reformulate", "strategy.competitors", "strategy.audience", "strategy.personality", "strategy.positioning", "strategy.slogan"] as const;
const env = { OPENAI_API_KEY: "synthetic-luna-fixture-only", FLUID_PAID_CALLS_APPROVED: "true", FLUID_OPENAI_VERIFIED_MODELS: LOCAL_STRATEGY_MODEL,
  FLUID_LOCAL_PROTOTYPE: "true", FLUID_RUNTIME: "local", NODE_ENV: "production", APP_ORIGIN: "http://127.0.0.1:3106", FLUID_GUIDED_INTERVIEW_ENABLED: "true",
  FLUID_TEXT_MODEL_STRATEGY: LOCAL_STRATEGY_MODEL };

describe("future strict-local Luna Strategy policy", () => {
  it.each(operations)("uses exact Standard prices and the full reservation for %s", operation => {
    const policy = guidedStrategyPolicy(operation, LOCAL_STRATEGY_MODEL), research = operation === "strategy.competitors";
    expect(policy).toEqual({ ...guidedStrategyPolicy(operation), model: LOCAL_STRATEGY_MODEL, pricingVersion: "2026-10-18",
      inputMicrousdPerMillionTokens: 100_000, cachedInputMicrousdPerMillionTokens: 10_000, cacheWriteMicrousdPerMillionTokens: 125_000,
      outputMicrousdPerMillionTokens: 500_000, maximumCostMicrousd: research ? 813_644 : 6_144 });
    const usage = { input_tokens: policy.maxInputTokens, output_tokens: policy.maxOutputTokens,
      total_tokens: policy.maxInputTokens + policy.maxOutputTokens, input_tokens_details: { cached_tokens: 0, cache_write_tokens: policy.maxInputTokens } };
    expect(calculateStrategyCost(usage, policy.maxWebSearchCalls, { ...inputFixture(), policy })).toBe(policy.maximumCostMicrousd);
    expect(matchesStrategyPolicy(operation, policy)).toBe(true);
    expect(isHostedStrategyPolicy(operation, policy)).toBe(false);
    expect(matchesStrategyPolicy(operation, { ...policy, maximumCostMicrousd: 1 })).toBe(false);
  });
  it("requires the strict local gate, explicit guided mode and verified selected model for every guided operation", () => {
    const configuration = readOpenAIStrategyConfiguration(env)!;
    expect([...configuration.policies.keys()]).toEqual(operations);
    for (const operation of operations) expect(configuration.policies.get(operation)).toEqual(guidedStrategyPolicy(operation, LOCAL_STRATEGY_MODEL));
    expect(configuration.policies.has("strategy.positioning")).toBe(true);
    for (const override of [{ FLUID_LOCAL_PROTOTYPE: "false" }, { FLUID_RUNTIME: "hosted" }, { NODE_ENV: "development" },
      { APP_ORIGIN: "http://127.0.0.1:3105" }, { VERCEL: "1" }, { VERCEL_OIDC_TOKEN: "synthetic-hosted" },
      { FLUID_GUIDED_INTERVIEW_ENABLED: "false" }, { FLUID_PAID_CALLS_APPROVED: "false" }, { FLUID_OPENAI_VERIFIED_MODELS: "gpt-6.1-sol" }])
      expect(readOpenAIStrategyConfiguration({ ...env, ...override })).toBeNull();
  });
  it("preserves exact default Sol policy selection and rejects mixed model/price cards", () => {
    const sol = { ...env, FLUID_LOCAL_PROTOTYPE: "false", FLUID_OPENAI_VERIFIED_MODELS: "gpt-6.1-sol", FLUID_TEXT_MODEL_STRATEGY: "gpt-6.1-sol" };
    expect(readOpenAIStrategyConfiguration(sol)!.policies.get("strategy.competitors")).toEqual(guidedStrategyPolicy("strategy.competitors"));
    expect(readOpenAIStrategyConfiguration({ ...sol, FLUID_GUIDED_INTERVIEW_ENABLED: "false" })!.policies.get("strategy.reformulate")).toEqual(strategyPolicy("strategy.reformulate"));
    const policy = guidedStrategyPolicy("strategy.reformulate", LOCAL_STRATEGY_MODEL);
    expect(strategyJobPolicySchema.safeParse({ ...policy, pricingVersion: "2026-10-14" }).success).toBe(false);
    expect(strategyJobPolicySchema.safeParse({ ...policy, model: "gpt-6.1-sol" }).success).toBe(false);
    expect(strategyJobPolicySchema.safeParse({ ...policy, model: "unknown-fixture" }).success).toBe(false);
    expect(() => guidedStrategyPolicy("naming.generate" as never, LOCAL_STRATEGY_MODEL)).toThrow();
    expect(readOpenAIStrategyConfiguration({ ...env, FLUID_TEXT_MODEL_STRATEGY: "unsupported-fixture", FLUID_OPENAI_VERIFIED_MODELS: "unsupported-fixture" })).toBeNull();
  });
});
