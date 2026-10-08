import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogoCapabilitiesController } from "@/components/identity/logo-capabilities-controller";
import { logoOperationSchema, type LogoOperation } from "@/domain/logo-jobs";
import type { LogoCapabilities } from "@/domain/logo-capabilities";
const ownerId = "00000000-0000-4000-8000-000000000001", projectId = "00000000-0000-4000-8000-000000000002";
const at = Date.parse("2026-10-07T06:00:00Z");
function dto(ready: LogoOperation[] = ["identity.logo_vectorize"], observed = at, lifetime = 30_000): LogoCapabilities {
  return { ownerId, projectId, observedAt: new Date(observed).toISOString(), operations: Object.fromEntries(logoOperationSchema.options.map(operation => [operation, ready.includes(operation) ? { status: "available", expiresAt: new Date(observed + lifetime).toISOString() } : { status: "unavailable" }])) as LogoCapabilities["operations"] };
}
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
afterEach(() => vi.useRealTimers());
function setup(read: (signal?: AbortSignal) => Promise<LogoCapabilities | null> = async () => dto()) {
  let wall = at, monotonic = 100, current = true;
  const client = { getLogoCapabilities: read };
  const controller = createLogoCapabilitiesController({ client, ownerId, projectId, isCurrent: () => current, wallNow: () => wall, monotonicNow: () => monotonic });
  return { controller, advance(ms: number) { wall += ms; monotonic += ms; }, wall(ms: number) { wall = ms; }, monotonic(ms: number) { monotonic = ms; }, foreign() { current = false; } };
}
describe("fresh owner-scoped operation readiness", () => {
  it("keeps vector-only availability independent from the other four operations", async () => {
    const s = setup(); await s.controller.refresh();
    expect(s.controller.isAvailable("identity.logo_vectorize")).toBe(true);
    for (const operation of logoOperationSchema.options.filter(value => value !== "identity.logo_vectorize")) expect(s.controller.isAvailable(operation)).toBe(false);
    s.controller.dispose();
  });
  it("subtracts the whole request round trip and expires synchronously with delayed timers", async () => {
    const response = deferred<LogoCapabilities | null>(), s = setup(() => response.promise);
    const reading = s.controller.refresh(); s.advance(12_000); response.resolve(dto()); await reading;
    s.advance(11_999); expect(s.controller.isAvailable("identity.logo_vectorize")).toBe(true);
    s.advance(1); expect(s.controller.isAvailable("identity.logo_vectorize")).toBe(false);
    s.controller.dispose();
  });
  it("does not extend lifetime when the wall clock moves backwards", async () => {
    const s = setup(); await s.controller.refresh(); s.wall(at - 60_000); s.monotonic(30_100);
    expect(s.controller.isAvailable("identity.logo_vectorize")).toBe(false); s.controller.dispose();
  });
  it("fails closed for stale, implausibly future or slow responses", async () => {
    for (const observed of [at - 31_000, at + 60_000]) {
      const s = setup(async () => dto(undefined, observed)); await s.controller.refresh(); expect(s.controller.isAvailable("identity.logo_vectorize")).toBe(false); s.controller.dispose();
    }
    const response = deferred<LogoCapabilities | null>(), s = setup(() => response.promise);
    const reading = s.controller.refresh(); s.advance(31_000); response.resolve(dto()); await reading;
    expect(s.controller.isAvailable("identity.logo_vectorize")).toBe(false); s.controller.dispose();
  });
  it("expires short operations independently while another stays ready", async () => {
    vi.useFakeTimers(); const value = dto(["identity.logo_vectorize", "identity.logo_directions"]);
    value.operations["identity.logo_vectorize"] = { status: "available", expiresAt: new Date(at + 8000).toISOString() };
    const s = setup(async () => value); await s.controller.refresh(); s.advance(2000); await vi.advanceTimersByTimeAsync(2000);
    expect(s.controller.getSnapshot().available["identity.logo_vectorize"]).toBe(false);
    expect(s.controller.isAvailable("identity.logo_directions")).toBe(true); s.controller.dispose();
  });
  it("fences owner change before a response and aborts requests on disposal", async () => {
    const response = deferred<LogoCapabilities | null>(); let signal: AbortSignal | undefined;
    const s = setup(input => { signal = input; return response.promise; }); const pending = s.controller.refresh(); await Promise.resolve();
    s.foreign(); expect(s.controller.getSnapshot().status).toBe("unverified"); expect(s.controller.isAvailable("identity.logo_vectorize")).toBe(false);
    s.controller.dispose(); expect(signal?.aborted).toBe(true); response.resolve(dto()); await pending;
    expect(s.controller.isAvailable("identity.logo_vectorize")).toBe(false);
  });
  it("bounds stuck reads and ignores their later success", async () => {
    vi.useFakeTimers(); const response = deferred<LogoCapabilities | null>(); let signal: AbortSignal | undefined;
    const s = setup(input => { signal = input; return response.promise; }); const pending = s.controller.refresh();
    s.advance(8000); await vi.advanceTimersByTimeAsync(8000); await pending;
    expect(signal?.aborted).toBe(true); expect(s.controller.getSnapshot().status).toBe("unavailable");
    response.resolve(dto()); await Promise.resolve(); expect(s.controller.isAvailable("identity.logo_vectorize")).toBe(false); s.controller.dispose();
  });
  it("polls only the read endpoint and stops on disposal", async () => {
    vi.useFakeTimers(); let reads = 0; const s = setup(async () => { reads++; return dto(undefined, at + (reads - 1) * 10_000); });
    await s.controller.refresh(); s.advance(10_000); await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBe(2); s.controller.dispose(); s.advance(60_000); await vi.advanceTimersByTimeAsync(60_000); expect(reads).toBe(2);
  });
  it("hides previous availability while loading and after a read failure", async () => {
    let fail = false; const response = deferred<LogoCapabilities | null>(); const s = setup(() => fail ? response.promise : Promise.resolve(dto()));
    await s.controller.refresh(); fail = true; const pending = s.controller.refresh();
    expect(s.controller.isAvailable("identity.logo_vectorize")).toBe(false); expect(s.controller.getSnapshot().status).toBe("loading");
    response.resolve(null); await pending; expect(s.controller.getSnapshot().status).toBe("unavailable"); s.controller.dispose();
  });
});

