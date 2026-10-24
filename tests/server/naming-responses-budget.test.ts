import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBriefSnapshotSchema, namingProgressiveAssignmentSchema } from "../../src/domain/naming-brain";
import { namingResponsesJobInputSchema, namingResponsesWireSchema, NAMING_RESPONSES_MAXIMUM_NANO_USD } from "../../src/domain/naming-responses";
import { maximumNamingResponsesCost, NAMING_RESPONSES_RATE_CARD, namingResponsesProductionReadiness, quoteNamingResponses } from "../../src/server/ai/naming-responses/budget";
import { buildNamingResponsesRoleBody, createNamingResponsesRequest, validateNamingResponsesRequest } from "../../src/server/ai/naming-responses/prompts";
import { id, snapshot } from "../domain/naming-brain-fixtures";

const now = Date.parse("2026-10-24T01:00:00Z");
function bodies() {
  const brief = namingBriefSnapshotSchema.parse({ ...snapshot(), preferences: { ...snapshot().preferences, approaches: ["real_words"] } });
  const assignment = namingProgressiveAssignmentSchema.parse({ assignmentKey: "synthetic.creator", primaryApproach: "real_words", additionalApproaches: [], territoryId: "nature", constructionKey: "whole_word",
    direction: "Synthetic brief-seeded route", targetCount: 10, sourceKeys: [], avoidPatterns: [], freshTerritory: true, runId: id(3), snapshotHash: brief.snapshotHash,
    assignmentOrder: 0, round: "initial", sources: [], assignmentBasis: { kind: "brief_seed", snapshotHash: brief.snapshotHash } });
  return { text: buildNamingResponsesRoleBody({ runId: id(3), dispatchKey: "creator.0", input: { role: "creator", snapshot: brief, assignment } }),
    research: buildNamingResponsesRoleBody({ runId: id(3), dispatchKey: "research", input: { role: "researcher", snapshot: brief } }) };
}

describe("Responses exact maximum and immutable new requests", () => {
  it("reserves the full model context at long-context rates and caps all generated tokens without cache discounts", () => {
    const { text } = bodies(), quote = quoteNamingResponses(text, now);
    expect(text).toMatchObject({ model: "gpt-6-luna", reasoning: { effort: "xhigh", mode: "standard" }, service_tier: "default", max_output_tokens: 32_768,
      prompt_cache_options: { mode: "explicit", ttl: "30m" }, tools: [], background: true, stream: true, store: true, truncation: "disabled" });
    expect(quote).toMatchObject({ maximumInputTokens: 1_050_000, maximumOutputTokens: 32_768, maximumToolCalls: 0, maximumCostNanoUsd: 234_576_000 });
    expect(21 * quote.maximumCostNanoUsd).toBeLessThanOrEqual(NAMING_RESPONSES_MAXIMUM_NANO_USD);
    expect(22 * quote.maximumCostNanoUsd).toBeGreaterThan(NAMING_RESPONSES_MAXIMUM_NANO_USD);
    expect(maximumNamingResponsesCost(1, 1, 1)).toBe(10_000_950);
    expect(maximumNamingResponsesCost(1_050_000, 32_768, 4)).toBe(274_576_000);
  });

  it("refuses unproved required hosted research rather than substituting a guessed token multiplier", () => {
    const { research } = bodies();
    expect(research.max_tool_calls).toBe(4); expect(research.tools.map(tool => tool.type)).toEqual(["web_search", "function"]);
    expect(() => quoteNamingResponses(research, now)).toThrow("responses_research_input_unqualified");
    expect(() => createNamingResponsesRequest({ runId: id(3), dispatchKey: "research", body: research, now })).toThrow("responses_research_input_unqualified");
    expect(namingResponsesProductionReadiness()).toEqual({ available: false, code: "responses_research_input_unqualified", targetCount: 100, model: "gpt-6-luna", reasoningEffort: "xhigh" });
  });

  it.each(["2026-10-23T23:59:59Z", "2026-10-25T00:00:00Z", "invalid"])("fails closed outside the reviewed rate interval: %s", date => {
    expect(() => quoteNamingResponses(bodies().text, Date.parse(date))).toThrow("responses_rate_qualification_expired");
  });

  it("uses exact integer nanodollars, rejecting fractional, negative or unsafe arithmetic", () => {
    for (const quantity of [0.1, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => maximumNamingResponsesCost(quantity, 1, 0)).toThrow("responses_quantity_invalid");
    expect(() => maximumNamingResponsesCost(Number.MAX_SAFE_INTEGER, 32_768, 0)).toThrow("responses_cost_overflow");
  });

  it("binds the complete frozen wire and source-card identities without accepting a legacy job", () => {
    const request = createNamingResponsesRequest({ runId: id(3), dispatchKey: "creator.0", body: bodies().text, now });
    expect(request.quote.rateCardId).toBe(NAMING_RESPONSES_RATE_CARD.id); expect(Object.isFrozen(request.body.text.format.schema)).toBe(true);
    expect(validateNamingResponsesRequest(request)).toEqual(request);
    expect(() => validateNamingResponsesRequest({ ...request, body: { ...request.body, input: "Changed pending content" } })).toThrow("responses_request_hash_mismatch");
    expect(namingResponsesJobInputSchema.safeParse({ version: 2, handlerVersion: "naming-brain-v1", runId: id(3) }).success).toBe(false);
    expect(namingResponsesJobInputSchema.parse({ version: 3, handlerVersion: "naming-responses-v1", protocol: "openai_responses", runId: id(3), model: "gpt-6-luna", reasoningEffort: "xhigh", targetCount: 100 }).targetCount).toBe(100);
  });

  it.each([{ service_tier: "priority" }, { reasoning: { effort: "high", mode: "standard" } }, { previous_response_id: "resp_unreserved" }, { conversation: "conv_hidden" },
    { prompt_cache_options: { mode: "implicit", ttl: "30m" } }, { truncation: "auto" }, { context_management: [{ type: "compaction" }] }, { input: [{ type: "input_image", image_url: "https://example.invalid/private" }] }])("rejects an unqualified wire change: %j", patch => {
    expect(namingResponsesWireSchema.safeParse({ ...bodies().text, ...patch }).success).toBe(false);
  });

  it("rejects hidden cache breakpoints and cap/hosted-tool mismatches", () => {
    const { text, research } = bodies();
    expect(namingResponsesWireSchema.safeParse({ ...text, text: { ...text.text, format: { ...text.text.format, schema: { prompt_cache_breakpoint: true } } } }).success).toBe(false);
    expect(namingResponsesWireSchema.safeParse({ ...text, max_tool_calls: 4 }).success).toBe(false);
    expect(namingResponsesWireSchema.safeParse({ ...research, max_tool_calls: undefined }).success).toBe(false);
  });
});
