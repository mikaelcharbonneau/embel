import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { executeStrategyResponse, createStrategyRequest, calculateStrategyCost } from "../../src/server/ai/strategy-response";
import { readOpenAIStrategyConfiguration, strategyPolicy } from "../../src/server/ai/config";
import { OpenAITransportError } from "../../src/server/ai/openai-transport";
import { strategyJobResultSchema, type StrategyOperation } from "../../src/domain/strategy-jobs";
import { inputFixture, jobFixture, reformulationFixture, responseFixture, transportFixture } from "./openai-fixtures";

const now = () => "2026-10-03T12:00:00.000Z";
function execute(body: unknown = responseFixture(), operation: StrategyOperation = "strategy.reformulate") {
  const transport = transportFixture(body);
  return { transport, run: () => executeStrategyResponse({ job: jobFixture(operation), operation, input: inputFixture(operation), transport, signal: new AbortController().signal, now }) };
}
function researchFixture() {
  const response = responseFixture({ message: "Synthetic research fixture", competitors: [{ name: "Fixture workshop", relevance: "Synthetic classes overlap", url: "https://example.com/", sourceUrls: ["https://example.com/"] }] });
  response.output.unshift({ type: "web_search_call", status: "completed", action: { type: "search", sources: [{ type: "url", url: "https://example.com/", title: "Synthetic source fixture" }] } });
  return response;
}