it("recovers after a synchronous injected transport throw without wedging refresh", async () => {
  let fail = true; const s = setup(() => { if (fail) throw new Error("Synthetic synchronous transport failure"); return Promise.resolve(dto()); });
  await s.controller.refresh(); expect(s.controller.getSnapshot().status).toBe("unavailable"); fail = false;
  await s.controller.refresh(); expect(s.controller.isAvailable("identity.logo_vectorize")).toBe(true); s.controller.dispose();
});


it("never starts a queued capability read after disposal", async () => {
  let reads = 0; const s = setup(async () => { reads++; return dto(); });
  const pending = s.controller.refresh(); s.controller.dispose(); await pending; expect(reads).toBe(0);
});


it("deducts tolerated slow-client skew instead of extending an apparently future snapshot", async () => {
  const s = setup(async () => dto(undefined, at + 4000)); await s.controller.refresh();
  s.advance(23_999); expect(s.controller.isAvailable("identity.logo_vectorize")).toBe(true);
  s.advance(1); expect(s.controller.isAvailable("identity.logo_vectorize")).toBe(false); s.controller.dispose();
});

it("deducts stale observed age as well as skew even when the client clock is behind", async () => {
  const s = setup(async () => dto(undefined, at - 25_000)); s.wall(at - 1000); await s.controller.refresh();
  expect(s.controller.isAvailable("identity.logo_vectorize")).toBe(false); s.controller.dispose();
});
