import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStandaloneLiveAdapters, loadStandaloneCapabilities, type LiveLookupBinding } from "@/components/tools/standalone-live-client";
import { type StandaloneCapabilities } from "@/domain/standalone-live-checks";
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = Date.parse("2026-10-13T16:00:00Z");
const capabilities: StandaloneCapabilities = { ownerId, domains: "cloudflare", youtube: true, euipo: true };
const binding = (): LiveLookupBinding => ({ ownerId, isCurrent: () => true, signal: new AbortController().signal });
const signal = () => new AbortController().signal;
const check = { id: "check", domain: "example.com", provider: "cloudflare_registrar", availability: "available", checkedAt: new Date(now).toISOString(), validUntil: new Date(now + 60000).toISOString(), evidenceReference: "proof" };
const quote = { id: "quote", domain: check.domain, provider: check.provider, checkId: check.id, issuedAt: check.checkedAt, expiresAt: check.validUntil, periodYears: 1, total: { amountMinor: 857, currency: "USD" }, renewal: null, renewalTerms: "Annual provider price" };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("private standalone lookup browser adapters", () => {
  it("reads exact capabilities with same-origin/no-store requests and verifies owner", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(capabilities)); vi.stubGlobal("fetch", fetcher);
    await expect(loadStandaloneCapabilities(binding())).resolves.toEqual(capabilities);
    expect(fetcher).toHaveBeenCalledWith("/api/standalone-checks", expect.objectContaining({ credentials: "same-origin", mode: "same-origin", cache: "no-store", method: "GET", redirect: "error" }));
    fetcher.mockResolvedValue(Response.json({ ...capabilities, ownerId: other })); await expect(loadStandaloneCapabilities(binding())).rejects.toThrow("no longer current");
  });
  it("binds returned prices to the exact fresh check and never requests a purchase", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ownerId, result: { status: "domain", check, quote } })); vi.stubGlobal("fetch", fetcher);
    const adapter = createStandaloneLiveAdapters(capabilities, binding()).domains; if (adapter.status !== "ready") throw new Error("fixture adapter");
    await expect(adapter.check(check.domain, signal())).resolves.toEqual(check);
    await expect(adapter.quote!(check.domain, check.id, signal())).resolves.toEqual(quote);
    await expect(adapter.quote!(check.domain, "foreign-check", signal())).rejects.toThrow("No current matching");
    vi.setSystemTime(now + 60000); await expect(adapter.quote!(check.domain, check.id, signal())).rejects.toThrow("No current matching");
    expect(fetcher).toHaveBeenCalledTimes(1); expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ tool: "domains", domain: "example.com" });
    expect(new Headers(fetcher.mock.calls[0]![1].headers).get("X-Embel-Account")).toBe(ownerId);
  });
  it("sends the captured owner on cookie-switch rejection and never retries the lookup", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 401 })); vi.stubGlobal("fetch", fetcher);
    const adapter = createStandaloneLiveAdapters(capabilities, binding()).domains; if (adapter.status !== "ready") throw new Error("fixture adapter");
    await expect(adapter.check(check.domain, signal())).rejects.toThrow("Sign in again");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new Headers(fetcher.mock.calls[0]![1].headers).get("X-Embel-Account")).toBe(ownerId);
    await expect(adapter.quote!(check.domain, check.id, signal())).rejects.toThrow("No current matching");
  });
  it("does not retain stale price evidence after a failed refresh", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ownerId, result: { status: "domain", check, quote } })).mockResolvedValueOnce(Response.json({ ownerId, result: { status: "failed", code: "transport", retryAfterSeconds: null } })); vi.stubGlobal("fetch", fetcher);
    const adapter = createStandaloneLiveAdapters(capabilities, binding()).domains; if (adapter.status !== "ready") throw new Error("fixture adapter");
    await adapter.check(check.domain, signal()); await expect(adapter.check(check.domain, signal())).rejects.toThrow("could not be reached");
    await expect(adapter.quote!(check.domain, check.id, signal())).rejects.toThrow("No current matching");
  });
  it("rejects mismatched domains, owners and providers", async () => {
    for (const response of [{ ownerId: other, result: { status: "domain", check, quote } }, { ownerId, result: { status: "domain", check: { ...check, domain: "other.com" }, quote: null } }, { ownerId, result: { status: "domain", check: { ...check, provider: "other" }, quote: null } }]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response)));
      const adapter = createStandaloneLiveAdapters(capabilities, binding()).domains; if (adapter.status !== "ready") throw new Error("fixture adapter");
      await expect(adapter.check(check.domain, signal())).rejects.toThrow();
    }
  });
  it("does not call providers for unsupported handle platforms", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(await createStandaloneLiveAdapters(capabilities, binding()).handles.check({ platform: "instagram", handle: "fixture" }, signal())).toMatchObject({ outcome: "unavailable", checkedAt: null }); expect(fetcher).not.toHaveBeenCalled();
  });
  it("fences a response after synchronous owner invalidation", async () => {
    let current = true; vi.stubGlobal("fetch", vi.fn(async () => { current = false; return Response.json(capabilities); }));
    await expect(loadStandaloneCapabilities({ ...binding(), isCurrent: () => current })).rejects.toThrow("no longer current");
  });
  it("bounds ignored cancellation, stalled response bodies and oversized JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const controller = new AbortController(); const cancelled = loadStandaloneCapabilities({ ...binding(), signal: controller.signal }); const cancelledAssertion = expect(cancelled).rejects.toThrow("no longer current"); controller.abort(); await cancelledAssertion;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream(), { headers: { "content-type": "application/json" } })));
    const stalled = loadStandaloneCapabilities(binding()); const stalledAssertion = expect(stalled).rejects.toThrow("timed out"); await vi.advanceTimersByTimeAsync(20000); await stalledAssertion;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ padding: "x".repeat(262144) }))); await expect(loadStandaloneCapabilities(binding())).rejects.toThrow("exceeded");
  });
});

