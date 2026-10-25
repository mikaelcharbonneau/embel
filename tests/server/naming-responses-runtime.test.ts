import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const readiness = vi.hoisted(() => ({ available: true }));
vi.mock("../../src/server/ai/naming-responses/budget", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/server/ai/naming-responses/budget")>();
  return { ...actual, namingResponsesProductionReadiness: () => ({ ...actual.namingResponsesProductionReadiness(), available: readiness.available }) };
});
import { namingResponsesWireSchema, type NamingResponsesDispatch, type NamingResponsesRequest } from "../../src/domain/naming-responses";
import { createNamingResponsesRequest } from "../../src/server/ai/naming-responses/prompts";
import { createNamingResponsesProtocol, type NamingResponsesResponse } from "../../src/server/ai/naming-responses/protocol";
import { createNamingResponsesRuntime, type NamingResponsesPersistence } from "../../src/server/ai/naming-responses/runtime";
import { namingTextHash } from "../../src/server/ai/naming-brain/identity";

afterEach(() => { vi.unstubAllGlobals(); readiness.available = true; });
const started = Date.parse("2026-10-24T01:00:00Z"), runId = "11111111-1111-4111-8111-111111111111", responseId = "resp_synthetic_runtime";
type Fault = "begin_ack" | "reserve_ack" | "handle_ack" | "observe_ack" | "create_unknown" | "create_rejected" | "create_rejected_no_id" | "get_unknown" | "none";
function fixture(fault: Fault = "none", initial = "complete", withReference = false) {
  let time = started, phase = initial, injected = false, abortOnHandle = false;
  const controller = new AbortController(), rows = new Map<string, NamingResponsesDispatch>(), mutations: string[] = [], http: { method: string; path: string }[] = [];
  const request = createNamingResponsesRequest({ runId, dispatchKey: "creation.synthetic", now: time, body: namingResponsesWireSchema.parse({
    model: "gpt-6-luna", reasoning: { effort: "xhigh", mode: "standard" }, service_tier: "default", prompt_cache_options: { mode: "explicit", ttl: "30m" },
    input: "Synthetic naming role", instructions: "Return only synthetic fixture JSON", max_output_tokens: 32_768,
    ...(withReference ? { max_tool_calls: 4 } : {}),
    tools: withReference ? [{ type: "web_search", search_context_size: "low", filters: { allowed_domains: ["www.merriam-webster.com"] } }, { type: "function", name: "read_reference", description: "Synthetic reference", parameters: { type: "object", properties: {}, additionalProperties: false, required: [] }, strict: true }] : [], tool_choice: "auto", parallel_tool_calls: false,
    background: true, store: true, stream: true, truncation: "disabled", include: ["reasoning.encrypted_content"],
    text: { verbosity: "low", format: { type: "json_schema", name: "synthetic_names", strict: true, schema: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, required: ["names"], additionalProperties: false } } },
    metadata: { embel_run: runId, embel_dispatch: "creation.synthetic", embel_contract: "naming-responses-v1", embel_owner: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", embel_project: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  }), ...(withReference ? { qualification: { id: "synthetic-research-only", validUntil: "2026-10-25T00:00:00Z", maximumInputTokens: 1_050_000, sourceComplete: true, hostedResearch: true } } : {}) });
  const clone = <T>(value: T): T => structuredClone(value);
  function maybeFail(which: Fault) { if (!injected && fault === which) { injected = true; throw Error(`synthetic_${which}_lost`); } }
  const row = (key: string) => { const found = rows.get(key); if (!found) throw Error("synthetic_dispatch_missing"); return found; };
  const persistence: NamingResponsesPersistence = {
    load: async () => clone({ runId, allocatedCostNanoUsd: [...rows.values()].reduce((total, value) => total + value.request.quote.maximumCostNanoUsd, 0), maximumCostNanoUsd: 5_000_000_000 as const, dispatches: [...rows.values()] }),
    reserve: async value => {
      mutations.push("reserve");
      if (!rows.has(value.dispatchKey)) rows.set(value.dispatchKey, { request: clone(value), state: "reserved", responseId: null, terminalResponse: null, observations: [], executionDeadlineAt: new Date(started + 900_000).toISOString(), observationDeadlineAt: new Date(started + 1_800_000).toISOString() });
      maybeFail("reserve_ack"); return clone(row(value.dispatchKey));
    },
    begin: async key => { mutations.push("begin"); const found = row(key); if (found.state !== "reserved") return false; found.state = "dispatching"; maybeFail("begin_ack"); return true; },
    handle: async (key, id) => { mutations.push("handle"); const found = row(key); if (found.responseId && found.responseId !== id) throw Error("synthetic_handle_changed"); found.responseId = id; found.state = "accepted"; if (abortOnHandle) controller.abort(); maybeFail("handle_ack"); return clone(found); },
    observe: async (key, response) => {
      mutations.push("observe"); const found = row(key); expect(found.responseId).toBe(response.id);
      const serialized = JSON.stringify(response), bytes = Buffer.byteLength(serialized);
      if (bytes > 2_097_152) found.observations.push({ kind: "oversize_response", responseId: String(response.id), requestId: null, bytes, sha256: namingTextHash(serialized), unsafeReason: "responses_output_limit" });
      else { found.observations.push(JSON.parse(serialized)); if (!found.terminalResponse && ["completed", "failed", "cancelled", "incomplete"].includes(String(response.status))) { found.state = "terminal"; found.terminalResponse = clone(response) as NamingResponsesDispatch["terminalResponse"]; } }
      maybeFail("observe_ack"); return clone(found);
    },
    reject: async (key, id, code) => { expect(id).toMatch(/^req_/); expect(code).toBe("provider_request_rejected"); mutations.push("reject"); const found = row(key); found.state = "rejected"; return clone(found); },
  };
  function response(status: string = phase === "complete" ? "completed" : phase === "cancelled" ? "cancelled" : "in_progress"): NamingResponsesResponse {
    return { ...clone(request.body), id: responseId, object: "response", status, previous_response_id: null, conversation: null,
      output: status === "completed" ? [{ id: "msg_synthetic", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ names: Array.from({ length: 100 }, (_, index) => `Synthetic ${index + 1}`) }) }] }] : [],
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 } } };
  }
  let mutateResponse: (value: NamingResponsesResponse) => NamingResponsesResponse = value => value;
  const fetcher: typeof fetch = async (incoming, init) => {
    const outgoing = new Request(incoming, init), path = new URL(outgoing.url).pathname;
    http.push({ method: outgoing.method, path });
    if (outgoing.method === "POST" && path === "/v1/responses") {
      expect(await outgoing.json()).toEqual(request.body);
      if (fault === "create_unknown") throw Error("synthetic_create_ack_lost");
      if (fault === "create_rejected" || fault === "create_rejected_no_id") return Response.json({ error: { message: "Synthetic rejected configuration", type: "invalid_request_error", code: "unknown_parameter" } }, { status: 400, headers: fault === "create_rejected" ? { "x-request-id": "req_synthetic_rejected" } : {} });
      const events = [{ type: "response.created", sequence_number: 0, response: mutateResponse(response("in_progress")) },
        ...(phase === "complete" ? [{ type: "response.completed", sequence_number: 1, response: mutateResponse(response("completed")) }] : [])];
      return new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", "x-request-id": "req_synthetic_runtime" } });
    }
    if (outgoing.method === "POST") { expect(path).toBe(`/v1/responses/${responseId}/cancel`); if (phase === "cancel_witness") phase = "cancelled"; return Response.json(response("cancelled")); }
    expect(outgoing.method).toBe("GET"); expect(path).toBe(`/v1/responses/${responseId}`);
    if (fault === "get_unknown" && !injected) { injected = true; throw Error("synthetic_read_ack_lost"); }
    return Response.json(mutateResponse(response()));
  };
  const protocol = createNamingResponsesProtocol({ apiKey: "synthetic", fetch: fetcher });
  const runtime = createNamingResponsesRuntime({ protocol, persistence, now: () => time });
  return { request, persistence, runtime, controller, rows, mutations, http, response, fetcher,
    advance: (next: number) => { time = next; }, phase: (next: string) => { phase = next; }, mutate: (fn: typeof mutateResponse) => { mutateResponse = fn; }, abortAfterHandle: () => { abortOnHandle = true; } };
}

