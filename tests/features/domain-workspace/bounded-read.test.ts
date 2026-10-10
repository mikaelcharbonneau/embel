import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedDomainRead, DomainReadCancelled, DomainReadTimeout } from "../../../src/features/domain-workspace/bounded-read";

afterEach(() => vi.useRealTimers());
describe("bounded registrar reads", () => {
  it("settles a never-returning adapter at the deadline and aborts it", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = boundedDomainRead(() => new Promise(() => {}), controller);
    const assertion = expect(result).rejects.toBeInstanceOf(DomainReadTimeout);
    await vi.advanceTimersByTimeAsync(15_000); await assertion;
    expect(controller.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("settles cancellation even if an adapter ignores it, consuming late rejection", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let rejectLate!: (error: Error) => void;
    const result = boundedDomainRead(() => new Promise((_, reject) => { rejectLate = reject; }), controller);
    await Promise.resolve();
    const assertion = expect(result).rejects.toBeInstanceOf(DomainReadCancelled);
    controller.abort(); await assertion;
    rejectLate(new Error("late failure")); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not dispatch an already cancelled read", async () => {
    const read = vi.fn(); const controller = new AbortController(); controller.abort();
    await expect(boundedDomainRead(read, controller)).rejects.toBeInstanceOf(DomainReadCancelled);
    expect(read).not.toHaveBeenCalled();
  });
  it("returns completed values and transport failures without retaining timers", async () => {
    vi.useFakeTimers();
    await expect(boundedDomainRead(async () => "verified", new AbortController())).resolves.toBe("verified");
    await expect(boundedDomainRead(async () => { throw new Error("transport"); }, new AbortController())).rejects.toThrow("transport");
    expect(vi.getTimerCount()).toBe(0);
  });
});