describe("OpenAI strategy adapter (mock transport only)", () => {
  it("keeps configuration disabled until permission, credential, model choice and access are explicit", () => {
    const env = { OPENAI_API_KEY: "synthetic-test-credential", FLUID_PAID_CALLS_APPROVED: "true", FLUID_OPENAI_VERIFIED_MODELS: "gpt-6.1-sol", FLUID_TEXT_MODEL_STRATEGY: "gpt-6.1-sol" };
    expect(readOpenAIStrategyConfiguration(env)?.policies.size).toBe(5);
    for (const key of Object.keys(env)) expect(readOpenAIStrategyConfiguration({ ...env, [key]: "" })).toBeNull();
    expect(readOpenAIStrategyConfiguration({ ...env, FLUID_TEXT_MODEL_STRATEGY: "gpt-6-astra" })).toBeNull();
  });

  it("counts the complete same input/schema before dispatch, fixes bounds and publishes real response provenance", async () => {
    const f = execute(); const outcome = await f.run();
    expect(outcome.status).toBe("succeeded");
    expect(outcome.costMicrousd).toBe(691);
    if (outcome.status !== "succeeded") throw new Error("fixture failed");
    const result = strategyJobResultSchema.parse(outcome.result);
    expect(result).toMatchObject({ operation: "strategy.reformulate", model: "gpt-6.1-sol", provider: "openai", responseId: "resp_synthetic_fixture", requestId: "req_synthetic_fixture", generatedAt: now(), proposal: reformulationFixture });
    const countRequest = vi.mocked(f.transport.countInputTokens).mock.calls[0]![0];
    const request = vi.mocked(f.transport.createResponse).mock.calls[0]![0];
    expect(request).toMatchObject({ ...countRequest, store: false, stream: false, background: false, service_tier: "default", max_output_tokens: 4096 });
    expect(vi.mocked(f.transport.countInputTokens).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.transport.createResponse).mock.invocationCallOrder[0]!);
    expect(request).not.toHaveProperty("previous_response_id");
  });

  it("does not generate after oversized input or a token counting failure", async () => {
    for (const count of [32769, NaN, -1]) {
      const f = execute(); vi.mocked(f.transport.countInputTokens).mockResolvedValue(count);
      expect(await f.run()).toMatchObject({ status: "failed", code: "input_token_limit", costMicrousd: 0 });
      expect(f.transport.createResponse).not.toHaveBeenCalled();
    }
    const f = execute(); vi.mocked(f.transport.countInputTokens).mockRejectedValue(new Error("private error"));
    expect(await f.run()).toMatchObject({ status: "failed", code: "input_token_count_unavailable" });
    expect(f.transport.createResponse).not.toHaveBeenCalled();
  });

  it("checks cancellation again between token count and billable dispatch", async () => {
    const transport = transportFixture(); const controller = new AbortController();
    vi.mocked(transport.countInputTokens).mockImplementation(async () => { controller.abort(); return 100; });
    expect(await executeStrategyResponse({ job: jobFixture(), input: inputFixture(), operation: "strategy.reformulate", transport, signal: controller.signal })).toMatchObject({ status: "failed", code: "not_dispatched" });
    expect(transport.createResponse).not.toHaveBeenCalled();
  });

  it("retains reservations after ambiguous dispatch and never retries automatically", async () => {
    const f = execute(); vi.mocked(f.transport.createResponse).mockRejectedValue(new OpenAITransportError("outcome_unknown", "req_fixture"));
    expect(await f.run()).toEqual({ status: "needs_reconciliation", code: "provider_outcome_unknown", costMicrousd: 0, providerRequestId: "req_fixture" });
    expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
  });

  it("records a confirmed provider rejection without claiming a result", async () => {
    const f = execute(); vi.mocked(f.transport.createResponse).mockRejectedValue(new OpenAITransportError("request_rejected", "req_fixture"));
    expect(await f.run()).toMatchObject({ status: "failed", code: "provider_request_rejected", costMicrousd: 0 });
  });

  it("records refusal cost without accepting refusal as a proposal", async () => {
    const response = responseFixture(); response.output = [{ type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "Synthetic refusal" }] }];
    expect(await execute(response).run()).toMatchObject({ status: "failed", code: "provider_refusal", costMicrousd: 691 });
  });

  it.each(["incomplete", "failed", "cancelled", "in_progress"])("retains partial output and known cost for %s", async (status) => {
    const response = responseFixture(); response.status = status;
    const outcome = await execute(response).run();
    expect(outcome).toMatchObject({ status: "needs_reconciliation", costMicrousd: 691, result: { responseId: "resp_synthetic_fixture", partialText: JSON.stringify(reformulationFixture) } });
  });

  it.each(["model", "service_tier"])("quarantines unexpected %s", async (key) => {
    const response = { ...responseFixture(), [key]: "different" };
    expect(await execute(response).run()).toMatchObject({ status: "needs_reconciliation", code: "provider_configuration_mismatch" });
  });

  it("requires separate cache-write accounting and coherent token totals", async () => {
    for (const usage of [null, { ...responseFixture().usage, total_tokens: 9 }, { ...responseFixture().usage, input_tokens_details: { cached_tokens: 0 } }]) {
      expect(await execute({ ...responseFixture(), usage }).run()).toMatchObject({ status: "needs_reconciliation", code: "provider_usage_missing" });
    }
  });

  it("does not drop a valid result when usage exceeds its limits", async () => {
    const response = responseFixture(); response.usage.output_tokens = 5000; response.usage.total_tokens = 5100;
    expect(await execute(response).run()).toMatchObject({ status: "needs_reconciliation", code: "provider_usage_exceeded", result: { operation: "strategy.reformulate", proposal: reformulationFixture } });
  });

  it("requires strict structured output and retains malformed output privately", async () => {
    const response = responseFixture({ ...reformulationFixture, approved: true });
    expect(await execute(response).run()).toMatchObject({ status: "needs_reconciliation", code: "provider_invalid_output", costMicrousd: 691 });
  });

  it("publishes researched competitors only with observed search URLs and server provenance", async () => {
    const f = execute(researchFixture(), "strategy.competitors");
    const outcome = await f.run();
    expect(outcome.status).toBe("succeeded");
    expect(outcome.costMicrousd).toBe(10691);
    if (outcome.status !== "succeeded") throw new Error("fixture failed");
    const result = strategyJobResultSchema.parse(outcome.result);
    expect(result).toMatchObject({ proposal: { competitors: [{ name: "Fixture workshop", origin: "research", selected: false, sources: [{ url: "https://example.com/", title: "Synthetic source fixture", retrievedAt: now() }] }] } });
    expect(vi.mocked(f.transport.createResponse).mock.calls[0]![0]).toMatchObject({ max_tool_calls: 2, tool_choice: "required", include: ["web_search_call.action.sources"] });
    const again = await f.run(); expect(again).toEqual(outcome);
  });

  it("rejects fabricated source URLs even when the provider claims them in JSON", async () => {
    const response = researchFixture();
    response.output[0] = { type: "web_search_call", status: "completed", action: { type: "search", sources: [{ type: "url", url: "https://other.example/" }] } };
    expect(await execute(response, "strategy.competitors").run()).toMatchObject({ status: "needs_reconciliation", code: "provider_invalid_output" });
  });

  it("requires actual search execution and refuses unsupported tool calls", async () => {
    const response = researchFixture(); response.output.shift();
    expect(await execute(response, "strategy.competitors").run()).toMatchObject({ status: "failed", code: "provider_research_missing" });
    response.output.unshift({ type: "code_interpreter_call" });
    expect(await execute(response).run()).toMatchObject({ status: "needs_reconciliation", code: "provider_unexpected_output" });
  });

  it.each([
    ["strategy.audience", { message: "Synthetic audience fixture", segments: [{ label: "Workshop beginners", needs: ["Guided practice"], reason: "Matches the class offer" }] }],
    ["strategy.personality", { message: "Synthetic personality fixture", personality: { sincerity: 75, excitement: 40, competence: 80, sophistication: 20, ruggedness: 10 } }],
    ["strategy.positioning", { message: "Synthetic positioning fixture", positioning: "Guided practical classes for beginners." }],
  ] as const)("validates %s as an unapproved proposal", async (operation, proposal) => {
    const outcome = await execute(responseFixture(proposal), operation).run();
    expect(outcome.status).toBe("succeeded");
    expect(createStrategyRequest(operation, inputFixture(operation))).toMatchObject({ tools: [], tool_choice: "none" });
    if (operation === "strategy.audience" && outcome.status === "succeeded") expect(outcome.result).toMatchObject({ proposal: { segments: [{ selected: false, origin: "proposal", sources: [] }] } });
  });

  it("uses exact integer microdollar arithmetic including long-context cache writes", () => {
    const usage = { input_tokens: 300000, output_tokens: 1000, total_tokens: 301000, input_tokens_details: { cached_tokens: 10000, cache_write_tokens: 20000 } };
    expect(calculateStrategyCost(usage, 2, inputFixture("strategy.competitors"))).toBe(1_217_000);
    expect(strategyPolicy("strategy.competitors").maximumCostMicrousd).toBe(3_142_880);
  });
});
