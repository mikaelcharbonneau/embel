import "server-only";
import { z } from "zod";
import { strategyJobPolicySchema, strategyOperationSchema, type StrategyJobPolicy, type StrategyOperation } from "../../domain/strategy-jobs";

// Official model/pricing docs checked 2026-10-03. Access is a separate runtime gate.
export const OPENAI_STRATEGY_MODEL = "gpt-6.1-sol";
export const STRATEGY_HANDLER_VERSION = "strategy-openai-v1";
export const STRATEGY_PRICING_VERSION = "2026-10-03";
export const MAX_INITIAL_INPUT_TOKENS = 32_768;
export const GUIDED_STRATEGY_HANDLER_VERSION = "strategy-openai-guided-v1";
export const GUIDED_STRATEGY_PRICING_VERSION = "2026-10-14";
export const GUIDED_RESEARCH_MAX_INPUT_TOKENS = 3_150_000;
export const GUIDED_RESEARCH_MAX_COST_MICROUSD = 15_892_880;

type GuidedStrategyOperation = Exclude<StrategyOperation, "strategy.positioning">;

/** Two built-in tool calls permit at most three model turns. Reserve each at
 * the full documented 1,050,000-token model context, including search, and use
 * the highest long-context input rate (cache writes). Output includes reasoning.
 * 3,150,000 * $5/M + 8,192 * $15/M + 2 * $0.01 = $15.89288.
 * Evidence: docs/guided-interview-runtime.md. Low/default search settings are
 * not treated as numeric cost controls. Legacy research remains unqualified. */
export function guidedStrategyPolicy(operation: GuidedStrategyOperation): StrategyJobPolicy {
  const research = operation === "strategy.competitors";
  return strategyJobPolicySchema.parse({
    ...strategyPolicy(operation), version: 2,
    pricingVersion: GUIDED_STRATEGY_PRICING_VERSION, handlerVersion: GUIDED_STRATEGY_HANDLER_VERSION,
    maxInputTokens: research ? GUIDED_RESEARCH_MAX_INPUT_TOKENS : MAX_INITIAL_INPUT_TOKENS,
    maximumCostMicrousd: research ? GUIDED_RESEARCH_MAX_COST_MICROUSD : 122_880,
  });
}

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
    if (selected === OPENAI_STRATEGY_MODEL) policies.set(operation,
      env.FLUID_GUIDED_INTERVIEW_ENABLED === "true" && operation !== "strategy.positioning"
        ? guidedStrategyPolicy(operation) : strategyPolicy(operation));
  }
  return policies.size ? { apiKey: key.data, policies } : null;
}

export function matchesStrategyPolicy(operation: StrategyOperation, policy: StrategyJobPolicy): boolean {
  const expected = policy.version === 2 && operation !== "strategy.positioning"
    ? guidedStrategyPolicy(operation) : strategyPolicy(operation);
  return Object.keys(expected).every(key => expected[key as keyof StrategyJobPolicy] === policy[key as keyof StrategyJobPolicy]);
}

/** One shared allowlist for delivery and protected readiness. SQL separately
 * qualifies the exact owner, operation, policy, restricted role and deployment. */
export function isHostedStrategyPolicy(operation: StrategyOperation, policy: StrategyJobPolicy): boolean {
  return strategyOperationSchema.safeParse(operation).success && matchesStrategyPolicy(operation, policy) && (policy.version === 2
    ? operation !== "strategy.positioning"
    : operation !== "strategy.competitors" && policy.maxWebSearchCalls === 0 && policy.maximumCostMicrousd <= 122_880);
}
