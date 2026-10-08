import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { contextSnapshotSchema } from "../../src/domain/projects";
import { chatGPTStrategyResultSchema, type StrategyOperation } from "../../src/domain/strategy-jobs";
import { createChatGPTStrategyRequest, runChatGPTStrategy } from "../../src/server/ai/chatgpt-strategy";
import type { ChatGPTStreamOutcome, ChatGPTTransport } from "../../src/server/ai/chatgpt-transport";

// All content and evidence below are synthetic test fixtures, never live output.
const context = contextSnapshotSchema.parse({ description: "Synthetic workshop", intake: { conversation: [
  { kind: "user_message", id: "fixture-event-1", text: "I teach beginners.", createdAt: "2026-10-03T12:00:00Z" },
  { kind: "widget", id: "fixture-widget-1", widget: "competitors" },
  { kind: "user_message", id: "fixture-event-2", text: "Classes happen in person.", createdAt: "2026-10-03T12:01:00Z" },
] } });
const model = "fixture-visible-model";
const accountId = "registration-fixture";
const reformulation = { message: "Synthetic reformulation", activity: "Workshop", offering: "Classes", knownAudience: "Beginners", questions: [] };
function response(proposal: unknown = reformulation) {
  return { id: "resp_fixture", status: "completed", model,
    usage: { input_tokens: 123, output_tokens: 456, total_tokens: 579 },
    output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(proposal), annotations: [] }] }] as Array<Record<string, unknown>> };
}
function fixture(body: unknown = response(), operation: StrategyOperation = "strategy.reformulate") {
  const transport: ChatGPTTransport = { listModels: vi.fn(), streamResponse: vi.fn(async () => ({ status: "completed" as const, response: body, partialText: "Synthetic partial", responseId: "resp_fixture", requestId: "req_fixture", accountId })) };
  const controller = new AbortController();
  return { transport, controller, run: () => runChatGPTStrategy({ operation, context, model, expectedAccountId: accountId, transport, signal: controller.signal, now: () => "2026-10-03T12:00:00.000Z" }) };
}
function researchedResponse() {
  const body = response({ message: "Synthetic researched alternatives", competitors: [{ name: "Fixture school", relevance: "Synthetic classes overlap", url: "https://example.com/", sourceUrls: ["https://example.com/classes"] }] });
  body.output.unshift({ type: "web_search_call", id: "ws_fixture", status: "completed", action: { type: "search", sources: [
    { url: "https://example.com/", title: "Synthetic home source" }, { url: "https://example.com/classes", title: "Synthetic classes source" },
  ] } });
  return body;
}

