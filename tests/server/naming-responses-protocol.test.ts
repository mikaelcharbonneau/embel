import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
// Qualification is synthetic and explicit. A transport injection must never
// grant production dispatch; only this test's module mock opens the adapter.
const readiness = vi.hoisted(() => ({ available: true }));
vi.mock("../../src/server/ai/naming-responses/budget", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/server/ai/naming-responses/budget")>();
  return { ...actual, namingResponsesProductionReadiness: () => ({ ...actual.namingResponsesProductionReadiness(), available: readiness.available }) };
});
import { namingResponsesWireSchema, type NamingResponsesWire } from "../../src/domain/naming-responses";
import { createNamingResponsesProtocol, NamingResponsesProtocolError } from "../../src/server/ai/naming-responses/protocol";

afterEach(() => { vi.unstubAllGlobals(); readiness.available = true; });
function body(): NamingResponsesWire {
  return namingResponsesWireSchema.parse({ model: "gpt-6-luna", reasoning: { effort: "xhigh", mode: "standard" }, service_tier: "default", prompt_cache_options: { mode: "explicit", ttl: "30m" },
    input: "Synthetic input", instructions: "Synthetic only", max_output_tokens: 32_768, tools: [], tool_choice: "auto", parallel_tool_calls: false,
    background: true, store: true, stream: true, truncation: "disabled", include: ["reasoning.encrypted_content"], text: { verbosity: "low", format: { type: "json_schema", name: "synthetic", strict: true, schema: { type: "object", properties: {}, additionalProperties: false, required: [] } } },
    metadata: { embel_run: "11111111-1111-4111-8111-111111111111", embel_dispatch: "synthetic", embel_contract: "naming-responses-v1" } });
}

describe("Naming Responses SDK boundary (synthetic HTTP)", () => {
  it("sends the exact capped background-stream body through SDK7.35 with no redirects or retries", async () => {
    const outgoing: { url: string; method: string; body: unknown; redirect: RequestRedirect; retries: string | null }[] = [];
    const protocol = createNamingResponsesProtocol({ apiKey: "synthetic-fixture", fetch: async (incoming, init) => {
      const request = new Request(incoming, init);
      outgoing.push({ url: request.url, method: request.method, body: await request.json(), redirect: request.redirect, retries: request.headers.get("x-stainless-retry-count") });
      return new Response('data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_fixture"}}\n\n', { headers: { "content-type": "text/event-stream", "x-request-id": "req_synthetic" } });
    } });
    const stream = await protocol.create(body(), new AbortController().signal), events = [];
    for await (const event of stream.events) events.push(event);
    stream.close();
    expect(events).toHaveLength(1); expect(stream.requestId).toBe("req_synthetic");
    expect(outgoing).toEqual([{ url: "https://api.openai.com/v1/responses", method: "POST", body: body(), redirect: "error", retries: "0" }]);
    expect(outgoing[0]!.body).not.toHaveProperty("spend_control"); expect(outgoing[0]!.body).not.toHaveProperty("previous_response_id");
  });

  it("keeps real creation blocked while known-response GET/stream/cancel remain available", async () => {
    readiness.available = false;
    const calls: { path: string; method: string; query: string }[] = [];
    const fetcher = vi.fn(async (incoming: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(incoming, init), url = new URL(request.url);
      calls.push({ path: url.pathname, method: request.method, query: url.search });
      if (request.method === "GET" && url.searchParams.get("stream") === "true") return new Response("", { headers: { "content-type": "text/event-stream" } });
      return Response.json({ id: "resp_fixture", object: "response", output: [] });
    });
    vi.stubGlobal("fetch", fetcher);
    const protocol = createNamingResponsesProtocol({ apiKey: "synthetic-never-sent-for-create" });
    await expect(protocol.create(body(), new AbortController().signal)).rejects.toMatchObject({ code: "creation_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
    await protocol.retrieve("resp_fixture", new AbortController().signal);
    const stream = await protocol.stream("resp_fixture", 7, new AbortController().signal); stream.close();
    await protocol.cancel("resp_fixture", new AbortController().signal);
    expect(calls.map(value => [value.method, value.path])).toEqual([["GET", "/v1/responses/resp_fixture"], ["GET", "/v1/responses/resp_fixture"], ["POST", "/v1/responses/resp_fixture/cancel"]]);
    expect(new URLSearchParams(calls[1]!.query).get("starting_after")).toBe("7");
  });

  it("cannot activate creation by injecting an HTTP transport", async () => {
    readiness.available = false;
    const fetcher = vi.fn();
    const protocol = createNamingResponsesProtocol({ apiKey: "synthetic-never-sent", fetch: fetcher });
    expect(() => protocol.assertCreateAvailable()).toThrow("creation_unavailable");
    await expect(protocol.create(body(), new AbortController().signal)).rejects.toMatchObject({ code: "creation_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends an exact hosted-tool ceiling without replacing it with a prompt instruction", async () => {
    const capped = namingResponsesWireSchema.parse({ ...body(), max_tool_calls: 4,
      tools: [{ type: "web_search", search_context_size: "low", filters: { allowed_domains: ["www.merriam-webster.com"] } },
        { type: "function", name: "read_reference", description: "Synthetic approved reference reader", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, strict: true }], include: ["reasoning.encrypted_content", "web_search_call.action.sources"] });
    const fetcher = vi.fn(async (incoming: RequestInfo | URL, init?: RequestInit) => {
      expect(await new Request(incoming, init).json()).toEqual(capped);
      return new Response("", { headers: { "content-type": "text/event-stream" } });
    });
    const stream = await createNamingResponsesProtocol({ apiKey: "synthetic", fetch: fetcher }).create(capped, new AbortController().signal); stream.close();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([400, 500, "lost"] as const)("never retries status%s and never exposes private provider errors", async status => {
    const fetcher = vi.fn(async () => {
      if (status === "lost") throw Error("private fixture secret");
      return Response.json({ error: { message: "private fixture secret", type: "invalid_request_error", code: "unknown_parameter" } }, { status, headers: { "x-request-id": "req_synthetic_rejection" } });
    });
    const protocol = createNamingResponsesProtocol({ apiKey: "synthetic", fetch: fetcher });
    const failure = await protocol.create(body(), new AbortController().signal).catch(value => value);
    expect(failure).toBeInstanceOf(NamingResponsesProtocolError);
    expect(failure.code).toBe(status === 400 ? "request_rejected" : "outcome_unknown");
    expect(JSON.stringify(failure)).not.toContain("private fixture secret"); expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects redirects and malformed handles without following or constructing another request", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://unrelated.invalid" } }));
    const protocol = createNamingResponsesProtocol({ apiKey: "synthetic", fetch: fetcher });
    await expect(protocol.create(body(), new AbortController().signal)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(protocol.retrieve("resp_../other", new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected" });
    await expect(protocol.stream("resp_fixture", -1, new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects unqualified body fields and oversized raw JSON before it can reach runtime parsing", async () => {
    const fetcher = vi.fn(async () => new Response("x".repeat(2_097_153), { headers: { "content-type": "application/json" } }));
    const protocol = createNamingResponsesProtocol({ apiKey: "synthetic", fetch: fetcher });
    await expect(protocol.create({ ...body(), previous_response_id: "resp_other" } as NamingResponsesWire, new AbortController().signal)).rejects.toBeInstanceOf(NamingResponsesProtocolError);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(protocol.retrieve("resp_fixture", new AbortController().signal)).rejects.toBeInstanceOf(NamingResponsesProtocolError);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
