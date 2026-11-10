import "server-only";
import { z } from "zod";
import { strategyJobPolicySchema, strategyOperationSchema, type StrategyJobPolicy, type StrategyOperation } from "../../domain/strategy-jobs";

// Model and policy settings of the generation engine's text requests. Official model and
// pricing docs checked 2026-10-03. The engine's kinds and stop switch control access.
export const OPENAI_STRATEGY_MODEL = "gpt-6.1-sol";
export const STRATEGY_HANDLER_VERSION = "strategy-openai-v1";
export const STRATEGY_PRICING_VERSION = "2026-10-03";
export const MAX_INITIAL_INPUT_TOKENS = 32_768;
export const GUIDED_STRATEGY_HANDLER_VERSION = "strategy-openai-guided-v1";
export const GUIDED_STRATEGY_PRICING_VERSION = "2026-10-14";
export const GUIDED_RESEARCH_MAX_INPUT_TOKENS = 3_150_000;
export const GUIDED_RESEARCH_MAX_COST_MICROUSD = 15_892_880;
export const LOCAL_STRATEGY_MODEL = "gpt-6-luna";
export const LOCAL_STRATEGY_PRICING_VERSION = "2026-10-18";
/** Naming generation uses the same model as the Naming worker lane (policy version 2, low reasoning). */
export const OPENAI_NAMING_MODEL = "gpt-6-luna";
/** gpt-6-luna Standard prices in microdollars per million tokens, checked 2026-10-18:
 * https://developers.openai.com/api/docs/pricing and https://developers.openai.com/api/docs/models/gpt-6-luna */
export const LUNA_PRICES = Object.freeze({ inputMicrousdPerMillionTokens: 100_000, cachedInputMicrousdPerMillionTokens: 10_000,
  cacheWriteMicrousdPerMillionTokens: 125_000, outputMicrousdPerMillionTokens: 500_000 });

type GuidedStrategyOperation = StrategyOperation;

/** Two built-in tool calls permit at most three model turns. Reserve each at
 * the full documented 1,050,000-token model context, including search, and use
 * the highest long-context input rate (cache writes). Output includes reasoning.
 * 3,150,000 * $5/M + 8,192 * $15/M + 2 * $0.01 = $15.89288.
 * Evidence: docs/guided-interview-runtime.md. Low/default search settings are
 * not treated as numeric cost controls. Legacy research remains unqualified. */
export function guidedStrategyPolicy(operation: GuidedStrategyOperation, model: typeof OPENAI_STRATEGY_MODEL | typeof LOCAL_STRATEGY_MODEL = OPENAI_STRATEGY_MODEL): StrategyJobPolicy {
  strategyOperationSchema.parse(operation);
  z.enum([OPENAI_STRATEGY_MODEL, LOCAL_STRATEGY_MODEL]).parse(model);
  const research = operation === "strategy.competitors";
  const luna = model === LOCAL_STRATEGY_MODEL;
  return strategyJobPolicySchema.parse({
    ...strategyPolicy(operation), version: 2,
    pricingVersion: luna ? LOCAL_STRATEGY_PRICING_VERSION : GUIDED_STRATEGY_PRICING_VERSION, handlerVersion: GUIDED_STRATEGY_HANDLER_VERSION,
    maxInputTokens: research ? GUIDED_RESEARCH_MAX_INPUT_TOKENS : MAX_INITIAL_INPUT_TOKENS,
    maximumCostMicrousd: luna ? research ? 813_644 : 6_144 : research ? GUIDED_RESEARCH_MAX_COST_MICROUSD : 122_880,
    // Official Standard prices checked 2026-10-18:
    // https://developers.openai.com/api/docs/pricing
    // https://developers.openai.com/api/docs/models/gpt-6-luna
    // Long-context research reserves cache writes at $0.25/M and output at $0.75/M.
    ...(luna ? { model, ...LUNA_PRICES } : {}),
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