describe("ChatGPT subscription strategy results (mock transport only)", () => {
  it.each(["strategy.reformulate", "strategy.competitors", "strategy.audience", "strategy.personality", "strategy.positioning"] as const)("requests concise plain text for %s without Markdown presentation", operation => {
    const request = createChatGPTStrategyRequest(operation, context, model);
    expect(request.instructions).toContain("concise plain text with natural short paragraphs");
    expect(request.instructions).toContain("No Markdown headings, emphasis, or link markup");
    expect(request.instructions).toContain("put citations in structured sourceUrls");
    expect(request.instructions).toContain(`Current operation: ${operation}`);
    expect(request.instructions).toContain("Focus only on the current operation");
    expect(request.instructions).toContain("Earlier user requests provide context");
    expect(request.instructions).toContain("Avoid restating the full saved brief or competitor report");
    expect(request.instructions).toContain("only necessary questions");
    if (operation === "strategy.competitors") expect(request.instructions).toContain("focus on competitor candidates and specific relevance");
  });
  it("sends the entire explicit user conversation in order with preserved context", () => {
    const request = createChatGPTStrategyRequest("strategy.reformulate", context, model);
    expect(request.input.slice(1)).toEqual([{ role: "user", content: "I teach beginners." }, { role: "user", content: "Classes happen in person." }]);
    expect(request.input[0]?.content).toContain("Synthetic workshop");
    expect(request.input.some(item => (item.role as string) === "system")).toBe(false);
    for (const field of ["max_output_tokens", "max_tool_calls", "background", "previous_response_id", "truncation", "service_tier"]) expect(request).not.toHaveProperty(field);
  });

  it("includes frozen complete prior questions and options as untrusted proposals before the user's follow-up", () => {
    const assistantHistory = { entries: [{ jobId: "11111111-1111-4111-8111-111111111111", ownerId: "22222222-2222-4222-8222-222222222222", projectId: "33333333-3333-4333-8333-333333333333", stepKey: "respond", inputRevision: 1, completedAt: "2026-10-03T12:00:00Z", output: { version: 1, operation: "strategy.reformulate", provider: "openai", billingMode: "chatgpt_subscription", model, responseId: "resp_previous", requestId: null, generatedAt: "2026-10-03T12:00:00Z", usage: null, proposal: { ...reformulation, message: "Consider adults or corporate groups.", questions: ["Which of those two audiences do you prefer?"] } } }], truncated: true };
    const request = createChatGPTStrategyRequest("strategy.reformulate", context, model, assistantHistory);
    expect(request.input[1]?.content).toContain("Which of those two audiences do you prefer?");
    expect(request.input[1]?.content).toContain("Consider adults or corporate groups.");
    expect(request.input[1]?.content).toContain("resp_previous");
    expect(request.input.slice(2)).toEqual([{ role: "user", content: "I teach beginners." }, { role: "user", content: "Classes happen in person." }]);
    expect(request.instructions).toContain("Current saved selections remain authoritative");
    expect(request.instructions).toContain("ask a concise clarification");
    expect(JSON.stringify(request)).not.toContain(assistantHistory.entries[0]!.ownerId);
    expect(JSON.stringify(request)).not.toContain(assistantHistory.entries[0]!.projectId);
  });

  it("rejects invalid history before any provider dispatch", async () => {
    const f = fixture();
    const outcome = await runChatGPTStrategy({ operation: "strategy.reformulate", context, model, expectedAccountId: accountId, transport: f.transport, signal: f.controller.signal,
      assistantHistory: { entries: [{ partialText: "Synthetic incomplete output" }], truncated: false } as never });
    expect(outcome).toMatchObject({ status: "failed", code: "invalid_input", dispatched: false });
    expect(f.transport.streamResponse).not.toHaveBeenCalled();
  });

  it("publishes a completed validated proposal with exact subscription usage and no credential identity", async () => {
    const f = fixture(); const outcome = await f.run();
    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded") throw new Error("Synthetic fixture failed");
    expect(chatGPTStrategyResultSchema.parse(outcome.result)).toMatchObject({ provider: "openai", billingMode: "chatgpt_subscription", model,
      responseId: "resp_fixture", requestId: "req_fixture", proposal: reformulation,
      usage: { inputTokens: 123, outputTokens: 456, totalTokens: 579 } });
    expect(outcome.result).not.toHaveProperty("accountId");
    expect(outcome.result).not.toHaveProperty("costMicrousd");
    expect(JSON.stringify(outcome)).not.toContain(accountId);
  });

  it("uses null for absent usage instead of fabricating API cache counts or zero tokens", async () => {
    const result = await fixture({ ...response(), usage: undefined }).run();
    expect(result).toMatchObject({ status: "succeeded", result: { usage: null } });
  });

  it("rejects malformed token accounting, output and a substituted model", async () => {
    expect(await fixture({ ...response(), usage: { input_tokens: 5, output_tokens: 6, total_tokens: 99 } }).run()).toMatchObject({ status: "needs_reconciliation", code: "provider_usage_invalid" });
    expect(await fixture({ ...response(), model: "different-model" }).run()).toMatchObject({ status: "needs_reconciliation", code: "provider_model_mismatch" });
    expect(await fixture(response({ ...reformulation, userApproved: true })).run()).toMatchObject({ status: "needs_reconciliation", code: "provider_invalid_output" });
  });

  it("cannot publish an injected completion for another account or after cancellation", async () => {
    const f = fixture();
    vi.mocked(f.transport.streamResponse).mockResolvedValue({ status: "completed", response: response(), partialText: "", responseId: "resp_fixture", requestId: null, accountId: "another-registration" });
    expect(await f.run()).toMatchObject({ status: "needs_reconciliation", code: "account_changed" });
    const cancelled = fixture(); cancelled.controller.abort();
    expect(await cancelled.run()).toMatchObject({ status: "failed", code: "cancelled", dispatched: false });
    expect(cancelled.transport.streamResponse).not.toHaveBeenCalled();
  });

  it("recognizes refusal without applying or approving a proposal", async () => {
    const body = response(); body.output = [{ type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "Synthetic refusal" }] }];
    expect(await fixture(body).run()).toMatchObject({ status: "failed", code: "provider_refusal" });
  });

  it("keeps a quota failure and real partial text without retrying or substituting API billing", async () => {
    const f = fixture();
    vi.mocked(f.transport.streamResponse).mockResolvedValue({ status: "failed", partialText: "Real fixture partial", failure: {
      code: "subscription_sharing_usage_limit_exceeded", providerCode: "subscription_sharing_usage_limit_exceeded", providerParam: null,
      httpStatus: null, bodyShape: "error", requestId: "req_fixture", responseId: "resp_fixture", dispatched: true, recovery: "view_usage",
    } });
    expect(await f.run()).toMatchObject({ status: "failed", code: "subscription_sharing_usage_limit_exceeded", partialText: "Real fixture partial", recovery: "view_usage" });
    expect(f.transport.streamResponse).toHaveBeenCalledTimes(1);
  });

  it.each(["interrupted", "cancelled", "incomplete"] as const)("quarantines %s after dispatch and retains partials", async (status) => {
    const f = fixture();
    vi.mocked(f.transport.streamResponse).mockResolvedValue({ status, partialText: "Synthetic partial", failure: {
      code: "stream_fixture", providerCode: null, providerParam: null, httpStatus: null, bodyShape: "empty",
      requestId: "req_fixture", responseId: "resp_fixture", dispatched: true, recovery: "manual_review",
    } });
    expect(await f.run()).toMatchObject({ status: "needs_reconciliation", partialText: "Synthetic partial", dispatched: true });
    expect(f.transport.streamResponse).toHaveBeenCalledTimes(1);
  });

  it("passes an awaited partial callback through to the stream consumer", async () => {
    const f = fixture(); const onPartial = vi.fn(async () => {});
    await runChatGPTStrategy({ operation: "strategy.reformulate", context, model, expectedAccountId: accountId, transport: f.transport, signal: f.controller.signal, onPartial });
    expect(vi.mocked(f.transport.streamResponse).mock.calls[0]![1].onTextDelta).toBe(onPartial);
  });

  it("only creates researched competitors backed by actual consulted URLs", async () => {
    const f = fixture(researchedResponse(), "strategy.competitors");
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "succeeded", result: { proposal: { competitors: [{ name: "Fixture school", selected: false, origin: "research",
      sources: [{ url: "https://example.com/classes", title: "Synthetic classes source", retrievedAt: "2026-10-03T12:00:00.000Z" }] }] } } });
    expect(await f.run()).toEqual(outcome);
    expect(vi.mocked(f.transport.streamResponse).mock.calls[0]![0]).toMatchObject({ tools: [{ type: "web_search" }], tool_choice: "required", include: ["web_search_call.action.sources"] });
  });

  it("rejects fabricated sources, missing research and unsupported provider tools", async () => {
    const fabricated = researchedResponse(); fabricated.output[0] = { type: "web_search_call", id: "ws_fixture", status: "completed", action: { type: "search", sources: [{ url: "https://other.example/" }] } };
    expect(await fixture(fabricated, "strategy.competitors").run()).toMatchObject({ status: "needs_reconciliation", code: "provider_invalid_output" });
    const missing = researchedResponse(); missing.output.shift();
    expect(await fixture(missing, "strategy.competitors").run()).toMatchObject({ status: "failed", code: "provider_research_missing" });
    const unsupported = response(); unsupported.output.unshift({ type: "image_generation_call", result: "synthetic-image" });
    expect(await fixture(unsupported).run()).toMatchObject({ status: "needs_reconciliation", code: "provider_invalid_output" });
  });

  it("validates final tool and output limits when a provider omits incremental events", async () => {
    const tooMany = researchedResponse();
    tooMany.output.unshift({ type: "web_search_call", id: "ws_second", status: "completed", action: { type: "search" } });
    tooMany.output.unshift({ type: "web_search_call", id: "ws_third", status: "completed", action: { type: "search" } });
    expect(await fixture(tooMany, "strategy.competitors").run()).toMatchObject({ status: "needs_reconciliation", code: "observed_tool_limit_exceeded" });
    const f = fixture();
    expect(await runChatGPTStrategy({ operation: "strategy.reformulate", context, model, expectedAccountId: accountId, transport: f.transport,
      signal: f.controller.signal, limits: { maxOutputBytes: 10 } })).toMatchObject({ status: "needs_reconciliation", code: "output_limit_exceeded" });
  });

  it.each([
    ["strategy.audience", { message: "Synthetic audience proposal", segments: [{ label: "Beginners", needs: ["Guided classes"], reason: "Matches offer" }] }],
    ["strategy.personality", { message: "Synthetic personality proposal", personality: { sincerity: 75, excitement: 50, competence: 80, sophistication: 30, ruggedness: 10 } }],
    ["strategy.positioning", { message: "Synthetic positioning proposal", positioning: "Guided workshop classes for beginners." }],
  ] as const)("returns %s as a proposal with no approval or invented research", async (operation, proposal) => {
    const outcome = await fixture(response(proposal), operation).run();
    expect(outcome.status).toBe("succeeded");
    if (operation === "strategy.audience") expect(outcome).toMatchObject({ result: { proposal: { segments: [{ origin: "proposal", selected: false, sources: [] }] } } });
  });

  it("does not accept a forged nonterminal response behind a completed transport envelope", async () => {
    const body = { ...response(), status: "incomplete" };
    expect(await fixture(body).run()).toMatchObject({ status: "needs_reconciliation", code: "provider_invalid_output" });
  });

  it("preserves unavailable-before-dispatch status separately from ambiguous work", async () => {
    const f = fixture();
    const unavailable: ChatGPTStreamOutcome = { status: "unavailable", partialText: "", failure: { code: "plan_permission_required", providerCode: null,
      providerParam: null, httpStatus: null, bodyShape: "empty", responseId: null, requestId: null, dispatched: false, recovery: "enable_plan_usage" } };
    vi.mocked(f.transport.streamResponse).mockResolvedValue(unavailable);
    expect(await f.run()).toMatchObject({ status: "failed", dispatched: false, recovery: "enable_plan_usage" });
  });
});
