import { afterEach, describe, expect, it, vi } from "vitest";
import { handleApiTextQueueRequest } from "../../worker/hosting/consumer";
afterEach(() => vi.useRealTimers());
describe("whole Queue invocation deadline", () => {
  it("includes SDK receive and post-work acknowledgement inside the same 270-second bound", async () => {
    vi.useFakeTimers(); let deliveredSignal: AbortSignal | undefined; let completed: unknown;
    const queue = { handleCallback: (handler: (message: unknown) => Promise<void>) => async () => {
      await handler({ version: 1 });
      return new Promise<Response>(() => {}); // SDK ack/lease cleanup never resolves.
    } };
    const deliver = async (_message: unknown, signal: AbortSignal) => { deliveredSignal = signal; return { disposition: "ack", state: "succeeded" } as const; };
    void handleApiTextQueueRequest(new Request("https://private.invalid"), { queue, deliver }).catch(error => { completed = error; });
    await vi.advanceTimersByTimeAsync(269_999); expect(completed).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2); expect(completed).toBeInstanceOf(Error); expect(deliveredSignal?.aborted).toBe(true);
  });
  it("never starts business work when SDK receive resolves after the whole-handler deadline", async () => {
    vi.useFakeTimers(); let release: (() => void) | undefined;
    const queue = { handleCallback: (handler: (message: unknown) => Promise<void>) => async () => {
      await new Promise<void>(resolve => { release = resolve; });
      await handler({ version: 1 }); return new Response();
    } };
    const deliver = vi.fn(async () => ({ disposition: "ack", state: "succeeded" } as const));
    void handleApiTextQueueRequest(new Request("https://private.invalid"), { queue, deliver }).catch(() => {});
    await vi.advanceTimersByTimeAsync(270_001); release?.(); await vi.advanceTimersByTimeAsync(1);
    expect(deliver).not.toHaveBeenCalled();
  });
  it("retries a busy or infrastructure disposition without acknowledging it", async () => {
    const queue = { handleCallback: (handler: (message: unknown) => Promise<void>) => async () => { await handler({}); return new Response(); } };
    const deliver = async () => ({ disposition: "retry", state: "busy" } as const);
    await expect(handleApiTextQueueRequest(new Request("https://private.invalid"), { queue, deliver })).rejects.toThrow();
  });
});