describe("Vercel domain browser adapter", () => {
  const vercelCheck = { ...check, provider: "vercel_registrar" };
  const vercelQuote = { ...quote, provider: "vercel_registrar", periodYears: 2, total: { amountMinor: 16000, currency: "USD" }, renewal: { amountMinor: 16000, currency: "USD" }, renewalTerms: "Current renewal total for 2 years; may change" };
  it("exposes the combined lookup price without a second network request", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ownerId, result: { status: "domain", check: vercelCheck, quote: vercelQuote } })); vi.stubGlobal("fetch", fetcher);
    const adapter = createStandaloneLiveAdapters({ ...capabilities, domains: "vercel" }, binding()).domains;
    if (adapter.status !== "ready") throw new Error("fixture adapter");
    expect(adapter.provider).toBe("vercel_registrar"); expect(adapter.quotesWithCheck).toBe(true);
    expect(adapter.description).toContain("Only domain names are sent to Vercel");
    await expect(adapter.check(check.domain, signal())).resolves.toEqual(vercelCheck);
    await expect(adapter.quote!(check.domain, check.id, signal())).resolves.toEqual(vercelQuote);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps ambiguous availability unknown and makes no price available", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ownerId, result: { status: "domain", check: { ...vercelCheck, availability: "unknown" }, quote: null } })));
    const adapter = createStandaloneLiveAdapters({ ...capabilities, domains: "vercel" }, binding()).domains;
    if (adapter.status !== "ready") throw new Error("fixture adapter");
    await expect(adapter.check(check.domain, signal())).resolves.toMatchObject({ availability: "unknown" });
    await expect(adapter.quote!(check.domain, check.id, signal())).rejects.toThrow("No current matching");
  });
  it("discloses the actual provider Retry-After instead of promising a one-minute retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ownerId, result: { status: "failed", code: "rate_limited", retryAfterSeconds: 125 } })));
    const adapter = createStandaloneLiveAdapters({ ...capabilities, domains: "vercel" }, binding()).domains;
    if (adapter.status !== "ready") throw new Error("fixture adapter");
    await expect(adapter.check(check.domain, signal())).rejects.toThrow("Wait 125 seconds");
  });
});

