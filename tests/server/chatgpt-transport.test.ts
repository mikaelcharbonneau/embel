import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createChatGPTTransport, type ChatGPTSession, type ChatGPTResponseRequest } from "../../src/server/ai/chatgpt-transport";
import { runChatGPTStrategy } from "../../src/server/ai/chatgpt-strategy";
import { contextSnapshotSchema } from "../../src/domain/projects";

const account: ChatGPTSession = { accountId: "registration-fixture-a", accessToken: "oauth.synthetic.fixture", expiresAt: 2_000_000,
  scopes: ["openid", "chatgpt.tokens.use.direct"] };
const request: ChatGPTResponseRequest = { model: "fixture-visible-model", instructions: "Synthetic test instruction",
  input: [{ role: "user", content: "Synthetic user context" }] };
const completed = { type: "response.completed", response: { id: "resp_fixture", status: "completed", model: request.model, output: [] } };
const delta = { type: "response.output_text.delta", delta: "Synthetic partial" };
const proposal = { message: "Synthetic strategy response", activity: "Workshop", offering: "Evening classes", knownAudience: "Adult beginners", questions: [] };
const reasoningItem = { id: "rs_fixture", type: "reasoning", content: [], summary: [] };
const messageItem = { id: "msg_fixture", type: "message", status: "completed", role: "assistant", phase: "final_answer",
  content: [{ type: "output_text", text: JSON.stringify(proposal), annotations: [], logprobs: [] }] };
const doneItem = (output_index: number, item: unknown) => ({ type: "response.output_item.done", output_index, item });
function event(value: unknown) { return `data: ${JSON.stringify(value)}\n\n`; }
function catalog(models = [{ slug: request.model, display_name: "Visible fixture", visibility: "list" }]) { return new Response(JSON.stringify({ models })); }
function stream(text: string, chunkBytes = 7, contentType: string | null = "text/event-stream; charset=utf-8") {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += chunkBytes) controller.enqueue(bytes.slice(i, i + chunkBytes));
    controller.close();
  } }), { headers: { ...(contentType === null ? {} : { "content-type": contentType }), "x-request-id": "req_fixture" } });
}
function fixture(events = event(delta) + event(completed)) {
  const getSession = vi.fn(async () => ({ ...account }));
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(catalog()).mockResolvedValueOnce(stream(events));
  const transport = createChatGPTTransport({ getSession, fetch: fetcher, now: () => 1_000_000 });
  const controller = new AbortController();
  const run = (extra = {}) => transport.streamResponse(request, { expectedAccountId: account.accountId, signal: controller.signal, ...extra });
  return { transport, getSession, fetcher, controller, run };
}

