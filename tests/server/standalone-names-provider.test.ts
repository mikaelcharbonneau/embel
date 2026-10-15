import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createStandaloneNamesRequest, runStandaloneNames } from "../../src/server/ai/standalone-names";
import type { ChatGPTTransport } from "../../src/server/ai/chatgpt-transport";
import { policy, proposal, workerFixture } from "../fixtures/standalone-names";
function fixture(names: unknown[] = [proposal], override: Record<string, unknown> = {}) {
  const text = JSON.stringify({ candidates: names });
  const response = { id: "fixture-response", model: policy.model, status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }], ...override };
  const transport: ChatGPTTransport = { listModels: vi.fn(), streamResponse: vi.fn(async (_request, options) => { await options.beforeDispatch?.(); await options.onTextDelta?.(text); return { status: "completed" as const, accountId: policy.registrationId, responseId: "fixture-response", requestId: null, response, partialText: text }; }) };
  const beforeDispatch = vi.fn(async () => {}), onPartial = vi.fn(async () => {});
  const input = workerFixture();
  return { input, transport, beforeDispatch, onPartial, run: () => runStandaloneNames({ input, transport, beforeDispatch, onPartial, signal: new AbortController().signal }) };
}
describe("standalone naming ChatGPT adapter (synthetic transport)", () => {
  it("uses the explicit model, no tools and only brief/refinement data", () => {
    const request = createStandaloneNamesRequest(workerFixture());
    expect(request).toMatchObject({ model: policy.model, tools: [], tool_choice: "none" });
    expect(request.input[0]?.content).not.toContain("ownerId"); expect(request.input[0]?.content).not.toContain("projectId");
    expect(JSON.stringify(request.text)).toContain('"maxItems":20');
  });
  it("publishes authenticated model output with honest duplicate rejection and partial persistence", async () => {
    const f = fixture([proposal, { ...proposal, value: "FIXTURE-CLAY" }]); const result = await f.run();
    expect(result).toMatchObject({ state: "succeeded", result: { candidates: [proposal], rejectedCount: 1, model: policy.model } });
    expect(f.beforeDispatch).toHaveBeenCalledOnce(); expect(f.onPartial).toHaveBeenCalledOnce(); expect(f.transport.streamResponse).toHaveBeenCalledOnce();
  });
  it.each([{ model: "changed-model" }, { id: "wrong-response" }, { output: [{ type: "web_search_call" }] }, { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 99 } }])("quarantines mismatched, tool or invalid usage output: %j", async patch => {
    expect(await fixture([proposal], patch).run()).toMatchObject({ state: "needs_reconciliation", result: null });
  });
  it("never calls the provider after cancellation", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    expect(await runStandaloneNames({ ...f, signal: controller.signal })).toMatchObject({ state: "cancelled" });
    expect(f.transport.streamResponse).not.toHaveBeenCalled();
  });
  it("does not retry a transport exception or publish incomplete streamed text", async () => {
    const f = fixture(); vi.mocked(f.transport.streamResponse).mockRejectedValue(new Error("Synthetic transport exception"));
    expect(await f.run()).toMatchObject({ state: "needs_reconciliation", result: null, errorCode: "provider_outcome_unknown" });
    expect(f.transport.streamResponse).toHaveBeenCalledOnce();
  });
});
