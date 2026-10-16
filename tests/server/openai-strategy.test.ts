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
function researchAtToolLimitFixture() {
  const response = researchFixture();
  response.output.splice(1, 0,
    { type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://example.com/" } },
    { type: "reasoning" },
    { type: "web_search_call", status: "searching", action: { type: "search", sources: [{ url: "https://unfinished.example/", title: "Synthetic unfinished source" }] } });
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
    expect(await execute(response, "strategy.competitors").run()).toMatchObject({ status: "failed", code: "provider_research_unusable" });
  });

  it("accepts only completed research evidence when a final search attempt follows the tool limit", async () => {
    const f = execute(researchAtToolLimitFixture(), "strategy.competitors");
    expect(await f.run()).toMatchObject({ status: "succeeded", costMicrousd: 20691, result: {
      usage: { webSearchCalls: 2 }, proposal: { competitors: [{ sources: [{ url: "https://example.com/", title: "Synthetic source fixture" }] }] },
    } });
    expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, []])("also handles a final attempt without returned sources (%j)", async sources => {
    const response = researchAtToolLimitFixture();
    response.output[3] = { type: "web_search_call", status: "searching", action: { type: "search", ...(sources ? { sources } : {}) } };
    expect(await execute(response, "strategy.competitors").run()).toMatchObject({ status: "succeeded", costMicrousd: 20691 });
  });

  it("settles bounded completed research as unusable when its answer depends on the unfinished search", async () => {
    const response = researchAtToolLimitFixture();
    response.output[0] = { type: "web_search_call", status: "completed", action: { type: "search", sources: [{ url: "https://other.example/" }] } };
    response.output[3] = { type: "web_search_call", status: "searching", action: { type: "search", sources: [{ url: "https://example.com/" }] } };
    const f = execute(response, "strategy.competitors");
    expect(await f.run()).toMatchObject({ status: "failed", code: "provider_research_unusable", costMicrousd: 20691, result: {
      partialText: expect.any(String), usage: { webSearchCalls: 2 },
      observedSources: [expect.objectContaining({ outputIndex: 0 }), expect.objectContaining({ outputIndex: 3 })],
      outputDiagnostics: { toolCalls: 3, completedToolCalls: 2, completedSearchCalls: 1, searchAttemptAtLimitIndex: 3, usageExceeded: false },
    } });
    expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
  });

  it.each(["source", "website"])("does not let answer citations validate an unfinished %s", async kind => {
    const response = researchAtToolLimitFixture();
    const proposal = { message: "Synthetic citation fixture", competitors: [{ name: "Synthetic candidate", relevance: "Synthetic overlap",
      url: kind === "website" ? "https://unfinished.example/" : "https://example.com/",
      sourceUrls: [kind === "source" ? "https://unfinished.example/" : "https://example.com/"],
    }] };
    response.output[4] = { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(proposal),
      annotations: [{ type: "url_citation", url: "https://unfinished.example/", title: "Synthetic citation" }],
    }] };
    const outcome = await execute(response, "strategy.competitors").run();
    expect(outcome).toMatchObject({ status: "failed", code: "provider_research_unusable", result: {
      observedSources: [expect.any(Object), expect.objectContaining({ outputIndex: 3 }), expect.objectContaining({ outputIndex: 4, kind: "url_citation" })],
    } });
    expect(outcome.result).not.toHaveProperty("proposal");
  });

  it.each(["below limit", "before limit", "another attempt", "prior malformed call", "no answer", "answer before attempt", "incomplete answer", "multiple answers"])("keeps %s outside the bounded exception", async variant => {
    const response = researchAtToolLimitFixture();
    if (variant === "below limit") response.output.splice(1, 1);
    if (variant === "before limit") [response.output[1], response.output[3]] = [response.output[3]!, response.output[1]!];
    if (variant === "another attempt") response.output.splice(3, 0, response.output[3]!);
    if (variant === "prior malformed call") response.output[1] = { type: "web_search_call", status: "completed" };
    if (variant === "no answer") response.output.pop();
    if (variant === "answer before attempt") [response.output[3], response.output[4]] = [response.output[4]!, response.output[3]!];
    if (variant === "incomplete answer") response.output[4]!.status = "incomplete";
    if (variant === "multiple answers") response.output.push(response.output[4]!);
    const f = execute(response, "strategy.competitors");
    expect(await f.run()).toMatchObject({ status: "needs_reconciliation", code: "provider_unexpected_output" });
    expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
  });

  it.each(["in_progress", "incomplete", "failed", "cancelled", "queued", "unknown"])("never treats an extra %s search as the bounded searching attempt", async status => {
    const response = researchAtToolLimitFixture(); response.output[3]!.status = status;
    expect(await execute(response, "strategy.competitors").run()).toMatchObject({ status: "needs_reconciliation", code: "provider_unexpected_output", result: {
      outputDiagnostics: { toolCalls: 3, searchAttemptAtLimitIndex: null, issues: [{ outputIndex: 3, code: "web_search_not_completed" }] },
    } });
  });

  it.each(["open_page", "find_in_page", "unknown"])("never exempts an unfinished %s action", async type => {
    const response = researchAtToolLimitFixture(); response.output[3] = { type: "web_search_call", status: "searching", action: { type } };
    expect(await execute(response, "strategy.competitors").run()).toMatchObject({ status: "needs_reconciliation", code: "provider_unexpected_output" });
  });

  it.each(["failed", "incomplete", "cancelled", "in_progress"])("does not settle a %s envelope with a search attempt at the limit", async status => {
    const response = researchAtToolLimitFixture(); response.status = status;
    expect(await execute(response, "strategy.competitors").run()).toMatchObject({ status: "needs_reconciliation", result: {
      outputDiagnostics: { searchAttemptAtLimitIndex: null },
    } });
  });

  it.each(["search fees", "input tokens", "output tokens"])("keeps %s bounded even with a trailing search attempt", async limit => {
    const response = researchAtToolLimitFixture();
    if (limit === "search fees") response.output[1] = { type: "web_search_call", status: "completed", action: { type: "search" } };
    if (limit === "input tokens") response.usage.input_tokens = inputFixture("strategy.competitors").policy.maxInputTokens + 1;
    if (limit === "output tokens") response.usage.output_tokens = inputFixture("strategy.competitors").policy.maxOutputTokens + 1;
    response.usage.total_tokens = response.usage.input_tokens + response.usage.output_tokens;
    expect(await execute(response, "strategy.competitors").run()).toMatchObject({ status: "needs_reconciliation", code: "provider_usage_exceeded" });
  });

  it.each(["input tokens", "output tokens", "search fees", "policy cost", "reservation"])("does not terminally settle unusable research beyond its %s bound", async limit => {
    const response = researchAtToolLimitFixture();
    response.output[0] = { type: "web_search_call", status: "completed", action: { type: "search", sources: [{ url: "https://other.example/" }] } };
    const input = inputFixture("strategy.competitors"), job = jobFixture("strategy.competitors");
    if (limit === "input tokens") response.usage.input_tokens = input.policy.maxInputTokens + 1;
    if (limit === "output tokens") response.usage.output_tokens = input.policy.maxOutputTokens + 1;
    if (limit === "search fees") response.output[1] = { type: "web_search_call", status: "completed", action: { type: "search" } };
    if (limit === "policy cost") input.policy.maximumCostMicrousd = 1;
    if (limit === "reservation") job.actualCostMicrousd = job.reservedCostMicrousd - 1;
    response.usage.total_tokens = response.usage.input_tokens + response.usage.output_tokens;
    const outcome = await executeStrategyResponse({ job, input, operation: "strategy.competitors", transport: transportFixture(response), signal: new AbortController().signal, now });
    expect(outcome).toMatchObject({ status: "needs_reconciliation", result: { partialText: expect.any(String) } });
  });

  it.each(["model", "service_tier", "usage", "JSON", "sources"])("preserves the %s fence around a search attempt at the limit", async field => {
    const response = researchAtToolLimitFixture();
    if (field === "model" || field === "service_tier") response[field] = "unexpected";
    if (field === "usage") response.usage.total_tokens = 1;
    if (field === "JSON") response.output[4] = { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "not JSON" }] };
    if (field === "sources") response.output[3] = { type: "web_search_call", status: "searching", action: { type: "search", sources: null } };
    expect(await execute(response, "strategy.competitors").run()).toMatchObject({ status: "needs_reconciliation" });
  });

  it("requires actual search execution and refuses unsupported tool calls", async () => {
    const response = researchFixture(); response.output.shift();
    expect(await execute(response, "strategy.competitors").run()).toMatchObject({ status: "failed", code: "provider_research_missing" });
    response.output.unshift({ type: "code_interpreter_call" });
    expect(await execute(response).run()).toMatchObject({ status: "needs_reconciliation", code: "provider_unexpected_output" });
  });

  it.each(["open_page", "find_in_page"])("accepts the documented %s action within the unchanged total tool limit", async (type) => {
    const response = researchFixture();
    response.output.unshift({ type: "web_search_call", status: "completed", action: { type, url: "https://example.com/", pattern: "classes" } });
    expect(await execute(response, "strategy.competitors").run()).toMatchObject({ status: "succeeded", costMicrousd: 10691, result: { usage: { webSearchCalls: 1 } } });
    response.output.unshift({ type: "web_search_call", status: "completed", action: { type: "search", sources: [] } });
    expect(await execute(response, "strategy.competitors").run()).toMatchObject({ status: "needs_reconciliation", code: "provider_usage_exceeded", costMicrousd: 20691 });
  });

  it.each([
    ["missing web action", { type: "web_search_call", status: "completed" }, "invalid_web_search_item", { type: "web_search_call", status: "completed", actionType: "missing" }],
    ["unknown web action", { type: "web_search_call", status: "completed", action: { type: "find" } }, "invalid_web_search_item", { type: "web_search_call", status: "completed", actionType: "unknown" }],
    ["malformed web sources", { type: "web_search_call", status: "completed", action: { type: "search", sources: null } }, "invalid_web_search_item", { type: "web_search_call", status: "completed", actionType: "search" }],
    ["failed web tool", { type: "web_search_call", status: "failed", action: { type: "search" } }, "web_search_not_completed", { type: "web_search_call", status: "failed", actionType: "search" }],
    ["malformed message", { type: "message", status: "completed", role: "user", content: [] }, "invalid_message_item", { type: "message", status: "completed" }],
    ["incomplete message", { type: "message", status: "incomplete", role: "assistant", content: [] }, "message_not_completed", { type: "message", status: "incomplete" }],
    ["unsupported output", { type: "code_interpreter_call", status: "completed" }, "unsupported_output_item", { type: "unsupported", status: "completed" }],
    ["invalid text", { type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: 12 }] }, "invalid_message_content", { type: "message", status: "completed" }],
    ["unknown content", { type: "message", status: "completed", role: "assistant", content: [{ type: "unsupported_content" }] }, "invalid_message_content", { type: "message", status: "completed" }],
  ] as const)("retains a fixed diagnostic for %s without accepting the response", async (_label, item, code, summary) => {
    const response = researchFixture(); response.output.unshift(item);
    const f = execute(response, "strategy.competitors");
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "needs_reconciliation", code: "provider_unexpected_output", result: {
      responseId: response.id, partialText: expect.any(String),
      observedSources: [{ url: "https://example.com/", title: "Synthetic source fixture", outputIndex: 1, kind: "web_search_source" }],
      observedSourcesTruncated: false,
      outputDiagnostics: {
        version: 1, responseStatus: "completed", outputItemCount: 3, observedSourceCount: 1, issueCount: 1, issuesTruncated: false,
        items: [expect.objectContaining({ outputIndex: 0, ...summary }), expect.any(Object), expect.any(Object)],
        issues: [expect.objectContaining({ outputIndex: 0, code })],
      },
    } });
    expect(f.transport.createResponse).toHaveBeenCalledTimes(1);
  });

  it("retains total tool usage even when an unexpected item takes precedence over the limit failure", async () => {
    const response = researchFixture();
    response.output.unshift({ type: "web_search_call", status: "completed", action: { type: "search" } }, { type: "web_search_call", status: "completed" });
    expect(await execute(response, "strategy.competitors").run()).toMatchObject({ status: "needs_reconciliation", code: "provider_unexpected_output", costMicrousd: 20691, result: {
      usage: { webSearchCalls: 2 }, outputDiagnostics: { toolCalls: 3, usageExceeded: true },
    } });
  });

  it("stores only allowlisted diagnostic labels and validated source fields", async () => {
    const response = researchFixture();
    response.output.unshift({ type: "private-type", status: "private-status", secret: "private-error" },
      { type: "web_search_call", status: "private-status", action: { type: "private-action", query: "private-query" } },
      { type: "reasoning", summary: [{ text: "private-reasoning" }] },
      { type: "message", status: "completed", role: "assistant", content: [{ type: "private-content", text: "private-text" }] });
    response.output[4] = { type: "web_search_call", status: "completed", action: { type: "search", sources: [
      { url: "https://example.com/", title: "Synthetic source fixture", snippet: "private-snippet" },
      { url: "https://login:password@example.com/", title: "Rejected credentials" }, { url: "javascript:alert(1)", title: "Rejected scheme" },
    ] } };
    const outcome = await execute(response, "strategy.competitors").run();
    if (outcome.status !== "needs_reconciliation" || !outcome.result) throw new Error("Expected retained private evidence");
    const retained = JSON.stringify(outcome.result);
    expect(retained).not.toContain("private-");
    expect(retained).not.toContain("password");
    expect(retained).not.toContain("javascript:");
    expect(outcome).toMatchObject({ result: {
      observedSources: [{ url: "https://example.com/", title: "Synthetic source fixture" }],
      outputDiagnostics: { issues: [
        { outputIndex: 0, code: "unsupported_output_item" },
        { outputIndex: 1, code: "invalid_web_search_item" },
        { outputIndex: 3, contentIndex: 0, contentType: "unknown", code: "invalid_message_content" },
      ] },
    } });
  });

  it("bounds private source evidence and issue details with explicit truncation", async () => {
    const response = researchFixture();
    response.output.unshift(...Array.from({ length: 60 }, () => ({ type: "unsupported" })));
    response.output[60] = { type: "web_search_call", status: "completed", action: { type: "search", sources: Array.from({ length: 230 }, (_, index) => ({ url: `https://example.com/${index}`, title: `Synthetic source ${index}` })) } };
    const outcome = await execute(response, "strategy.competitors").run();
    expect(outcome).toMatchObject({ status: "needs_reconciliation", result: {
      observedSourcesTruncated: true,
      outputDiagnostics: { outputItemCount: 62, observedSourceCount: 230, issueCount: 60, issuesTruncated: true },
    } });
    const retained = outcome.result as { observedSources: unknown[]; outputDiagnostics: { issues: unknown[] } };
    expect(retained.observedSources).toHaveLength(220);
    expect(retained.outputDiagnostics.issues).toHaveLength(50);
  });

  it("bounds serialized source evidence even when canonical URLs expand", async () => {
    const response = researchFixture();
    response.output.unshift({ type: "unsupported" });
    response.output[1] = { type: "web_search_call", status: "completed", action: { type: "search", sources: Array.from({ length: 220 }, (_, index) => ({ url: `https://example.com/${index}/${"é".repeat(1000)}`, title: "Synthetic long source" })) } };
    const outcome = await execute(response, "strategy.competitors").run();
    expect(outcome).toMatchObject({ status: "needs_reconciliation", result: { observedSourcesTruncated: true, outputDiagnostics: { observedSourceCount: 220 } } });
    const retained = outcome.result as { observedSources: unknown[] };
    expect(retained.observedSources.length).toBeGreaterThan(0);
    expect(retained.observedSources.length).toBeLessThan(220);
    expect(Buffer.byteLength(JSON.stringify(retained.observedSources), "utf8")).toBeLessThanOrEqual(128 * 1024);
  });

  it("binds retained citations to their message and content indexes", async () => {
    const response = researchFixture();
    response.output.push({ type: "message", status: "completed", role: "assistant", content: [
      { type: "output_text", text: "", annotations: [{ type: "url_citation", url: "https://citation.example/", title: "Synthetic citation" }] },
      { type: "unsupported_content" },
    ] });
    expect(await execute(response, "strategy.competitors").run()).toMatchObject({ status: "needs_reconciliation", result: {
      observedSources: [expect.objectContaining({ kind: "web_search_source", outputIndex: 0 }), { kind: "url_citation", outputIndex: 2, contentIndex: 0, url: "https://citation.example/", title: "Synthetic citation" }],
    } });
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
