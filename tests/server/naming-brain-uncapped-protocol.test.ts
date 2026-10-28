import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createNamingManagedProtocol, type ManagedCreateRequest } from "../../src/server/ai/naming-brain/protocol";

afterEach(() => vi.unstubAllGlobals());

const profiles: { name: string; compatibilityExecution: boolean; body: ManagedCreateRequest }[] = [
  { name: "historical capped", compatibilityExecution: false, body: { environment: { type: "none" }, agent: { model: "gpt-6.1-sol" }, input: "Synthetic historical request", spend_control: { limit: 50 }, stream: true } },
  { name: "historical local unlimited", compatibilityExecution: true, body: { environment: { type: "none" }, agent: { model: "gpt-6.1-sol" }, input: "Synthetic historical local request", metadata: { embel_budget_control: "local_unlimited_v1" }, stream: true } },
  { name: "future hosted unlimited", compatibilityExecution: true, body: { environment: { type: "none" }, agent: { model: "gpt-6.1-sol", service_tier: "priority", text: { verbosity: "low" } }, input: "Synthetic future hosted request", metadata: { embel_budget_control: "local_unlimited_v1", embel_pipeline_version: "2", embel_progressive_contract_version: "3", embel_request_hash: "a".repeat(64) }, stream: true } },
  { name: "future factual contract4 unlimited", compatibilityExecution: true, body: { environment: { type: "none" }, agent: { model: "gpt-6.1-sol", service_tier: "priority", text: { verbosity: "low" } }, input: "Synthetic contract4 request", metadata: { embel_budget_control: "local_unlimited_v1", embel_pipeline_version: "2", embel_progressive_contract_version: "4", embel_request_hash: "b".repeat(64) }, stream: true } },
  { name: "future evidence contract5 unlimited", compatibilityExecution: true, body: { environment: { type: "none" }, agent: { model: "gpt-6.1-sol", service_tier: "priority", text: { verbosity: "low" } }, input: "Synthetic contract5 request", metadata: { embel_budget_control: "local_unlimited_v1", embel_pipeline_version: "2", embel_progressive_contract_version: "5", embel_request_hash: "c".repeat(64) }, stream: true } },
];

describe.each([false, true])("native Naming request compatibility (injected transport=%s)", injectedTransport => {
  it.each(profiles)("preserves $name creation, tool continuation, reads and cancellation without a cost availability prerequisite", async ({ compatibilityExecution, body }) => {
    const requests: { method: string; path: string; body?: unknown; key?: string | null }[] = [];
    const http = vi.fn(async (incoming: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(incoming, init), url = new URL(request.url);
      expect(url.origin).toBe("https://api.openai.com");
      const row: typeof requests[number] = { method: request.method, path: url.pathname };
      requests.push(row);
      if (request.method === "POST") {
        row.body = await request.json();
        if (url.pathname === "/v1/agents/sessions") return new Response("", { headers: { "content-type": "text/event-stream", "x-request-id": "req_synthetic" } });
        expect(url.pathname).toBe("/v1/agents/sessions/sess_fixture/events");
        row.key = request.headers.get("idempotency-key");
        return new Response(null, { status: 202 });
      }
      expect(request.method).toBe("GET");
      if (url.pathname.endsWith("/events")) return new Response("", { headers: { "content-type": "text/event-stream" } });
      if (url.pathname.endsWith("/items")) return Response.json({ data: [{ id: "item_fixture" }], has_more: false, last_id: "item_fixture" });
      if (url.pathname.endsWith("/turns")) return Response.json({ data: [{ id: "turn_fixture" }], has_more: false });
      return Response.json({ id: url.pathname.endsWith("/turn_fixture") ? "turn_fixture" : "sess_fixture" });
    });
    vi.stubGlobal("fetch", http);
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-never-sent-to-live-provider", localPrototype: compatibilityExecution, ...(injectedTransport ? { fetch: http } : {}) });
    const signal = new AbortController().signal, original = structuredClone(body);
    const created = await protocol.createSession(body, signal);
    for await (const event of created.events) expect(event).toBeUndefined();
    created.close();
    expect(created.requestId).toBe("req_synthetic");
    expect(body).toEqual(original);
    const toolResult = { type: "agent.session.input.tool_result" as const, turn_id: "turn_fixture", call_id: "call_fixture", success: true, output: "Synthetic retained result" };
    await protocol.submitToolResult("sess_fixture", toolResult, "synthetic-original-tool-key", signal);

    const observed = await protocol.streamSession("sess_fixture", signal);
    for await (const event of observed.events) expect(event).toBeUndefined();
    observed.close();
    await expect(protocol.retrieveSession("sess_fixture", signal)).resolves.toMatchObject({ id: "sess_fixture" });
    await expect(protocol.retrieveTurn("sess_fixture", "turn_fixture", signal)).resolves.toMatchObject({ id: "turn_fixture" });
    await expect(protocol.listTurns("sess_fixture", null, signal)).resolves.toEqual({ data: [{ id: "turn_fixture" }], hasMore: false, after: "turn_fixture" });
    await expect(protocol.listItems("sess_fixture", "turn_fixture", null, signal)).resolves.toEqual({ data: [{ id: "item_fixture" }], hasMore: false, after: "item_fixture" });
    await protocol.cancelSession("sess_fixture", signal);
    expect(requests).toEqual([
      { method: "POST", path: "/v1/agents/sessions", body: original },
      { method: "POST", path: "/v1/agents/sessions/sess_fixture/events", body: { events: [toolResult] }, key: "synthetic-original-tool-key" },
      { method: "GET", path: "/v1/agents/sessions/sess_fixture/events" },
      { method: "GET", path: "/v1/agents/sessions/sess_fixture" },
      { method: "GET", path: "/v1/agents/sessions/sess_fixture/turns/turn_fixture" },
      { method: "GET", path: "/v1/agents/sessions/sess_fixture/turns" },
      { method: "GET", path: "/v1/agents/sessions/sess_fixture/turns/turn_fixture/items" },
      { method: "POST", path: "/v1/agents/sessions/sess_fixture/events", body: { events: [{ type: "agent.session.input.cancel" }] }, key: null },
    ]);
  });

  it("does not derive compatibility execution authority from request metadata or transport injection", async () => {
    const http = vi.fn();
    vi.stubGlobal("fetch", http);
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-only", ...(injectedTransport ? { fetch: http } : {}) });
    for (const profile of profiles.filter(profile => profile.compatibilityExecution)) {
      await expect(protocol.createSession(profile.body, new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected" });
    }
    expect(http).not.toHaveBeenCalled();
  });

  it("rejects a cap smuggled into contract5 before calling the SDK transport", async () => {
    const http = vi.fn(); vi.stubGlobal("fetch", http);
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-only", localPrototype: true, ...(injectedTransport ? { fetch: http } : {}) });
    const body = profiles.at(-1)!.body;
    await expect(protocol.createSession({ ...body, spend_control: { limit: 50 }, metadata: { ...body.metadata, embel_provider_spend_cap_cents: "50" } }, new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected" });
    expect(http).not.toHaveBeenCalled();
  });
});
