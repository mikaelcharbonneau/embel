import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createNamingManagedProtocol, NamingManagedProtocolError } from "../../src/server/ai/naming-brain/protocol";

describe("Managed Naming SDK boundary (synthetic HTTP)", () => {
  it("fails closed before real HTTP creation while retaining observation and cancellation", async () => {
    const http = vi.fn(async (incoming: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(incoming, init);
      if (request.method === "POST") {
        expect(new URL(request.url).pathname).toBe("/v1/agents/sessions/sess_fixture/events");
        expect(await request.json()).toEqual({ events: [{ type: "agent.session.input.cancel" }] });
        return new Response(null, { status: 202 });
      }
      return Response.json({ id: "sess_fixture" });
    });
    vi.stubGlobal("fetch", http);
    try {
      const protocol = createNamingManagedProtocol({ apiKey: "synthetic-never-sent" });
      await expect(protocol.createSession({ environment: { type: "none" }, agent: { model: "gpt-6-luna" }, input: "Fixture", spend_control: { limit: 10 }, stream: true }, new AbortController().signal)).rejects.toMatchObject({ code: "creation_unavailable" });
      expect(http).not.toHaveBeenCalled();
      await expect(protocol.submitToolResult("sess_fixture", { type: "agent.session.input.tool_result", turn_id: "turn_fixture", call_id: "call_fixture", success: true, output: "Synthetic only" }, "synthetic-key", new AbortController().signal)).rejects.toMatchObject({ code: "creation_unavailable" });
      expect(http).not.toHaveBeenCalled();
      await protocol.retrieveSession("sess_fixture", new AbortController().signal);
      await protocol.cancelSession("sess_fixture", new AbortController().signal);
      expect(http).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllGlobals(); }
  });
  it("uses the real pinned SDK create shape and fixed no-redirect transport", async () => {
    const requests: { url: string; method: string; body: unknown; beta: string | null; redirect: RequestRedirect }[] = [];
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-fixture", fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, method: request.method, body: await request.json(), beta: request.headers.get("openai-beta"), redirect: request.redirect });
      return new Response('data: {"type":"agent.session.idle","event_id":"fixture_event","session":{"id":"session_fixture"}}\n\n', { headers: { "content-type": "text/event-stream", "x-request-id": "req_fixture" } });
    } });
    const stream = await protocol.createSession({ environment: { type: "none" }, agent: { model: "gpt-6-astra", tools: [], multi_agent: { enabled: false } }, input: "Synthetic only", spend_control: { limit: 50 }, metadata: { intent: "fixture" }, stream: true }, new AbortController().signal);
    const events = [];
    for await (const event of stream.events) events.push(event);
    stream.close();
    expect(events).toHaveLength(1);
    expect(stream.requestId).toBe("req_fixture");
    expect(requests).toEqual([{ url: "https://api.openai.com/v1/agents/sessions", method: "POST", beta: "agents=v1", redirect: "error", body: { environment: { type: "none" }, agent: { model: "gpt-6-astra", tools: [], multi_agent: { enabled: false } }, input: "Synthetic only", spend_control: { limit: 50 }, metadata: { intent: "fixture" }, stream: true } }]);
  });

  it("never retries uncertain creation or exposes private provider errors", async () => {
    let calls = 0;
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-fixture", fetch: async () => { calls++; return new Response(JSON.stringify({ error: { message: "private secret fixture" } }), { status: 500 }); } });
    const error = await protocol.createSession({ environment: { type: "none" }, agent: { model: "gpt-6-astra" }, input: "Fixture", spend_control: { limit: 10 }, stream: true }, new AbortController().signal).catch(error => error);
    expect(error).toBeInstanceOf(NamingManagedProtocolError);
    expect(error.code).toBe("outcome_unknown");
    expect(String(error)).not.toContain("private");
    expect(calls).toBe(1);
  });

  it("retains only bounded provider rejection classifications", async () => {
    const diagnostics: unknown[] = [];
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-fixture", onDiagnostic: value => diagnostics.push(value), fetch: async () => new Response(JSON.stringify({ error: {
      message: "private prompt and credential fixture", code: "unsupported_parameter", param: "agent.reasoning.effort", type: "invalid_request_error",
    } }), { status: 400, headers: { "x-request-id": "req_rejected_fixture" } }) });
    const failure = await protocol.createSession({ environment: { type: "none" }, agent: { model: "gpt-6.1-sol" }, input: "Synthetic only", spend_control: { limit: 50 }, stream: true }, new AbortController().signal).catch(error => error);
    expect(failure).toMatchObject({ code: "request_rejected", requestId: "req_rejected_fixture", diagnostic: { status: 400, providerCode: "unsupported_parameter", parameter: "agent.reasoning.effort" } });
    expect(diagnostics).toEqual([{ status: 400, providerCode: "unsupported_parameter", parameter: "agent.reasoning.effort" }]);
    expect(JSON.stringify(failure)).not.toContain("private");
  });

  it("drops arbitrary error codes and parameter values instead of logging provider content", async () => {
    const diagnostics: unknown[] = [];
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-fixture", onDiagnostic: value => diagnostics.push(value), fetch: async () => new Response(JSON.stringify({ error: { code: "private_secret_fixture", param: "input.private_secret_fixture" } }), { status: 422 }) });
    await expect(protocol.createSession({ environment: { type: "none" }, agent: { model: "gpt-6.1-sol" }, input: "Fixture", spend_control: { limit: 10 }, stream: true }, new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected" });
    expect(diagnostics).toEqual([{ status: 422, providerCode: null, parameter: null }]);
  });

  it("submits tool results with the documented session/turn/call protocol", async () => {
    const sent: unknown[] = [];
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-fixture", fetch: async (input, init) => { const request = new Request(input, init); sent.push({ url: request.url, body: await request.json(), key: request.headers.get("idempotency-key") }); return new Response(null, { status: 202 }); } });
    await protocol.submitToolResult("session_fixture", { type: "agent.session.input.tool_result", turn_id: "turn_fixture", call_id: "call_fixture", success: true, output: "retained fixture result" }, "fixture-key-0123456789", new AbortController().signal);
    expect(sent).toEqual([{ url: "https://api.openai.com/v1/agents/sessions/session_fixture/events", key: "fixture-key-0123456789", body: { events: [{ type: "agent.session.input.tool_result", turn_id: "turn_fixture", call_id: "call_fixture", success: true, output: "retained fixture result" }] } }]);
  });

  it.each([null, { limit: null }, { limit: 0 }, { limit: 151 }])("refuses an unbounded or out-of-policy native cap before I/O", async spend_control => {
    let attempted = false;
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-fixture", fetch: async () => { attempted = true; return new Response(null, { status: 400 }); } });
    await expect(protocol.createSession({ environment: { type: "none" }, agent: { model: "gpt-6-astra" }, input: "Fixture", spend_control, stream: true }, new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected" });
    expect(attempted).toBe(false);
  });
});
