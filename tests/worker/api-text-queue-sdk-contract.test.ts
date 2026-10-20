import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { databaseFixture, delivery, message as payload } from "./api-text-runtime-fixture";
import { transportFixture } from "../server/openai-fixtures";
import { JsonTransport, QueueClient } from "@vercel/queue";
import { handleApiTextQueueRequest } from "../../worker/hosting/consumer";
import type { DiagnosticSink } from "../../worker/hosting/diagnostics";

function callback(options: { routing?: boolean; count?: number; invalid?: boolean } = {}) {
  return new Request("https://callback.invalid/api/consume", { method: "POST", headers: {
    "content-type": "application/json", "ce-type": options.invalid ? "invalid.synthetic" : "com.vercel.queue.v2beta",
    "ce-vqsqueuename": "fluid-api-text-v1", "ce-vqsconsumergroup": "synthetic-consumer", "ce-vqsmessageid": "msg_synthetic",
    "ce-vqsregion": "iad1", ...(!options.routing ? { "ce-vqsreceipthandle": "receipt_synthetic", "ce-vqsdeliverycount": String(options.count ?? 1) } : {}),
  }, body: JSON.stringify(payload) });
}
function received() {
  return new Response(["--synthetic-boundary", "Content-Type: application/json", "Vqs-Message-Id: msg_synthetic",
    "Vqs-Receipt-Handle: receipt_synthetic", "Vqs-Delivery-Count: 1", "Vqs-Timestamp: 2026-10-20T00:00:00.000Z", "",
    JSON.stringify(payload), "--synthetic-boundary--", ""].join("\r\n"), { headers: { "content-type": "multipart/mixed; boundary=synthetic-boundary" } });
}
function harness(options: { fail?: string; finalize?: boolean; receive?: () => Promise<Response> } = {}) {
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    // A global hermetic replacement rejects every unexpected origin. No credentials
    // or real broker/provider are used, even if this test fails partway through.
    expect(url.origin).toBe("https://broker.invalid");
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, body: typeof init?.body === "string" ? init.body : undefined });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-contract-token");
    expect(new Headers(init?.headers).get("Vqs-Deployment-Id")).toBe("dpl_synthetic");
    if (method === "POST" && url.pathname.endsWith("/id/msg_synthetic")) return options.receive ? options.receive() : received();
    expect(url.pathname).toBe("/api/v3/topic/fluid-api-text-v1/consumer/synthetic-consumer/lease/receipt_synthetic");
    if (method === options.fail) return Response.json({ error: { message: "synthetic broker unavailable" } }, { status: 503 });
    expect(["PATCH", "DELETE"]).toContain(method);
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetcher);
  const transport = new JsonTransport();
  const finalize = vi.fn(async () => { if (options.finalize) throw new Error("synthetic cleanup failure"); });
  const queue = new QueueClient({ region: "iad1", token: "synthetic-contract-token", deploymentId: "dpl_synthetic",
    resolveBaseUrl: () => new URL("https://broker.invalid"), telemetry: { isEnabled: false },
    transport: { contentType: transport.contentType, serialize: value => transport.serialize(value), deserialize: stream => transport.deserialize(stream), finalize } });
  const events: Parameters<DiagnosticSink>[0][] = [];
  const diagnostics: DiagnosticSink = event => { events.push(event); };
  const invoke = (deliver: Parameters<typeof handleApiTextQueueRequest>[1]["deliver"], request = callback()) =>
    handleApiTextQueueRequest(request, { queue, deliver, diagnostics });
  return { calls, queue, invoke, events, finalize };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("actual pinned Queue SDK wire contract (no external network)", () => {
  it("pins both application and installed SDK versions so upgrades require contract review", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const installed = JSON.parse(readFileSync(new URL("../../node_modules/@vercel/queue/package.json", import.meta.url), "utf8"));
    expect(manifest.dependencies["@vercel/queue"]).toBe("0.8.0"); expect(installed.version).toBe("0.8.0");
  });
  it("reschedules a nonterminal result with zero acknowledgements despite HTTP 200", async () => {
    const f = harness(); const deliver = vi.fn<Parameters<typeof handleApiTextQueueRequest>[1]["deliver"]>().mockResolvedValue({ disposition: "retry", state: "running" });
    const response = await f.invoke(deliver, callback({ count: 2 }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: "success" });
    expect(deliver.mock.calls[0]?.[0]).toEqual(payload);
    expect(f.calls).toEqual([{ method: "PATCH", path: "/api/v3/topic/fluid-api-text-v1/consumer/synthetic-consumer/lease/receipt_synthetic", body: '{"visibilityTimeoutSeconds":120}' }]);
    expect(f.events.map(event => event.outcome)).toEqual(["retry_requested", "retry_requested", "transport_success"]);
    expect(f.finalize).toHaveBeenCalledTimes(1);
  });
  it("acknowledges a terminal result exactly once and emits no visibility directive", async () => {
    const f = harness(); const response = await f.invoke(async () => ({ disposition: "ack", state: "succeeded" }));
    expect(response.status).toBe(200); expect(f.calls.map(call => call.method)).toEqual(["DELETE"]);
    expect(f.events.map(event => event.outcome)).toEqual(["terminal_ack_requested", "transport_success"]);
  });
  it("composes real SDK ACKs with durable delivery so a duplicate never creates a second provider request", async () => {
    const f = harness(); const database = databaseFixture(); const provider = transportFixture();
    const deliver = (message: unknown, signal: AbortSignal) => delivery(database, provider, { message, signal, diagnostics: () => {} });
    expect((await f.invoke(deliver)).status).toBe(200);
    expect((await f.invoke(deliver)).status).toBe(200);
    expect(f.calls.map(call => call.method)).toEqual(["DELETE", "DELETE"]);
    expect(provider.createResponse).toHaveBeenCalledTimes(1);
    expect(database.state.outcomes).toHaveLength(1);
  });
  it("parses routing-only v2 CloudEvents through the actual multipart receive path", async () => {
    const f = harness(); const deliver = vi.fn<Parameters<typeof handleApiTextQueueRequest>[1]["deliver"]>().mockResolvedValue({ disposition: "ack", state: "succeeded" });
    expect((await f.invoke(deliver, callback({ routing: true }))).status).toBe(200);
    expect(f.calls.map(call => call.method)).toEqual(["POST", "DELETE"]); expect(deliver.mock.calls[0]?.[0]).toEqual(payload);
  });
  it("does not mistake failed visibility scheduling for acknowledgement or business completion", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {}); const f = harness({ fail: "PATCH" });
    expect((await f.invoke(async () => ({ disposition: "retry", state: "running" }))).status).toBe(200);
    expect(f.calls.map(call => call.method)).toEqual(["PATCH"]); expect(warning).toHaveBeenCalledWith("Failed to reschedule message for retry:", expect.any(Error));
    expect(f.events.some(event => event.outcome === "terminal_ack_requested")).toBe(false);
  });
  it("failed ACK schedules a retry without executing the business handler twice", async () => {
    const f = harness({ fail: "DELETE" }); const deliver = vi.fn<Parameters<typeof handleApiTextQueueRequest>[1]["deliver"]>().mockResolvedValue({ disposition: "ack", state: "succeeded" });
    expect((await f.invoke(deliver)).status).toBe(200);
    expect(f.calls.map(call => call.method)).toEqual(["DELETE", "PATCH"]); expect(deliver).toHaveBeenCalledTimes(1);
    expect(f.events.map(event => event.outcome)).toEqual(["terminal_ack_requested", "retry_requested", "transport_success"]);
  });
  it("exposes the pinned SDK cleanup-failure behavior without hiding it in a mock callback", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {}); const f = harness({ finalize: true });
    expect((await f.invoke(async () => ({ disposition: "retry", state: "busy" }))).status).toBe(200);
    expect(f.calls.map(call => call.method)).toEqual(["PATCH"]); expect(f.finalize).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith("Failed to finalize message payload:", expect.any(Error));
  });
  it("rejects invalid CloudEvents without invoking business work or broker transport", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); const f = harness(); const deliver = vi.fn<Parameters<typeof handleApiTextQueueRequest>[1]["deliver"]>().mockResolvedValue({ disposition: "ack", state: "succeeded" });
    expect((await f.invoke(deliver, callback({ invalid: true }))).status).toBe(400);
    expect(deliver).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(0);
  });
  it("fences a late SDK receive after its deadline without aborting a separate invocation", async () => {
    vi.useFakeTimers(); let resolveReceive: ((response: Response) => void) | undefined;
    const f = harness({ receive: () => new Promise(resolve => { resolveReceive = resolve; }) });
    const late = vi.fn<Parameters<typeof handleApiTextQueueRequest>[1]["deliver"]>().mockResolvedValue({ disposition: "ack", state: "succeeded" });
    const result = f.invoke(late, callback({ routing: true })).catch(error => error);
    await vi.advanceTimersByTimeAsync(270_001);
    expect(await result).toBeInstanceOf(Error);
    const healthy = vi.fn(async (_message: unknown, signal: AbortSignal) => { expect(signal.aborted).toBe(false); return { disposition: "ack", state: "succeeded" } as const; });
    expect((await f.invoke(healthy)).status).toBe(200);
    resolveReceive?.(received()); await vi.advanceTimersByTimeAsync(1);
    expect(late).not.toHaveBeenCalled(); expect(healthy).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "PATCH")).toHaveLength(1);
  });
});

describe("Queue diagnostic sink isolation", () => {
  it("cannot change retry scheduling or terminal ACK when the diagnostic sink throws", async () => {
    const f = harness(); const diagnostics = () => { throw new Error("synthetic sink failure"); };
    expect((await handleApiTextQueueRequest(callback(), { queue: f.queue, diagnostics, deliver: async () => ({ disposition: "retry", state: "busy" }) })).status).toBe(200);
    expect((await handleApiTextQueueRequest(callback(), { queue: f.queue, diagnostics, deliver: async () => ({ disposition: "ack", state: "succeeded" }) })).status).toBe(200);
    expect(f.calls.map(call => call.method)).toEqual(["PATCH", "DELETE"]);
  });
});