describe("durable Naming Responses execution (synthetic HTTP/store)", () => {
  it("reserves and consumes one begin before a capped create; stores100 synthetic names without inventing settlement", async () => {
    const f = fixture(), result = await f.runtime.run(f.request, { signal: f.controller.signal });
    expect(result).toMatchObject({ status: "completed", responseId, requiresExplicitContinuation: false, output: { names: expect.any(Array) } });
    if (result.status !== "completed") throw Error("synthetic_completion_missing");
    expect((result.output as { names: string[] }).names).toHaveLength(100);
    expect(f.mutations.slice(0, 3)).toEqual(["reserve", "begin", "handle"]);
    expect(f.http.filter(value => value.method === "POST")).toEqual([{ method: "POST", path: "/v1/responses" }]);
    const saved = await f.persistence.load(); expect(saved.allocatedCostNanoUsd).toBe(f.request.quote.maximumCostNanoUsd);
    expect(JSON.stringify(saved)).not.toContain("confirmedActualCost");
    await f.runtime.run(f.request, { signal: f.controller.signal }); expect(f.http).toHaveLength(1);
  });

  it("blocks default real creation before a reservation or HTTP request", async () => {
    readiness.available = false;
    const f = fixture(), fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const runtime = createNamingResponsesRuntime({ apiKey: "synthetic-never-sent", persistence: f.persistence, now: () => started });
    expect(await runtime.run(f.request, { signal: f.controller.signal })).toEqual({ status: "blocked", code: "creation_unavailable", responseId: null });
    expect(f.mutations).toEqual([]); expect(fetcher).not.toHaveBeenCalled();
  });

  it("blocks an injected HTTP transport before reserve or one-shot begin", async () => {
    readiness.available = false;
    const f = fixture();
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toEqual({ status: "blocked", code: "creation_unavailable", responseId: null });
    expect(f.mutations).toEqual([]); expect(f.http).toEqual([]);
  });

  it("rejects a request for another run before any persistence mutation or HTTP", async () => {
    const f = fixture();
    vi.spyOn(f.persistence, "load").mockResolvedValue({ runId: "22222222-2222-4222-8222-222222222222", allocatedCostNanoUsd: 0, maximumCostNanoUsd: 5_000_000_000, dispatches: [] });
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toEqual({ status: "blocked", code: "responses_run_mismatch", responseId: null });
    expect(f.mutations).toEqual([]); expect(f.http).toEqual([]);
  });

  it("returns a concurrent retained completion when a delayed GET reports progress", async () => {
    const f = fixture("none", "running");
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "pending" });
    const observe = f.persistence.observe;
    vi.spyOn(f.persistence, "observe").mockImplementation(async (key, response, requestId) => {
      await observe(key, f.response("completed"), "req_concurrent_terminal");
      return observe(key, response, requestId);
    });
    expect(await f.runtime.resume(f.request.dispatchKey, { signal: f.controller.signal })).toMatchObject({ status: "completed", responseId });
    expect(f.rows.get(f.request.dispatchKey)?.terminalResponse?.status).toBe("completed");
    expect(f.http.filter(value => value.method === "POST")).toHaveLength(1);
  });

  it("never creates after a lost one-shot begin acknowledgement or a duplicate worker", async () => {
    const f = fixture("begin_ack");
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "unresolved" });
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "unresolved", code: "responses_identity_unknown" });
    expect(f.mutations.filter(value => value === "begin")).toHaveLength(1); expect(f.http).toEqual([]);
    expect(f.rows.get(f.request.dispatchKey)?.state).toBe("dispatching");
  });

  it("grants only one create to competing callers of the exact frozen request", async () => {
    const f = fixture();
    const results = await Promise.all([f.runtime.run(f.request, { signal: f.controller.signal }), f.runtime.run(f.request, { signal: f.controller.signal })]);
    expect(results.some(result => result.status === "completed")).toBe(true);
    expect(f.http.filter(value => value.method === "POST" && value.path === "/v1/responses")).toHaveLength(1);
    expect(f.mutations.filter(value => value === "begin")).toHaveLength(2);
  });

  it("can begin the same safely reserved request after a lost reserve acknowledgement, without reallocating", async () => {
    const f = fixture("reserve_ack");
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "unresolved" });
    expect(f.http).toEqual([]); expect(f.mutations).toEqual(["reserve"]);
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "completed" });
    expect((await f.persistence.load()).allocatedCostNanoUsd).toBe(f.request.quote.maximumCostNanoUsd);
    expect(f.http.filter(value => value.method === "POST")).toHaveLength(1);
  });

  it("does not begin during observation or after cancellation before dispatch", async () => {
    const f = fixture();
    expect(await f.runtime.run(f.request, { signal: f.controller.signal, observeOnly: true })).toMatchObject({ status: "blocked", code: "responses_readonly" });
    f.controller.abort(); expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "blocked" });
    expect(f.mutations).toEqual([]); expect(f.http).toEqual([]);
  });

  it("never renews an expired reservation execution deadline or grants a late begin", async () => {
    const f = fixture(); await f.persistence.reserve(f.request);
    const deadline = f.rows.get(f.request.dispatchKey)!.executionDeadlineAt;
    f.advance(started + 900_001);
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "blocked", code: "responses_execution_deadline_exceeded" });
    expect(f.rows.get(f.request.dispatchKey)!.executionDeadlineAt).toBe(deadline);
    expect(f.mutations).not.toContain("begin"); expect(f.http).toEqual([]);
  });

  it("quarantines an uncertain create without a handle and never replays it", async () => {
    const f = fixture("create_unknown");
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "unresolved", responseId: null });
    expect(await f.runtime.resume(f.request.dispatchKey, { signal: f.controller.signal })).toMatchObject({ status: "unresolved", code: "responses_identity_unknown" });
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "unresolved" });
    expect(f.http).toEqual([{ method: "POST", path: "/v1/responses" }]);
    expect((await f.persistence.load()).allocatedCostNanoUsd).toBe(f.request.quote.maximumCostNanoUsd);
  });

  it.each(["create_rejected", "create_rejected_no_id"] as const)("retains the allowance for%s without replay or invented zero-cost settlement", async fault => {
    const f = fixture(fault);
    const result = await f.runtime.run(f.request, { signal: f.controller.signal });
    expect(result.status).toBe(fault === "create_rejected" ? "blocked" : "unresolved");
    expect(f.rows.get(f.request.dispatchKey)?.state).toBe(fault === "create_rejected" ? "rejected" : "dispatching");
    await f.runtime.run(f.request, { signal: f.controller.signal });
    expect(f.http).toEqual([{ method: "POST", path: "/v1/responses" }]);
    expect((await f.persistence.load()).allocatedCostNanoUsd).toBe(f.request.quote.maximumCostNanoUsd);
  });

  it.each(["handle_ack", "observe_ack"] as const)("recovers a durable handle after%s loss without another create", async fault => {
    const f = fixture(fault);
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "completed", responseId });
    expect(f.http.filter(value => value.method === "POST" && value.path === "/v1/responses")).toHaveLength(1);
    expect(f.http.some(value => value.method === "GET")).toBe(true);
    expect(f.rows.get(f.request.dispatchKey)?.responseId).toBe(responseId);
  });

  it("retrieves background completion after an ended stream; resume uses no reserve/begin/create", async () => {
    const f = fixture("none", "running");
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "pending", responseId });
    const mutationCount = f.mutations.length, httpCount = f.http.length;
    f.phase("complete"); expect(await f.runtime.resume(f.request.dispatchKey, { signal: f.controller.signal })).toMatchObject({ status: "completed", responseId });
    expect(f.mutations.slice(mutationCount)).toEqual(["observe"]); expect(f.http.slice(httpCount)).toEqual([{ method: "GET", path: `/v1/responses/${responseId}` }]);
  });

  it.each([false, true])("cancellation acceptance alone is not terminal; only observed history qualifies (terminal=%s)", async terminal => {
    const f = fixture("none", "running"); await f.runtime.run(f.request, { signal: f.controller.signal });
    if (terminal) f.phase("cancel_witness");
    const before = f.http.length, result = await f.runtime.cancel(f.request.dispatchKey, { signal: f.controller.signal });
    expect(result).toMatchObject(terminal ? { status: "terminal", state: "cancelled", responseId } : { status: "pending", responseId });
    expect(f.http.slice(before)).toEqual([{ method: "POST", path: `/v1/responses/${responseId}/cancel` }, { method: "GET", path: `/v1/responses/${responseId}` }]);
    expect((await f.persistence.load()).allocatedCostNanoUsd).toBe(f.request.quote.maximumCostNanoUsd);
  });

  it("honors an abort after issued identity with bounded cancellation and GET proof", async () => {
    const f = fixture("none", "cancel_witness"); f.abortAfterHandle();
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "terminal", state: "cancelled", responseId });
    expect(f.http.filter(value => value.method === "POST").map(value => value.path)).toEqual(["/v1/responses", `/v1/responses/${responseId}/cancel`]);
  });

  it("keeps aborted/expired known-response recovery GET-only and never renews observation deadlines", async () => {
    const f = fixture("none", "running"); await f.runtime.run(f.request, { signal: f.controller.signal });
    f.advance(started + 900_001); f.controller.abort(); const before = f.http.length;
    expect(await f.runtime.resume(f.request.dispatchKey, { signal: f.controller.signal, observeOnly: true })).toMatchObject({ status: "pending", responseId });
    expect(f.http.slice(before)).toEqual([{ method: "GET", path: `/v1/responses/${responseId}` }]);
    f.advance(started + 1_800_001); const expiryCalls = f.http.length;
    expect(await f.runtime.resume(f.request.dispatchKey, { signal: f.controller.signal })).toMatchObject({ status: "unresolved", code: "responses_observation_deadline_exceeded", responseId });
    expect(f.http).toHaveLength(expiryCalls);
  });

  it("does no cancellation POST when an explicit cancellation check is observation-only", async () => {
    const f = fixture("none", "running"); await f.runtime.run(f.request, { signal: f.controller.signal });
    const before = f.http.length;
    expect(await f.runtime.cancel(f.request.dispatchKey, { signal: f.controller.signal, observeOnly: true })).toMatchObject({ status: "pending", responseId });
    expect(f.http.slice(before)).toEqual([{ method: "GET", path: `/v1/responses/${responseId}` }]);
  });

  it.each(["service_tier", "max_output_tokens", "max_tool_calls", "reasoning", "prompt_cache_options", "usage"] as const)("fails closed on observed%s mismatch while retaining the known handle", async field => {
    const f = fixture("none", "running");
    f.mutate(value => ({ ...value, [field]: field === "service_tier" ? "priority" : field === "max_output_tokens" ? 65_536 : field === "max_tool_calls" ? 4 : field === "reasoning" ? { effort: "high", mode: "standard" } : field === "prompt_cache_options" ? { mode: "implicit", ttl: "30m" } : { input_tokens: 2_000_000, output_tokens: 10 } }));
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "unresolved", responseId });
    expect(f.rows.get(f.request.dispatchKey)?.responseId).toBe(responseId);
    expect(f.http.filter(value => value.method === "POST" && value.path === "/v1/responses")).toHaveLength(1);
  });

  it("does not bind or cancel a foreign-metadata response", async () => {
    const f = fixture(); f.mutate(value => ({ ...value, metadata: { ...f.request.body.metadata, embel_run: "22222222-2222-4222-8222-222222222222" } }));
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "unresolved", code: "responses_identity_mismatch", responseId: null });
    expect(f.rows.get(f.request.dispatchKey)?.responseId).toBeNull(); expect(f.http).toEqual([{ method: "POST", path: "/v1/responses" }]);
  });

  it.each([{ value: { cached_tokens: "0" } }, { value: [] }, { value: { cached_tokens: false } }])("rejects malformed cache-counter shape%j without coercing it to free usage", async ({ value }) => {
    const f = fixture("none", "running");
    f.mutate(response => ({ ...response, usage: { input_tokens: 20, output_tokens: 10, input_tokens_details: value } }));
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "unresolved", code: "responses_cache_behavior_mismatch", responseId });
    expect(f.rows.get(f.request.dispatchKey)?.responseId).toBe(responseId);
    const before = f.http.length;
    expect(await f.runtime.resume(f.request.dispatchKey, { signal: f.controller.signal })).toMatchObject({ status: "unresolved", code: "responses_cache_behavior_mismatch", responseId });
    expect(f.http.slice(before)).toEqual([{ method: "GET", path: `/v1/responses/${responseId}` }]);
  });

  it("retains an observed overrun across cancellation and later under-bound completion, including reload", async () => {
    const f = fixture("none", "running");
    f.mutate(value => f.http.some(row => row.path.endsWith("/cancel"))
      ? { ...f.response("completed"), usage: { input_tokens: 20, output_tokens: 10 } }
      : { ...value, usage: { input_tokens: 2_000_000, output_tokens: 10 } });
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "unresolved", code: "responses_observed_bound_exceeded", responseId });
    const saved = f.rows.get(f.request.dispatchKey)!;
    expect(saved.observations).toHaveLength(2);
    expect(saved.observations[0]).toMatchObject({ usage: { input_tokens: 2_000_000 } });
    expect(saved.terminalResponse).toMatchObject({ status: "completed", usage: { input_tokens: 20 } });
    const before = f.http.length;
    expect(await f.runtime.resume(f.request.dispatchKey, { signal: f.controller.signal })).toMatchObject({ status: "unresolved", code: "responses_observed_bound_exceeded", responseId });
    expect(f.http).toHaveLength(before);
    const another = createNamingResponsesRequest({ runId, dispatchKey: "creation.next", now: started,
      body: { ...f.request.body, metadata: { ...f.request.body.metadata, embel_dispatch: "creation.next" } } });
    expect(await f.runtime.run(another, { signal: f.controller.signal })).toMatchObject({ status: "blocked", code: "responses_run_quarantined" });
    expect(f.http).toHaveLength(before); expect((await f.persistence.load()).allocatedCostNanoUsd).toBe(f.request.quote.maximumCostNanoUsd);
  });

  it("quarantines a compact oversized-response witness across later completion and resume", async () => {
    const f = fixture("none", "running");
    f.mutate(value => f.http.some(row => row.path.endsWith("/cancel")) ? f.response("completed") : { ...value, extra: "x".repeat(2_097_152) });
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "unresolved", code: "responses_output_limit", responseId });
    const saved = f.rows.get(f.request.dispatchKey)!;
    expect(saved.observations[0]).toMatchObject({ kind: "oversize_response", responseId, unsafeReason: "responses_output_limit", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(saved.observations[0]).length).toBeLessThan(500);
    expect(saved.terminalResponse?.status).toBe("completed");
    const before = f.http.length;
    expect(await f.runtime.resume(f.request.dispatchKey, { signal: f.controller.signal })).toMatchObject({ status: "unresolved", code: "responses_output_limit", responseId });
    expect(f.http).toHaveLength(before);
  });

  it("withholds a terminal result when a durable conflicting-terminal marker is retained", async () => {
    const f = fixture(); await f.runtime.run(f.request, { signal: f.controller.signal });
    const saved = f.rows.get(f.request.dispatchKey)!;
    saved.observations.push({ response: { id: responseId, status: "cancelled" }, requestId: null, unsafeReason: "responses_terminal_conflict" });
    const before = f.http.length;
    expect(await f.runtime.resume(f.request.dispatchKey, { signal: f.controller.signal })).toMatchObject({ status: "unresolved", code: "responses_terminal_conflict", responseId });
    expect(saved.terminalResponse?.status).toBe("completed"); expect(f.http).toHaveLength(before);
  });

  it("requires a separately frozen/reserved request for function output and never submits it automatically", async () => {
    const f = fixture("none", "complete", true); f.mutate(value => ({ ...value, output: value.status === "completed" ? [{ type: "function_call", id: "fc_synthetic", name: "read_reference", call_id: "call_synthetic", arguments: "{}", status: "completed" }] : [] }));
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "completed", output: null, requiresExplicitContinuation: true, responseId });
    expect(f.http).toEqual([{ method: "POST", path: "/v1/responses" }]);
  });

  it("withholds unrequested tools instead of treating them as permission for a continuation", async () => {
    const f = fixture(); f.mutate(value => ({ ...value, output: [{ type: "function_call", name: "unapproved", call_id: "bad", arguments: "{}", status: "completed" }] }));
    expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "unresolved", code: "responses_tool_output_invalid", responseId });
    expect(f.http.filter(value => value.method === "POST" && value.path === "/v1/responses")).toHaveLength(1);
  });

  it("rejects a changed frozen request hash and an expired qualification before dispatch", async () => {
    const f = fixture();
    expect(await f.runtime.run({ ...f.request, requestHash: "a".repeat(64) } as NamingResponsesRequest, { signal: f.controller.signal })).toMatchObject({ status: "blocked", code: "responses_request_invalid" });
    f.advance(Date.parse(f.request.quote.validUntil)); expect(await f.runtime.run(f.request, { signal: f.controller.signal })).toMatchObject({ status: "blocked", code: "responses_rate_qualification_expired" });
    expect(f.mutations).toEqual([]); expect(f.http).toEqual([]);
  });
});
