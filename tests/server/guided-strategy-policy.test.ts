import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { guidedStrategyPolicy, isHostedStrategyPolicy, matchesStrategyPolicy, readOpenAIStrategyConfiguration, strategyPolicy } from "../../src/server/ai/config";
import { calculateStrategyCost } from "../../src/server/ai/strategy-response";
import { inputFixture } from "./openai-fixtures";

describe("exact bounded guided interview policy", () => {
  it("reserves the maximum model-context/tool envelope at the most expensive input rate", () => {
    const policy = guidedStrategyPolicy("strategy.competitors");
    expect(policy).toMatchObject({ version: 2, handlerVersion: "strategy-openai-guided-v1", pricingVersion: "2026-10-14",
      model: "gpt-6.1-sol", maxInputTokens: 3 * 1_050_000, maxOutputTokens: 8192, maxWebSearchCalls: 2, maximumCostMicrousd: 15_892_880 });
    const usage = { input_tokens: policy.maxInputTokens, output_tokens: policy.maxOutputTokens,
      total_tokens: policy.maxInputTokens + policy.maxOutputTokens, input_tokens_details: { cached_tokens: 0, cache_write_tokens: policy.maxInputTokens } };
    expect(calculateStrategyCost(usage, 2, { ...inputFixture(), policy })).toBe(policy.maximumCostMicrousd);
    expect(isHostedStrategyPolicy("strategy.competitors", policy)).toBe(true);
    expect(isHostedStrategyPolicy("strategy.competitors", strategyPolicy("strategy.competitors"))).toBe(false);
  });
  it("requires every policy field and the correct operation to match, preserving old text policies", () => {
    for (const operation of ["strategy.reformulate", "strategy.audience", "strategy.positioning", "strategy.personality", "strategy.slogan"] as const) {
      const policy = guidedStrategyPolicy(operation);
      expect(policy).toMatchObject({ maxInputTokens: 32768, maxOutputTokens: 4096, maxWebSearchCalls: 0, maximumCostMicrousd: 122880 });
      expect(isHostedStrategyPolicy(operation, policy)).toBe(true);
      expect(isHostedStrategyPolicy(operation, strategyPolicy(operation))).toBe(operation !== "strategy.slogan");
      expect(matchesStrategyPolicy(operation, { ...policy, maximumCostMicrousd: 1 })).toBe(false);
      expect(isHostedStrategyPolicy("strategy.competitors", policy)).toBe(false);
    }
    expect(isHostedStrategyPolicy("strategy.competitors", guidedStrategyPolicy("strategy.positioning"))).toBe(false);
    expect(isHostedStrategyPolicy("naming.generate" as never, strategyPolicy("strategy.reformulate"))).toBe(false);
  });
  it("uses the new policy only after explicit guided opt-in and configured model choices", () => {
    const env = { OPENAI_API_KEY: "synthetic-test-credential", FLUID_PAID_CALLS_APPROVED: "true", FLUID_OPENAI_VERIFIED_MODELS: "gpt-6.1-sol", FLUID_TEXT_MODEL_REFORMULATE: "gpt-6.1-sol", FLUID_TEXT_MODEL_COMPETITORS: "gpt-6.1-sol" };
    expect(readOpenAIStrategyConfiguration(env)?.policies.get("strategy.reformulate")).toEqual(strategyPolicy("strategy.reformulate"));
    const guided = readOpenAIStrategyConfiguration({ ...env, FLUID_GUIDED_INTERVIEW_ENABLED: "true" });
    expect([...guided!.policies.keys()]).toEqual(["strategy.reformulate", "strategy.competitors"]);
    expect(guided!.policies.get("strategy.competitors")).toEqual(guidedStrategyPolicy("strategy.competitors"));
    expect(readOpenAIStrategyConfiguration({ ...env, FLUID_GUIDED_INTERVIEW_ENABLED: "true", FLUID_PAID_CALLS_APPROVED: "false" })).toBeNull();
  });
});
