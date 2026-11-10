import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { guidedStrategyPolicy } from "../../src/server/ai/config";
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
  });
  it("bounds every text operation without web search", () => {
    for (const operation of ["strategy.reformulate", "strategy.audience", "strategy.positioning", "strategy.personality", "strategy.slogan"] as const) {
      expect(guidedStrategyPolicy(operation)).toMatchObject({ maxInputTokens: 32768, maxOutputTokens: 4096, maxWebSearchCalls: 0, maximumCostMicrousd: 122880 });
    }
  });
});