describe("Name.com domain browser adapter", () => {
  const namecomCheck = { ...check, provider: "namecom_core" };
  const namecomQuote = { ...quote, provider: "namecom_core", periodYears: 2, renewal: { amountMinor: 16000, currency: "USD" }, renewalTerms: "Current renewal total for 2 years; future prices may change." };
  it("loads the optional capability and reads the bound quote without another provider call", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...capabilities, domains: "namecom" })));
    await expect(loadStandaloneCapabilities(binding())).resolves.toMatchObject({ domains: "namecom" });
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ownerId, result: { status: "domain", check: namecomCheck, quote: namecomQuote } })); vi.stubGlobal("fetch", fetcher);
    const adapter = createStandaloneLiveAdapters({ ...capabilities, domains: "namecom" }, binding()).domains;
    if (adapter.status !== "ready") throw new Error("fixture adapter");
    expect(adapter.provider).toBe("namecom_core"); expect(adapter.quotesWithCheck).toBe(true);
    expect(adapter.description).toContain("Only domain names are sent to Name.com");
    expect(adapter.description).toContain("Aftermarket");
    await expect(adapter.check(check.domain, signal())).resolves.toEqual(namecomCheck);
    await expect(adapter.quote!(check.domain, check.id, signal())).resolves.toEqual(namecomQuote);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/standalone-checks", expect.objectContaining({ method: "POST", body: JSON.stringify({ tool: "domains", domain: check.domain }) }));
  });
  it("leaves acquisition offers unknown and without a registration quote", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ownerId, result: { status: "domain", check: { ...namecomCheck, availability: "unknown", detail: "Name.com reports an aftermarket offer. Flat acquisition fee: 5000.00 USD." }, quote: null } })));
    const adapter = createStandaloneLiveAdapters({ ...capabilities, domains: "namecom" }, binding()).domains;
    if (adapter.status !== "ready") throw new Error("fixture adapter");
    await expect(adapter.check(check.domain, signal())).resolves.toMatchObject({ availability: "unknown", detail: expect.stringContaining("aftermarket") });
    await expect(adapter.quote!(check.domain, check.id, signal())).rejects.toThrow("No current matching");
  });
  it("accepts a public-registry result only as a price-free confirmation that the domain is taken", async () => {
    const registry = { ...namecomCheck, provider: "Public registry RDAP", availability: "taken", detail: "The authoritative registry returned an exact registration record." };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ownerId, result: { status: "domain", check: registry, quote: null } })));
    const adapter = createStandaloneLiveAdapters({ ...capabilities, domains: "namecom" }, binding()).domains;
    if (adapter.status !== "ready") throw new Error("fixture adapter");
    await expect(adapter.check(check.domain, signal())).resolves.toMatchObject({ provider: "Public registry RDAP", availability: "taken" });
    await expect(adapter.quote!(check.domain, registry.id, signal())).rejects.toThrow("No current matching");
    for (const availability of ["available", "unknown"]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ownerId, result: { status: "domain", check: { ...registry, availability }, quote: null } })));
      await expect(adapter.check(check.domain, signal())).rejects.toThrow("did not match");
    }
  });
  it("rejects sandbox, other-provider and other-owner results", async () => {
    for (const response of [
      { ownerId, result: { status: "domain", check: { ...namecomCheck, provider: "namecom_core_sandbox", availability: "unknown" }, quote: null } },
      { ownerId, result: { status: "domain", check, quote } },
      { ownerId: other, result: { status: "domain", check: namecomCheck, quote: namecomQuote } },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response)));
      const adapter = createStandaloneLiveAdapters({ ...capabilities, domains: "namecom" }, binding()).domains;
      if (adapter.status !== "ready") throw new Error("fixture adapter");
      await expect(adapter.check(check.domain, signal())).rejects.toThrow();
    }
  });
  it("removes stale prices on a failed recheck and fences quotes after owner invalidation", async () => {
    let current = true;
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ownerId, result: { status: "domain", check: namecomCheck, quote: namecomQuote } }))
      .mockResolvedValueOnce(Response.json({ ownerId, result: { status: "failed", code: "not_authorized", retryAfterSeconds: null } }));
    vi.stubGlobal("fetch", fetcher);
    const adapter = createStandaloneLiveAdapters({ ...capabilities, domains: "namecom" }, { ...binding(), isCurrent: () => current }).domains;
    if (adapter.status !== "ready") throw new Error("fixture adapter");
    await adapter.check(check.domain, signal());
    await expect(adapter.check(check.domain, signal())).rejects.toThrow("did not authorize");
    await expect(adapter.quote!(check.domain, check.id, signal())).rejects.toThrow("No current matching");
    current = false;
    await expect(adapter.quote!(check.domain, check.id, signal())).rejects.toThrow("no longer current");
  });
});
