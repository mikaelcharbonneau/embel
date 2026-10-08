import "server-only";
import { z } from "zod";
import { strategyJobPolicySchema, type StrategyJobPolicy, type StrategyOperation } from "../../domain/strategy-jobs";

// Official model/pricing docs checked 2026-10-03. Access is a separate runtime gate.
export const OPENAI_STRATEGY_MODEL = "gpt-6.1-sol";
export const STRATEGY_HANDLER_VERSION = "strategy-openai-v1";
export const STRATEGY_PRICING_VERSION = "2026-10-03";
export const MAX_INITIAL_INPUT_TOKENS = 32_768;

export function strategyPolicy(operation: StrategyOperation): StrategyJobPolicy {
  const research = operation === "strategy.competitors";
  return strategyJobPolicySchema.parse({
    version: 1, pricingVersion: STRATEGY_PRICING_VERSION, handlerVersion: STRATEGY_HANDLER_VERSION,
    model: OPENAI_STRATEGY_MODEL,
    maxInputTokens: research ? 600_000 : MAX_INITIAL_INPUT_TOKENS,
    maxOutputTokens: research ? 8_192 : 4_096, maxWebSearchCalls: research ? 2 : 0,
    inputMicrousdPerMillionTokens: 2_000_000,
    cachedInputMicrousdPerMillionTokens: 100_000,
    cacheWriteMicrousdPerMillionTokens: 2_500_000,
    outputMicrousdPerMillionTokens: 10_000_000,
    webSearchMicrousdPerCall: 10_000,
    maximumCostMicrousd: research ? 3_142_880 : 122_880,
  });
}

export type OpenAIStrategyConfiguration = {
  apiKey: string;
  policies: ReadonlyMap<StrategyOperation, StrategyJobPolicy>;
};

/** No default model, credential, permission, or account access is inferred. */
export function readOpenAIStrategyConfiguration(env: Record<string, string | undefined> = process.env): OpenAIStrategyConfiguration | null {
  if (env.FLUID_PAID_CALLS_APPROVED !== "true") return null;
  const key = z.string().trim().min(16).max(500).regex(/^[^\s]+$/).safeParse(env.OPENAI_API_KEY);
  if (!key.success) return null;
  const verified = (env.FLUID_OPENAI_VERIFIED_MODELS ?? "").split(",").map(value => value.trim());
  if (!verified.includes(OPENAI_STRATEGY_MODEL)) return null;
  const policies = new Map<StrategyOperation, StrategyJobPolicy>();
  for (const [operation, variable] of [
    ["strategy.reformulate", "FLUID_TEXT_MODEL_REFORMULATE"],
    ["strategy.competitors", "FLUID_TEXT_MODEL_COMPETITORS"],
    ["strategy.audience", "FLUID_TEXT_MODEL_AUDIENCE"],
    ["strategy.personality", "FLUID_TEXT_MODEL_PERSONALITY"],
    ["strategy.positioning", "FLUID_TEXT_MODEL_POSITIONING"],
  ] as const) {
    const selected = env[variable] ?? env.FLUID_TEXT_MODEL_STRATEGY;
    if (selected === OPENAI_STRATEGY_MODEL) policies.set(operation, strategyPolicy(operation));
  }
  return policies.size ? { apiKey: key.data, policies } : null;
}

export function matchesStrategyPolicy(operation: StrategyOperation, policy: StrategyJobPolicy): boolean {
  const expected = strategyPolicy(operation);
  return Object.keys(expected).every(key => expected[key as keyof StrategyJobPolicy] === policy[key as keyof StrategyJobPolicy]);
}
