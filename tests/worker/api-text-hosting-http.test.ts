import { afterEach, describe, expect, it, vi } from "vitest";
import { handleEnqueue, handleRepair } from "../../worker/hosting/http";
const message = { version: 1, jobId: "10000000-0000-4000-8000-000000000001", policyIdentity: "a".repeat(64), deploymentId: "dpl_qualified", dispatchIdentity: "b".repeat(64) };
function fixture() {
  const verify = vi.fn(async () => {});
  const publish = vi.fn<Parameters<typeof handleEnqueue>[1]["publish"]>().mockResolvedValue({ state: "published", messageId: "msg_ok" });
  const repair = vi.fn(async () => ({ examined: 0, errors: 0, backlogMayRemain: false }));
  return { verify, publish, repair, secret: "x".repeat(40) };
}
afterEach(() => vi.useRealTimers());
describe("worker HTTP endpoints", () => {
  it("authenticates publication before reading data or invoking the database seam", async () => {
    const f = fixture(); f.verify.mockRejectedValue(new Error("Unauthorized"));
    const request = new Request("https://worker.invalid/api/enqueue", { method: "POST", body: "invalid JSON" });
    expect((await handleEnqueue(request, f)).status).toBe(401);
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("accepts only POST JSON with the exact small descriptor and no cache", async () => {
    const f = fixture();
    const request = new Request("https://worker.invalid/api/enqueue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) });
    const response = await handleEnqueue(request, f);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ state: "published", messageId: "msg_ok" });
    expect(f.publish.mock.calls[0]?.[0]).toEqual(message);
    expect((await handleEnqueue(new Request(request.url), f)).status).toBe(405);
  });
  it("rejects oversized streaming JSON even when declared length is absent", async () => {
    const f = fixture();
    const request = new Request("https://worker.invalid/api/enqueue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...message, prompt: "x".repeat(4_096) }) });
    expect((await handleEnqueue(request, f)).status).toBe(400); expect(f.publish).not.toHaveBeenCalled();
  });
  it("returns pending safely when durable receipt recording fails", async () => {
    const f = fixture(); f.publish.mockRejectedValue(new Error("secret-database-detail"));
    const request = new Request("https://worker.invalid/api/enqueue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) });
    const response = await handleEnqueue(request, f);
    expect(response.status).toBe(503); expect(await response.text()).toBe('{"state":"dispatch_pending"}');
  });
  it("requires the Cron bearer before repair and GET only", async () => {
    const f = fixture();
    expect((await handleRepair(new Request("https://worker.invalid/api/cron/repair-api-text"), f)).status).toBe(401);
    expect(f.repair).not.toHaveBeenCalled();
    const request = new Request("https://worker.invalid/api/cron/repair-api-text", { headers: { authorization: `Bearer ${f.secret}` } });
    expect((await handleRepair(request, f)).status).toBe(200);
    expect(f.repair).toHaveBeenCalledTimes(1);
    expect((await handleRepair(new Request(request.url, { method: "POST", headers: request.headers }), f)).status).toBe(405);
  });
  it("bounds stalled publisher work and returns pending without a false receipt", async () => {
    vi.useFakeTimers(); const f = fixture();
    f.publish.mockImplementation(() => new Promise(() => {}));
    const request = new Request("https://worker.invalid/api/enqueue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) });
    const work = handleEnqueue(request, f);
    await vi.advanceTimersByTimeAsync(15_001);
    const response = await work;
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ state: "dispatch_pending" });
  });
  it("bounds a stalled Cron batch and retains backlog rather than reporting completion", async () => {
    vi.useFakeTimers(); const f = fixture(); f.repair.mockImplementation(() => new Promise(() => {}));
    const work = handleRepair(new Request("https://worker.invalid/api/cron/repair-api-text", { headers: { authorization: `Bearer ${f.secret}` } }), f);
    await vi.advanceTimersByTimeAsync(45_001);
    expect(await (await work).json()).toEqual({ error: "repair_incomplete", backlogMayRemain: true });
  });
});

function streamingRequest(chunks: Uint8Array[], options: { cancel?: () => void | PromiseLike<void>; signal?: AbortSignal; close?: boolean; headers?: Record<string, string> } = {}) {
  const cancel = vi.fn(options.cancel ?? (() => {}));
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    if (options.close) controller.close();
  }, cancel });
  const request = new Request("https://worker.invalid/api/enqueue", { method: "POST", body, duplex: "half",
    headers: { "content-type": "application/json", ...options.headers }, signal: options.signal } as RequestInit);
  return { request, cancel };
}
describe("rejected enqueue stream cleanup", () => {
  it.each([new Uint8Array([0xff]), new Uint8Array(2_049)])("cancels invalid UTF-8 or oversized unfinished input once", async chunk => {
    const f = fixture(); const stream = streamingRequest([chunk]);
    expect((await handleEnqueue(stream.request, f)).status).toBe(400);
    expect(stream.cancel).toHaveBeenCalledTimes(1); expect(stream.request.body?.locked).toBe(false);
    expect(f.publish).not.toHaveBeenCalled();
  });
  it.each([{ "content-type": "text/plain" }, { "content-length": "2049" }, { "content-length": "no" }] as Record<string, string>[])("cancels a rejected declared body before reading", async headers => {
    const f = fixture(); const stream = streamingRequest([], { headers });
    expect((await handleEnqueue(stream.request, f)).status).toBe(400);
    expect(stream.cancel).toHaveBeenCalledTimes(1); expect(f.publish).not.toHaveBeenCalled();
  });
  it("cancels a stalled read exactly once at the body deadline", async () => {
    vi.useFakeTimers(); const f = fixture(); const stream = streamingRequest([]);
    const work = handleEnqueue(stream.request, f);
    await vi.advanceTimersByTimeAsync(3_001);
    expect((await work).status).toBe(400); expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("cancels immediately on request abortion without publishing", async () => {
    const controller = new AbortController(); const f = fixture();
    const stream = streamingRequest([], { signal: controller.signal });
    const work = handleEnqueue(stream.request, f);
    await Promise.resolve(); controller.abort();
    expect((await work).status).toBe(400); expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
  });
  it.each([() => Promise.reject(new Error("synthetic cleanup failure")), () => new Promise<void>(() => {})])("does not let rejecting or stalled cancellation change the response", async cancel => {
    const f = fixture(); const stream = streamingRequest([new Uint8Array([0xff])], { cancel });
    expect((await handleEnqueue(stream.request, f)).status).toBe(400);
    expect(stream.cancel).toHaveBeenCalledTimes(1); expect(f.publish).not.toHaveBeenCalled();
  });
  it("never prematurely cancels fully consumed valid input", async () => {
    const f = fixture(); const stream = streamingRequest([new TextEncoder().encode(JSON.stringify(message))], { close: true });
    expect((await handleEnqueue(stream.request, f)).status).toBe(200);
    expect(stream.cancel).not.toHaveBeenCalled(); expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it("does not reinterpret a disconnect after validation as rollback of a publication", async () => {
    const controller = new AbortController(); const f = fixture();
    f.publish.mockImplementation(async (_message, signal) => { controller.abort(); expect(signal.aborted).toBe(false); return { state: "published", messageId: "msg_ok" }; });
    const stream = streamingRequest([new TextEncoder().encode(JSON.stringify(message))], { close: true, signal: controller.signal });
    expect((await handleEnqueue(stream.request, f)).status).toBe(200); expect(f.publish).toHaveBeenCalledTimes(1);
  });
});