describe("ChatGPT subscription transport (mock sessions and fetch only)", () => {
  it("uses the same completed-model supplement for discovery and inference of a catalog omission", async () => {
    const getVerifiedModels = vi.fn(async () => [{ slug: request.model, displayName: "Verified fixture" }]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(catalog([])).mockResolvedValueOnce(catalog([])).mockResolvedValueOnce(stream(event(completed)));
    const transport = createChatGPTTransport({ getSession: async () => account, fetch: fetcher, now: () => 1_000_000, getVerifiedModels });
    expect(await transport.listModels(new AbortController().signal)).toEqual({ accountId: account.accountId, models: [{ slug: request.model, displayName: "Verified fixture" }] });
    expect(await transport.streamResponse(request, { expectedAccountId: account.accountId, signal: new AbortController().signal })).toMatchObject({ status: "completed" });
    expect(getVerifiedModels.mock.calls).toEqual([[account.accountId], [account.accountId]]);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["https://api.openai.com/v1/models", "https://api.openai.com/v1/models", "https://api.openai.com/v1/responses"]);
  });

  it("gives explicit provider names and hidden entries precedence over recorded evidence", async () => {
    const getVerifiedModels = async () => [{ slug: "visible", displayName: "Old label" }, { slug: request.model, displayName: "Previously verified" }];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => catalog([
      { slug: "visible", display_name: "Current provider label", visibility: "list" },
      { slug: request.model, display_name: "Now hidden", visibility: "hide" },
    ]));
    const transport = createChatGPTTransport({ getSession: async () => account, fetch: fetcher, now: () => 1_000_000, getVerifiedModels });
    expect((await transport.listModels(new AbortController().signal)).models).toEqual([{ slug: "visible", displayName: "Current provider label" }]);
    expect(await transport.streamResponse(request, { expectedAccountId: account.accountId, signal: new AbortController().signal })).toMatchObject({ failure: { code: "model_unavailable", dispatched: false } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 503])("does not use completed evidence to bypass a current catalog authorization failure (%s)", async status => {
    const getVerifiedModels = vi.fn(async () => [{ slug: request.model, displayName: "Verified fixture" }]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: "provider_denied" } }), { status }));
    const transport = createChatGPTTransport({ getSession: async () => account, fetch: fetcher, now: () => 1_000_000, getVerifiedModels });
    expect(await transport.streamResponse(request, { expectedAccountId: account.accountId, signal: new AbortController().signal })).toMatchObject({ failure: { code: "provider_denied", dispatched: false } });
    expect(getVerifiedModels).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not read supplemental evidence without a current authorized session or valid provider catalog", async () => {
    for (const testCase of ["expired-session", "invalid-catalog"] as const) {
      const getVerifiedModels = vi.fn(async () => [{ slug: request.model, displayName: "Verified fixture" }]);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ unexpected: [] })));
      const transport = createChatGPTTransport({ getSession: async () => testCase === "expired-session" ? { ...account, expiresAt: 1 } : account,
        fetch: fetcher, now: () => 1_000_000, getVerifiedModels });
      expect(await transport.streamResponse(request, { expectedAccountId: account.accountId, signal: new AbortController().signal })).toMatchObject({ failure: { dispatched: false } });
      expect(getVerifiedModels).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(testCase === "expired-session" ? 0 : 1);
    }
  });

  it("keeps current provider inference rejection authoritative for a previously verified model", async () => {
    const getVerifiedModels = async () => [{ slug: request.model, displayName: "Verified fixture" }];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(catalog([])).mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "subscription_sharing_user_not_eligible" } }), { status: 403 }));
    const transport = createChatGPTTransport({ getSession: async () => account, fetch: fetcher, now: () => 1_000_000, getVerifiedModels });
    expect(await transport.streamResponse(request, { expectedAccountId: account.accountId, signal: new AbortController().signal })).toMatchObject({ status: "failed", failure: { code: "subscription_sharing_user_not_eligible", dispatched: true } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fences account changes while supplemental evidence is being read", async () => {
    let current = account;
    const getVerifiedModels = vi.fn(async () => {
      current = { ...account, accountId: "other-registration" };
      return [{ slug: request.model, displayName: "Verified fixture" }];
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => catalog([]));
    const transport = createChatGPTTransport({ getSession: async () => current, fetch: fetcher, now: () => 1_000_000, getVerifiedModels });
    await expect(transport.listModels(new AbortController().signal)).rejects.toMatchObject({ failure: { code: "account_changed" } });
    current = account;
    expect(await transport.streamResponse(request, { expectedAccountId: account.accountId, signal: new AbortController().signal })).toMatchObject({ failure: { code: "account_changed", dispatched: false } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed on duplicate or malformed supplemental models", async () => {
    for (const models of [[{ slug: request.model, displayName: "One" }, { slug: request.model, displayName: "Two" }], [{ slug: "../invalid", displayName: "Invalid" }]]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(catalog([]));
      const transport = createChatGPTTransport({ getSession: async () => account, fetch: fetcher, now: () => 1_000_000, getVerifiedModels: async () => models });
      expect(await transport.streamResponse(request, { expectedAccountId: account.accountId, signal: new AbortController().signal })).toMatchObject({ failure: { code: "model_catalog_invalid", dispatched: false } });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects contradictory duplicate provider entries instead of unhiding a model", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(catalog([
      { slug: request.model, display_name: "Visible", visibility: "list" }, { slug: request.model, display_name: "Hidden", visibility: "hide" },
    ]));
    const transport = createChatGPTTransport({ getSession: async () => account, fetch: fetcher, now: () => 1_000_000 });
    await expect(transport.listModels(new AbortController().signal)).rejects.toMatchObject({ failure: { code: "model_catalog_invalid" } });
  });

  it("lists only account-specific visible models in server order without a default model", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(catalog([
      { slug: "second", display_name: "Second", visibility: "list" },
      { slug: "hidden", display_name: "Hidden", visibility: "hide" },
      { slug: "first", display_name: "First", visibility: "list" },
    ]));
    const transport = createChatGPTTransport({ getSession: async () => account, fetch: fetcher, now: () => 1_000_000 });
    expect(await transport.listModels(new AbortController().signal)).toEqual({ accountId: account.accountId, models: [{ slug: "second", displayName: "Second" }, { slug: "first", displayName: "First" }] });
    expect(fetcher.mock.calls[0]![0]).toBe("https://api.openai.com/v1/models");
  });

  it("sets only supported streaming fields, sends explicit history and waits for completion", async () => {
    const f = fixture(); const onTextDelta = vi.fn();
    const outcome = await f.run({ onTextDelta });
    expect(outcome).toMatchObject({ status: "completed", responseId: "resp_fixture", requestId: "req_fixture", partialText: "Synthetic partial", accountId: account.accountId });
    expect(onTextDelta).toHaveBeenCalledWith("Synthetic partial");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    const [url, options] = f.fetcher.mock.calls[1]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(options).toMatchObject({ redirect: "error", method: "POST" });
    expect(JSON.parse(String(options?.body))).toEqual({ ...request, store: false, stream: true });
    expect(f.fetcher.mock.calls[0]![1]?.headers).toHaveProperty("Authorization", `Bearer ${account.accessToken}`);
    expect(options?.headers).toHaveProperty("Authorization", `Bearer ${account.accessToken}`);
    expect(JSON.stringify(outcome)).not.toContain(account.accessToken);
  });

  it.each([1, 7, 65_536])("validates actual SSE through completion when Content-Type is omitted (%s-byte chunks)", async chunkBytes => {
    // Reproduces the live metadata discrepancy using synthetic content only.
    const f = fixture(); const onTextDelta = vi.fn();
    const text = ': heartbeat\r\n' + event({ type: "response.created", response: { id: "resp_fixture", status: "in_progress" } })
      + event({ ...delta, delta: "café 🧩" }) + event(completed);
    const response = stream(text, chunkBytes, null);
    expect(response.headers.get("content-type")).toBeNull();
    f.fetcher.mockReset().mockResolvedValueOnce(catalog()).mockResolvedValueOnce(response);
    expect(await f.run({ onTextDelta })).toMatchObject({ status: "completed", responseId: "resp_fixture", requestId: "req_fixture", partialText: "café 🧩", accountId: account.accountId });
    expect(onTextDelta).toHaveBeenCalledWith("café 🧩");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["application/json", "text/html", "text/plain", "", "text/event-stream-invalid"])("rejects an explicit incompatible Content-Type (%s) even with valid SSE", async contentType => {
    const f = fixture(); const onTextDelta = vi.fn();
    f.fetcher.mockReset().mockResolvedValueOnce(catalog()).mockResolvedValueOnce(stream(event(delta) + event(completed), 7, contentType));
    expect(await f.run({ onTextDelta })).toMatchObject({ status: "interrupted", partialText: "", failure: { code: "stream_invalid", dispatched: true } });
    expect(onTextDelta).not.toHaveBeenCalled();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["JSON body", JSON.stringify(completed)],
    ["HTML body", "<html><body>Synthetic gateway response</body></html>"],
    ["empty body", ""],
    ["unterminated event", event(completed).trimEnd()],
  ])("does not treat a headerless %s as completed inference", async (_label, text) => {
    const f = fixture(); const onTextDelta = vi.fn();
    f.fetcher.mockReset().mockResolvedValueOnce(catalog()).mockResolvedValueOnce(stream(text, 7, null));
    expect(await f.run({ onTextDelta })).toMatchObject({ status: "interrupted", partialText: "", failure: { code: "stream_missing_completion", dispatched: true } });
    expect(onTextDelta).not.toHaveBeenCalled();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([{ label: "empty", output: [] }, { label: "omitted", output: undefined }])("assembles completed output items when the terminal payload is $label", async ({ output }) => {
    const text = event({ type: "response.created", response: { id: "resp_fixture", status: "in_progress" } })
      + event(doneItem(0, reasoningItem)) + event(doneItem(1, messageItem))
      + event({ ...completed, response: { ...completed.response, output } });
    const f = fixture();
    f.fetcher.mockReset().mockResolvedValueOnce(catalog()).mockResolvedValueOnce(stream(text, 7, null));
    const result = await runChatGPTStrategy({ operation: "strategy.reformulate", context: contextSnapshotSchema.parse({ description: "Synthetic evening workshop" }),
      model: request.model, expectedAccountId: account.accountId, transport: f.transport, signal: f.controller.signal });
    expect(result).toMatchObject({ status: "succeeded", result: { responseId: "resp_fixture", model: request.model, proposal, usage: null } });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps completed-item order by output_index rather than event arrival order", async () => {
    const f = fixture(event(doneItem(1, messageItem)) + event(doneItem(0, reasoningItem)) + event(completed));
    expect(await f.run()).toMatchObject({ status: "completed", response: { output: [reasoningItem, messageItem] } });
  });

  it("accepts an identical full terminal payload without duplicating completed items", async () => {
    const reorderedMessage = { content: messageItem.content, phase: messageItem.phase, role: messageItem.role, status: messageItem.status, type: messageItem.type, id: messageItem.id };
    const f = fixture(event(doneItem(0, messageItem)) + event({ ...completed, response: { ...completed.response, output: [reorderedMessage] } }));
    expect(await f.run()).toMatchObject({ status: "completed", response: { output: [messageItem] } });
  });

  it.each([
    ["duplicate index", [doneItem(0, messageItem), doneItem(0, messageItem)]],
    ["reused item ID", [doneItem(0, messageItem), doneItem(1, messageItem)]],
    ["conflicting index", [doneItem(0, reasoningItem), doneItem(0, messageItem)]],
    ["added identity changed", [{ type: "response.output_item.added", output_index: 0, item: { ...messageItem, id: "msg_other", status: "in_progress" } }, doneItem(0, messageItem)]],
    ["missing index", [doneItem(1, messageItem)]],
    ["unfinished added item", [{ type: "response.output_item.added", output_index: 1, item: { ...reasoningItem, id: "rs_other" } }, doneItem(0, messageItem)]],
  ])("rejects %s instead of reconstructing ambiguous output", async (_label, items) => {
    const f = fixture(items.map(event).join("") + event(completed));
    expect(await f.run()).toMatchObject({ status: "interrupted", failure: { code: "stream_output_mismatch", dispatched: true } });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([-1, 0.5, 100, undefined])("rejects an invalid completed-item index (%s)", async output_index => {
    const f = fixture(event({ type: "response.output_item.done", output_index, item: messageItem }) + event(completed));
    expect(await f.run()).toMatchObject({ status: "interrupted", failure: { code: "stream_invalid_output_item", dispatched: true } });
  });

  it.each([
    ["different text", [reasoningItem, { ...messageItem, content: [{ type: "output_text", text: "Conflicting synthetic answer", annotations: [] }] }]],
    ["different identity", [reasoningItem, { ...messageItem, id: "msg_other" }]],
    ["shortened output", [reasoningItem]],
  ])("rejects a conflicting nonempty terminal payload (%s)", async (_label, output) => {
    const f = fixture(event(doneItem(0, reasoningItem)) + event(doneItem(1, messageItem)) + event({ ...completed, response: { ...completed.response, output } }));
    expect(await f.run()).toMatchObject({ status: "interrupted", failure: { code: "stream_output_mismatch", dispatched: true } });
  });

  it.each([
    ["EOF", "", "stream_missing_completion"],
    ["incomplete", event({ type: "response.incomplete", response: { id: "resp_fixture", status: "incomplete" } }), "provider_incomplete"],
    ["failed", event({ type: "response.failed", response: { id: "resp_fixture", status: "failed", error: { code: "subscription_sharing_usage_limit_exceeded" } } }), "subscription_sharing_usage_limit_exceeded"],
  ])("does not promote completed items to success before terminal completion (%s)", async (_label, suffix, code) => {
    const f = fixture(event(doneItem(0, messageItem)) + suffix);
    const result = await f.run();
    expect(result.status).not.toBe("completed");
    expect(result).toMatchObject({ partialText: JSON.stringify(proposal), failure: { code, dispatched: true } });
  });

  it.each(["", JSON.stringify(proposal).slice(0, 30), JSON.stringify(proposal), JSON.stringify(proposal) + "Later partial"])(
    "retains completed assistant text without duplicating earlier deltas (%s)", async streamedText => {
      const text = event({ ...delta, delta: streamedText }) + event(doneItem(0, messageItem));
      const result = await fixture(text).run();
      expect(result).toMatchObject({ status: "interrupted", partialText: streamedText.startsWith(JSON.stringify(proposal)) ? streamedText : JSON.stringify(proposal),
        failure: { code: "stream_missing_completion" } });
    },
  );

  it("preserves completed assistant messages in output order without exposing reasoning or refusal content", async () => {
    const message = (id: string, text: string) => ({ ...messageItem, id, content: [{ type: "output_text", text, annotations: [] }] });
    const reasoning = { ...reasoningItem, content: [{ type: "output_text", text: "Synthetic private reasoning" }] };
    const refusal = { ...messageItem, id: "msg_refusal", content: [{ type: "refusal", refusal: "Synthetic refusal" }] };
    const f = fixture(event(doneItem(2, message("msg_second", "Second."))) + event(doneItem(0, reasoning))
      + event(doneItem(1, message("msg_first", "First."))) + event(doneItem(3, refusal)));
    expect(await f.run()).toMatchObject({ status: "interrupted", partialText: "First.Second.", failure: { code: "stream_missing_completion" } });
    const reasoningOnly = fixture(event(doneItem(0, reasoning)));
    expect(await reasoningOnly.run()).toMatchObject({ status: "interrupted", partialText: "" });
  });

  it("keeps previously completed text bounded when a later completed item exceeds the output limit", async () => {
    const message = (id: string, text: string) => ({ ...messageItem, id, content: [{ type: "output_text", text, annotations: [] }] });
    const f = fixture(event(doneItem(0, message("msg_short", "Kept"))) + event(doneItem(1, message("msg_large", "Long synthetic answer"))));
    expect(await f.run({ limits: { maxOutputBytes: 10 } })).toMatchObject({ status: "interrupted", partialText: "Kept", failure: { code: "output_limit_exceeded" } });
  });

  it("does not invent completed items from text deltas or added items", async () => {
    const deltas = fixture(event(delta) + event(completed));
    expect(await deltas.run()).toMatchObject({ status: "completed", partialText: "Synthetic partial", response: { output: [] } });
    const added = fixture(event({ type: "response.output_item.added", output_index: 0, item: { ...messageItem, status: "in_progress" } }) + event(completed));
    expect(await added.run()).toMatchObject({ status: "interrupted", failure: { code: "stream_output_mismatch", dispatched: true } });
  });

  it("bounds completed output text even when the provider omits deltas", async () => {
    const f = fixture(event(doneItem(0, messageItem)) + event(completed));
    expect(await f.run({ limits: { maxOutputBytes: 10 } })).toMatchObject({ status: "interrupted", failure: { code: "output_limit_exceeded", dispatched: true } });
  });

  it.each(["cancel", "releaseLock"] as const)("preserves the observed outcome when reader %s cleanup throws", async method => {
    const f = fixture();
    const response = stream(event(completed));
    const reader = response.body!.getReader();
    vi.spyOn(response.body!, "getReader").mockReturnValue(reader);
    vi.spyOn(reader, method).mockImplementation(() => { throw new Error("Synthetic cleanup failure"); });
    f.fetcher.mockReset().mockResolvedValueOnce(catalog()).mockResolvedValueOnce(response);
    await expect(f.run()).resolves.toMatchObject({ status: "completed", responseId: "resp_fixture" });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["EOF", "", "stream_missing_completion"],
    ["DONE", "data: [DONE]\n\n", "stream_missing_completion"],
    ["malformed event", "data: {invalid}\n\n", "stream_interrupted"],
    ["nonterminal completion", event({ ...completed, response: { ...completed.response, status: "in_progress" } }), "stream_invalid_completion"],
    ["provider error", event({ type: "error", code: "subscription_sharing_usage_limit_exceeded" }), "subscription_sharing_usage_limit_exceeded"],
  ])("preserves headerless partials without inventing success on %s", async (_label, suffix, code) => {
    const f = fixture();
    f.fetcher.mockReset().mockResolvedValueOnce(catalog()).mockResolvedValueOnce(stream(event(delta) + suffix, 7, null));
    const outcome = await f.run();
    expect(outcome.status).not.toBe("completed");
    expect(outcome).toMatchObject({ partialText: "Synthetic partial", failure: { code, dispatched: true } });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ maxOutputBytes: 3 }, "output_limit_exceeded"],
    [{ maxStreamBytes: 3 }, "stream_limit_exceeded"],
  ])("keeps byte limits active when Content-Type is omitted", async (limits, code) => {
    const f = fixture();
    f.fetcher.mockReset().mockResolvedValueOnce(catalog()).mockResolvedValueOnce(stream(event(delta) + event(completed), 7, null));
    expect(await f.run({ limits })).toMatchObject({ status: "interrupted", failure: { code, dispatched: true } });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["max_output_tokens", "max_tool_calls", "background", "conversation", "previous_response_id", "metadata", "temperature", "service_tier"])("rejects unsupported %s before any request", async (field) => {
    const f = fixture();
    const result = await f.transport.streamResponse({ ...request, [field]: 1 } as ChatGPTResponseRequest, { expectedAccountId: account.accountId, signal: f.controller.signal });
    expect(result).toMatchObject({ status: "unavailable", failure: { code: "request_invalid", dispatched: false } });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("rejects system messages and image-generation tools without switching billing", async () => {
    for (const change of [{ input: [{ role: "system", content: "fixture" }] }, { tools: [{ type: "image_generation" }] }]) {
      const f = fixture();
      expect(await f.transport.streamResponse({ ...request, ...change } as ChatGPTResponseRequest, { expectedAccountId: account.accountId, signal: f.controller.signal })).toMatchObject({ failure: { code: "request_invalid", dispatched: false } });
      expect(f.fetcher).not.toHaveBeenCalled();
    }
  });

  it.each([
    [{ ...account, scopes: ["openid"] }, "plan_permission_required"],
    [{ ...account, expiresAt: 1 }, "session_expired"],
    [{ ...account, accessToken: "sk-synthetic-test-credential" }, "sign_in_required"],
  ] as const)("requires a valid direct-permission OAuth session", async (session, code) => {
    const f = fixture(); f.getSession.mockResolvedValue(session);
    expect(await f.run()).toMatchObject({ status: "unavailable", failure: { code, dispatched: false } });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("does not use a different account or catalog after selection changes", async () => {
    const f = fixture();
    f.getSession.mockResolvedValueOnce(account).mockResolvedValue({ ...account, accountId: "registration-fixture-b" });
    expect(await f.run()).toMatchObject({ status: "unavailable", failure: { code: "account_changed", dispatched: false } });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses a model absent from this account's catalog", async () => {
    const f = fixture(); f.fetcher.mockReset().mockResolvedValue(catalog([]));
    expect(await f.run()).toMatchObject({ status: "unavailable", failure: { code: "model_unavailable", dispatched: false } });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("checks the current worker policy after catalog lookup and before inference", async () => {
    const f = fixture();
    const beforeDispatch = vi.fn(async () => { throw new Error("Synthetic disabled policy"); });
    expect(await f.run({ beforeDispatch })).toMatchObject({ status: "unavailable", failure: { code: "runtime_policy_unavailable", dispatched: false } });
    expect(beforeDispatch).toHaveBeenCalledTimes(1);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("rechecks the selected account after the worker policy wait", async () => {
    const f = fixture();
    expect(await f.run({ beforeDispatch: () => { f.getSession.mockResolvedValue({ ...account, accountId: "registration-fixture-b" }); } })).toMatchObject({ failure: { code: "account_changed", dispatched: false } });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("awaits partial persistence and stops safely when it fails", async () => {
    const f = fixture(); const onTextDelta = vi.fn(async () => { throw new Error("Synthetic lost lease"); });
    expect(await f.run({ onTextDelta })).toMatchObject({ status: "interrupted", partialText: "Synthetic partial", failure: { dispatched: true, code: "stream_interrupted" } });
    expect(onTextDelta).toHaveBeenCalledTimes(1);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not publish completion after sign-out or account switch during the stream", async () => {
    const f = fixture();
    const outcome = await f.run({ onTextDelta: () => f.getSession.mockResolvedValue({ ...account, accountId: "registration-fixture-b" }) });
    expect(outcome).toMatchObject({ status: "interrupted", partialText: "Synthetic partial", failure: { code: "account_changed", dispatched: true } });
  });

  it.each([
    ["subscription_sharing_usage_limit_exceeded", "view_usage"],
    ["subscription_sharing_usage_unavailable", "retry_later"],
    ["subscription_sharing_user_not_eligible", "review_policy"],
    ["subscription_sharing_unsupported_capability", "fix_request"],
  ])("preserves partials and exact %s error after streaming starts", async (code, recovery) => {
    const f = fixture(event(delta) + event({ type: "response.failed", response: { id: "resp_fixture", status: "failed", error: { code, param: "tools.0", message: "Synthetic private diagnostic" } } }));
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "failed", partialText: "Synthetic partial", failure: { code, providerCode: code, providerParam: "tools.0", recovery, dispatched: true, responseId: "resp_fixture" } });
    expect(JSON.stringify(outcome)).not.toContain("Synthetic private diagnostic");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 503])("handles direct-admission detail bodies for HTTP %s", async (status) => {
    const f = fixture(); f.fetcher.mockReset().mockResolvedValueOnce(catalog()).mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Synthetic sensitive diagnostic" }), { status, headers: { "x-request-id": "req_admission" } }));
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "failed", failure: { httpStatus: status, bodyShape: "detail", providerCode: null, requestId: "req_admission" } });
    expect(JSON.stringify(outcome)).not.toContain("Synthetic sensitive diagnostic");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it("quarantines unexplained server failures after dispatch rather than assuming rejection", async () => {
    for (const [status, body] of [[502, "temporary failure"], [502, JSON.stringify({ error: { code: "server_error" } })], [500, JSON.stringify({ detail: "Synthetic server failure" })]] as const) {
      const f = fixture(); f.fetcher.mockReset().mockResolvedValueOnce(catalog()).mockResolvedValueOnce(new Response(body, { status }));
      expect(await f.run()).toMatchObject({ status: "interrupted", failure: { httpStatus: status, dispatched: true } });
      expect(f.fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it.each([
    [event(delta), "stream_missing_completion"],
    [event(delta) + "data: [DONE]\n\n", "stream_missing_completion"],
    [event(delta) + event({ type: "response.incomplete", response: { id: "resp_fixture", status: "incomplete" } }), "provider_incomplete"],
    [event(delta) + event({ type: "error", code: "subscription_sharing_usage_limit_exceeded" }), "subscription_sharing_usage_limit_exceeded"],
  ])("never treats partial output or an error as success", async (events, code) => {
    const f = fixture(events); const outcome = await f.run();
    expect(outcome.status).not.toBe("completed");
    expect(outcome).toMatchObject({ partialText: "Synthetic partial", failure: { code, dispatched: true } });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it("decodes split UTF-8, CRLF, comments and multiline SSE data", async () => {
    const unicodeDelta = ': heartbeat\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"café 🧩"}\r\n\r\n';
    const f = fixture(unicodeDelta + event(completed));
    expect(await f.run()).toMatchObject({ status: "completed", partialText: "café 🧩" });
  });

  it("rejects interleaved response identities", async () => {
    const f = fixture(event({ type: "response.created", response: { id: "resp_other" } }) + event(completed));
    expect(await f.run()).toMatchObject({ status: "interrupted", failure: { code: "stream_response_mismatch" } });
  });

  it("binds identity from the first delta when no created event was received", async () => {
    const f = fixture(event({ ...delta, response_id: "resp_other" }) + event(completed));
    expect(await f.run()).toMatchObject({ status: "interrupted", failure: { code: "stream_response_mismatch", responseId: "resp_other" } });
  });

  it("cancels before publishing a later completion and retains actual earlier deltas", async () => {
    const f = fixture();
    expect(await f.run({ onTextDelta: () => f.controller.abort() })).toMatchObject({ status: "cancelled", partialText: "Synthetic partial", failure: { code: "cancelled", dispatched: true } });
  });

  it("bounds a nonsettling stream even when its injected reader ignores abort", async () => {
    const f = fixture();
    f.fetcher.mockReset().mockResolvedValueOnce(catalog()).mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>(), { headers: { "content-type": "text/event-stream" } }));
    expect(await f.run({ limits: { deadlineMs: 5 } })).toMatchObject({ status: "cancelled", failure: { code: "deadline_exceeded", dispatched: true } });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it("enforces local input, output, stream and observed-tool bounds", async () => {
    const input = fixture();
    expect(await input.run({ limits: { maxInputBytes: 10 } })).toMatchObject({ failure: { code: "input_limit_exceeded", dispatched: false } });
    expect(input.fetcher).not.toHaveBeenCalled();
    expect(await fixture().run({ limits: { maxOutputBytes: 3 } })).toMatchObject({ failure: { code: "output_limit_exceeded", dispatched: true } });
    expect(await fixture().run({ limits: { maxStreamBytes: 3 } })).toMatchObject({ failure: { code: "stream_limit_exceeded", dispatched: true } });
    const tools = fixture(event({ type: "response.output_item.added", item: { id: "ws_fixture", type: "web_search_call" } }) + event(completed));
    expect(await tools.run({ limits: { maxObservedWebSearchCalls: 0 } })).toMatchObject({ failure: { code: "observed_tool_limit_exceeded", dispatched: true } });
  });

  it("does not retry a connection failure or expose its raw diagnostic", async () => {
    const f = fixture(); f.fetcher.mockReset().mockResolvedValueOnce(catalog()).mockRejectedValueOnce(new Error("Synthetic private network diagnostic"));
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "interrupted", failure: { code: "stream_interrupted", dispatched: true } });
    expect(JSON.stringify(outcome)).not.toContain("Synthetic private");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("synchronous final subscription dispatch fence", () => {
  it.each([
    ["false", () => false], ["throw", () => { throw Error("Synthetic stopped host"); }],
    ["nonboolean", () => "true"], ["async true", async () => true],
    ["async rejection", async () => { throw Error("Synthetic invalid async guard"); }],
  ])("refuses %s without invoking responses or claiming dispatch", async (_name, acceptingWork) => {
    const f = fixture(), beforeDispatch = vi.fn(async () => {});
    expect(await f.run({ acceptingWork, beforeDispatch })).toMatchObject({ status: "unavailable", failure: { code: "runtime_policy_unavailable", dispatched: false }, partialText: "" });
    expect(beforeDispatch).toHaveBeenCalledOnce(); expect(f.fetcher.mock.calls.map(([url]) => String(url))).toEqual(["https://api.openai.com/v1/models"]);
  });
  it("observes a stop during the last asynchronous account check before invoking responses", async () => {
    const f = fixture(); let active = true;
    const beforeDispatch = vi.fn(async () => {}), acceptingWork = vi.fn(() => active);
    f.getSession.mockResolvedValueOnce(account).mockImplementationOnce(async () => { await Promise.resolve(); active = false; return account; });
    expect(await f.run({ beforeDispatch, acceptingWork })).toMatchObject({ status: "unavailable", failure: { code: "runtime_policy_unavailable", dispatched: false } });
    expect(beforeDispatch).toHaveBeenCalledOnce(); expect(acceptingWork).toHaveBeenCalledOnce(); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("captures the selected synchronous hook before caller mutation during session lookup", async () => {
    const f = fixture(), options = { expectedAccountId: account.accountId, signal: f.controller.signal, acceptingWork: () => false };
    f.getSession.mockImplementationOnce(async () => { options.acceptingWork = () => true; return account; });
    expect(await f.transport.streamResponse(request, options)).toMatchObject({ status: "unavailable", failure: { dispatched: false } });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("calls the final guard once and preserves a completed stream after the host stops following fetch", async () => {
    const f = fixture(); let active = true;
    const acceptingWork = vi.fn(() => active), beforeDispatch = vi.fn(async () => {});
    f.fetcher.mockReset().mockResolvedValueOnce(catalog()).mockImplementationOnce(async () => { active = false; return stream(event(delta) + event(completed)); });
    expect(await f.run({ acceptingWork, beforeDispatch })).toMatchObject({ status: "completed", responseId: "resp_fixture", partialText: "Synthetic partial" });
    expect(beforeDispatch).toHaveBeenCalledOnce(); expect(acceptingWork).toHaveBeenCalledOnce(); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("preserves uncertain post-fetch failure instead of relabeling it non-dispatched", async () => {
    const f = fixture(); let active = true;
    const acceptingWork = vi.fn(() => active);
    f.fetcher.mockReset().mockResolvedValueOnce(catalog()).mockImplementationOnce(async () => { active = false; throw Error("Synthetic lost response"); });
    expect(await f.run({ acceptingWork })).toMatchObject({ status: "interrupted", failure: { code: "stream_interrupted", dispatched: true } });
    expect(acceptingWork).toHaveBeenCalledOnce(); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
});
