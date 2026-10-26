import "server-only";
import { namingResponsesQuoteSchema, namingResponsesWireSchema, type NamingResponsesQuote, type NamingResponsesWire } from "../../../domain/naming-responses";

/** Source facts, not a provider qualification or final bill. See the evidence
 * record for citations, long-context/cache/tier conditions and the research gap. */
export const NAMING_RESPONSES_RATE_CARD = Object.freeze({ id: "openai-gpt-6-luna-standard-20261024", model: "gpt-6-luna", serviceTier: "default",
  validFrom: "2026-10-24T00:00:00Z", validUntil: "2026-10-25T00:00:00Z", contextTokens: 1_050_000, maximumOutputTokens: 32_768,
  inputNanoUsdPerToken: 200, outputNanoUsdPerToken: 750, searchNanoUsdPerCall: 10_000_000,
  sourceUrls: ["https://developers.openai.com/api/docs/pricing", "https://developers.openai.com/api/docs/models/gpt-6-luna", "https://developers.openai.com/api/docs/guides/prompt-caching"] });
export type ResponsesInputQualification = { id: string; validUntil: string; maximumInputTokens: number | null; sourceComplete: boolean; hostedResearch: boolean };
export const NAMING_RESPONSES_TEXT_QUALIFICATION: ResponsesInputQualification = Object.freeze({ id: "plaintext-full-context-v1", validUntil: NAMING_RESPONSES_RATE_CARD.validUntil,
  maximumInputTokens: NAMING_RESPONSES_RATE_CARD.contextTokens, sourceComplete: true, hostedResearch: false });
export const NAMING_RESPONSES_RESEARCH_QUALIFICATION: ResponsesInputQualification = Object.freeze({ id: "hosted-search-unqualified-v1", validUntil: NAMING_RESPONSES_RATE_CARD.validUntil,
  maximumInputTokens: null, sourceComplete: false, hostedResearch: true });

/** Exact nanodollars; never float USD or reduce a reservation using usage. The
 * source card deliberately uses the more expensive long-context rates for every
 * request. Explicit cache mode + no breakpoints avoids relying on discounts or
 * allowing implicit cache-write fees. No count endpoint is called or priced. */
export function maximumNamingResponsesCost(inputTokens: number, outputTokens: number, searchCalls: number): number {
  for (const quantity of [inputTokens, outputTokens, searchCalls]) if (!Number.isSafeInteger(quantity) || quantity < 0) throw Error("responses_quantity_invalid");
  const total = BigInt(inputTokens) * BigInt(NAMING_RESPONSES_RATE_CARD.inputNanoUsdPerToken)
    + BigInt(outputTokens) * BigInt(NAMING_RESPONSES_RATE_CARD.outputNanoUsdPerToken) + BigInt(searchCalls) * BigInt(NAMING_RESPONSES_RATE_CARD.searchNanoUsdPerCall);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("responses_cost_overflow");
  return Number(total);
}

export function quoteNamingResponses(body: NamingResponsesWire, now: number, qualification?: ResponsesInputQualification): NamingResponsesQuote {
  body = namingResponsesWireSchema.parse(body);
  const hosted = body.tools.some(tool => tool.type === "web_search");
  const proof = qualification ?? (hosted ? NAMING_RESPONSES_RESEARCH_QUALIFICATION : NAMING_RESPONSES_TEXT_QUALIFICATION);
  const validUntil = Math.min(Date.parse(NAMING_RESPONSES_RATE_CARD.validUntil), Date.parse(proof.validUntil));
  if (!Number.isFinite(now) || now < Date.parse(NAMING_RESPONSES_RATE_CARD.validFrom) || !Number.isFinite(validUntil) || now >= validUntil) throw Error("responses_rate_qualification_expired");
  if (!proof.sourceComplete || proof.maximumInputTokens === null || proof.hostedResearch !== hosted) throw Error("responses_research_input_unqualified");
  if (!hosted && proof.maximumInputTokens !== NAMING_RESPONSES_RATE_CARD.contextTokens) throw Error("responses_input_bound_invalid");
  const maximumToolCalls = body.max_tool_calls ?? 0;
  return namingResponsesQuoteSchema.parse({ rateCardId: NAMING_RESPONSES_RATE_CARD.id, qualificationId: proof.id, validUntil: new Date(validUntil).toISOString(),
    maximumInputTokens: proof.maximumInputTokens, maximumOutputTokens: body.max_output_tokens, maximumToolCalls,
    maximumCostNanoUsd: maximumNamingResponsesCost(proof.maximumInputTokens, body.max_output_tokens, maximumToolCalls) });
}

/** A mandatory research pass is retained. Pure-text math cannot qualify that
 * workflow. This gate has no environment opt-out and allocates no new budget. */
export function namingResponsesProductionReadiness() {
  return { available: false as const, code: "responses_research_input_unqualified" as const, targetCount: 100 as const, model: "gpt-6-luna" as const, reasoningEffort: "xhigh" as const };
}
