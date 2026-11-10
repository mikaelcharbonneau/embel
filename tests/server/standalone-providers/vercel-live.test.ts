import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  lookupVercel,
  VERCEL_DOMAIN_PROVIDER,
  VERCEL_DOMAIN_SOURCE_URL,
} from "@/server/standalone-providers/vercel-live";
import { standaloneProviderConfig } from "@/server/standalone-providers/live-config";
import {
  createLookupAdmission,
  runStandaloneLookup,
  standaloneCapabilities,
} from "@/server/standalone-providers/live-runtime";
import { standaloneCapabilitiesSchema, standaloneLookupResultSchema } from "@/domain/standalone-live-checks";
import { availabilityAt, quoteBlockReason } from "@/features/domain-workspace/model";
import { accountId, clock, json, noNetwork, NOW, signal } from "./fixtures";

beforeEach(noNetwork);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
// Synthetic fixtures exercise the documented contract, not current market prices.
const available = (domain = "example.com", patch = {}) => ({
  domain,
  available: true,
  years: 1,
  price: 11.25,
  renewalPrice: 12.5,
  premium: false,
  ...patch,
});
const body = (record: unknown = available()) => ({ results: [record] });
const owner = "123e4567-e89b-42d3-a456-426614174000";
const invalid = { status: "failed", code: "invalid_response", retryAfterSeconds: null };

describe("public Vercel availability and exact period prices", () => {
  it("sends only the exact domain to the unauthenticated, bounded, no-store search endpoint", async () => {
    const fetcher = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://api.vercel.com/v1/registrar/domains/search");
      expect(request.method).toBe("POST");
      expect(request.headers.get("content-type")).toBe("application/json");
      expect([...request.headers.keys()].sort()).toEqual(["accept", "content-type"]);
      expect(request.credentials).toBe("omit");
      expect(request.redirect).toBe("error");
      expect(request.cache).toBe("no-store");
      expect(await request.json()).toEqual({ domains: ["example.com"] });
      return json(body());
    });
    const result = await runStandaloneLookup(owner, { tool: "domains", domain: "example.com" }, signal(), {
      config: standaloneProviderConfig({}),
      fetch: fetcher,
      clock,
      admit: createLookupAdmission(clock),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "domain",
      check: {
        domain: "example.com",
        provider: VERCEL_DOMAIN_PROVIDER,
        availability: "available",
        checkedAt: new Date(NOW).toISOString(),
        sourceUrl: VERCEL_DOMAIN_SOURCE_URL,
      },
      quote: {
        periodYears: 1,
        total: { amountMinor: 1125, currency: "USD" },
        renewal: { amountMinor: 1250, currency: "USD" },
      },
    });
    expect(standaloneLookupResultSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain(owner);
    if (result.status !== "domain" || !result.quote) throw new Error("Missing fixture quote");
    expect(result.quote.checkId).toBe(result.check.id);
    expect(result.check.validUntil).toBe(new Date(NOW + 60_000).toISOString());
    expect(result.quote.expiresAt).toBe(result.check.validUntil);
    expect(result.check.detail).toContain("not a provider guarantee");
    expect(result.quote.renewalTerms).toContain("not a price guarantee");
    expect(quoteBlockReason(result.quote, result.check, NOW)).toBeNull();
    expect(availabilityAt(result.check, NOW + 60_000)).toBe("unknown");
    expect(quoteBlockReason(result.quote, result.check, NOW + 60_000)).toContain("expired");
  });

  it("retains .ai's two-year payable period for both registration and renewal", async () => {
    const result = await lookupVercel(
      "example.ai",
      async () => json(body(available("example.ai", { years: 2, price: 160, renewalPrice: 180 }))),
      clock,
      signal(),
    );
    expect(result).toMatchObject({
      status: "domain",
      check: { availability: "available" },
      quote: {
        periodYears: 2,
        total: { amountMinor: 16000, currency: "USD" },
        renewal: { amountMinor: 18000, currency: "USD" },
      },
    });
    if (result.status !== "domain" || !result.quote) throw new Error("Missing fixture quote");
    expect(result.quote.renewalTerms).toContain("for 2 years");
  });

  it("keeps premium status distinct from availability", async () => {
    const result = await lookupVercel(
      "example.com",
      async () => json(body(available("example.com", { premium: true, price: 1500.29 }))),
      clock,
      signal(),
    );
    expect(result).toMatchObject({
      status: "domain",
      check: { availability: "available", detail: expect.stringContaining("Premium domain") },
      quote: { total: { amountMinor: 150029 } },
    });
  });

  it("converts decimal cents without binary floating-point rounding and accepts a genuine zero quote", async () => {
    for (const [price, amountMinor] of [
      [0.29, 29],
      [0, 0],
      [1.01, 101],
    ]) {
      expect(
        await lookupVercel(
          "example.com",
          async () => json(body(available("example.com", { price, renewalPrice: price }))),
          clock,
          signal(),
        ),
      ).toMatchObject({ status: "domain", quote: { total: { amountMinor }, renewal: { amountMinor } } });
    }
  });

  it.each(["example.com", "example.unsupported"])(
    "never labels an ambiguous false result for %s as taken",
    async (domain) => {
      const result = await lookupVercel(domain, async () => json(body({ domain, available: false })), clock, signal());
      expect(result).toMatchObject({
        status: "domain",
        check: { availability: "unknown", detail: expect.stringContaining("unavailable or could not confirm") },
        quote: null,
      });
    },
  );

  it.each([
    { available: "true" },
    { years: "2" },
    { years: 0 },
    { years: -1 },
    { years: 1.5 },
    { years: 11 },
    { price: "11.25" },
    { price: -1 },
    { price: null },
    { price: 0.001 },
    { price: Number.MAX_SAFE_INTEGER },
    { renewalPrice: -1 },
    { renewalPrice: "12.5" },
    { renewalPrice: null },
    { renewalPrice: 0.001 },
    { premium: "false" },
    { premium: null },
    { premium: undefined },
    { years: undefined },
    { price: undefined },
    { renewalPrice: undefined },
    { domain: "another.com" },
    { domain: "EXAMPLE.COM" },
  ])(
    "rejects malformed, unrepresentable or mismatched availability without manufacturing a quote: %j",
    async (patch) => {
      expect(
        await lookupVercel("example.com", async () => json(body(available("example.com", patch))), clock, signal()),
      ).toEqual(invalid);
    },
  );

  it.each([
    {},
    { results: [] },
    { results: [available(), available()] },
    { results: [{ domain: "another.com", available: false }] },
    { results: [{ domain: "example.com", available: "false" }] },
    { results: [{ domain: "example.com", available: false, price: 10 }] },
    { results: [available()], next: "https://untrusted.test" },
  ])("fails closed on missing, unsolicited, duplicated or malformed result envelopes: %j", async (response) => {
    expect(await lookupVercel("example.com", async () => json(response), clock, signal())).toEqual(invalid);
  });

  it("rejects non-finite JSON numeric values and does not round them into prices", async () => {
    const response =
      '{"results":[{"domain":"example.com","available":true,"years":1,"price":1e999,"renewalPrice":12,"premium":false}]}';
    expect(
      await lookupVercel(
        "example.com",
        async () => new Response(response, { headers: { "content-type": "application/json" } }),
        clock,
        signal(),
      ),
    ).toEqual(invalid);
  });

  it.each([
    "Example.com",
    "https://example.com",
    "example.com/private",
    "name@example.com",
    "example.com?owner=private",
  ])("rejects noncanonical input %s before dispatch", async (domain) => {
    const fetcher = vi.fn();
    await expect(lookupVercel(domain, fetcher, clock, signal())).rejects.toThrow("Invalid provider target");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Vercel transport and cancellation boundaries", () => {
  it.each([
    [401, "not_authorized"],
    [403, "not_authorized"],
    [500, "transport"],
    [404, "invalid_response"],
  ] as const)("preserves HTTP %s as %s, without a quote", async (status, code) => {
    expect(await lookupVercel("example.com", async () => json(body(), status), clock, signal())).toEqual({
      status: "failed",
      code,
      retryAfterSeconds: null,
    });
  });

  it("honors bounded Retry-After on 429 without retrying the registrar", async () => {
    const fetcher = vi.fn(async (request: Request) =>
      request.url.startsWith("https://api.vercel.com/")
        ? json({ error: "rate limit" }, 429, { "retry-after": "120" })
        : new Response("", { status: 503 }),
    );
    const result = await runStandaloneLookup(owner, { tool: "domains", domain: "example.com" }, signal(), {
      config: standaloneProviderConfig({}),
      fetch: fetcher,
      clock,
      admit: createLookupAdmission(clock),
    });
    expect(result).toEqual({ status: "failed", code: "rate_limited", retryAfterSeconds: 120 });
    // One registrar request; only the authoritative registry may be asked while it waits.
    expect(fetcher.mock.calls.filter(([request]) => request.url.startsWith("https://api.vercel.com/"))).toHaveLength(1);
    expect(
      fetcher.mock.calls.every(([request]) => /^https:\/\/(api\.vercel\.com|rdap\.verisign\.com)\//.test(request.url)),
    ).toBe(true);
  });

  it("enforces provider cooldown for the same and different domains, then permits an explicit retry", async () => {
    let now = NOW;
    const localClock = () => now;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429, { "retry-after": "120" }))
      .mockResolvedValueOnce(json(body(available("another.com"))));
    expect(await lookupVercel("example.com", fetcher, localClock, signal())).toEqual({
      status: "failed",
      code: "rate_limited",
      retryAfterSeconds: 120,
    });
    expect(await lookupVercel("example.com", fetcher, localClock, signal())).toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 120,
    });
    now += 59_500;
    expect(await lookupVercel("another.com", fetcher, localClock, signal())).toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 61,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = NOW + 120_000;
    expect(await lookupVercel("another.com", fetcher, localClock, signal())).toMatchObject({
      status: "domain",
      check: { domain: "another.com", availability: "available" },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "invalid", "-1"])(
    "uses a conservative minute for missing or invalid Retry-After: %s",
    async (retryAfter) => {
      let now = NOW;
      const localClock = () => now;
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(json({}, 429, retryAfter === undefined ? {} : { "retry-after": retryAfter }))
        .mockResolvedValueOnce(json(body()));
      expect(await lookupVercel("example.com", fetcher, localClock, signal())).toMatchObject({
        code: "rate_limited",
        retryAfterSeconds: 60,
      });
      now += 59_999;
      expect(await lookupVercel("example.com", fetcher, localClock, signal())).toMatchObject({
        code: "rate_limited",
        retryAfterSeconds: 1,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      now++;
      expect(await lookupVercel("example.com", fetcher, localClock, signal())).toMatchObject({ status: "domain" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it("honors an HTTP-date Retry-After", async () => {
    let now = NOW;
    const localClock = () => now;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429, { "retry-after": new Date(NOW + 120_000).toUTCString() }))
      .mockResolvedValueOnce(json(body()));
    expect(await lookupVercel("example.com", fetcher, localClock, signal())).toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 120,
    });
    now += 60_000;
    expect(await lookupVercel("another.com", fetcher, localClock, signal())).toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 60,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 60_000;
    expect(await lookupVercel("example.com", fetcher, localClock, signal())).toMatchObject({ status: "domain" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not shorten a provider wait longer than the response schema's one-day display bound", async () => {
    let now = NOW;
    const localClock = () => now;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429, { "retry-after": "90000" }))
      .mockResolvedValueOnce(json(body()));
    expect(await lookupVercel("example.com", fetcher, localClock, signal())).toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 86400,
    });
    now += 86400_000;
    expect(await lookupVercel("another.com", fetcher, localClock, signal())).toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 3600,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 3600_000;
    expect(await lookupVercel("example.com", fetcher, localClock, signal())).toMatchObject({ status: "domain" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("isolates retry deadlines between injected transports and clocks", async () => {
    const localClock = () => NOW;
    const fetcher = vi.fn().mockResolvedValueOnce(json({}, 429)).mockResolvedValueOnce(json(body()));
    expect(await lookupVercel("example.com", fetcher, clock, signal())).toMatchObject({ code: "rate_limited" });
    expect(await lookupVercel("example.com", async () => json(body()), clock, signal())).toMatchObject({
      status: "domain",
    });
    expect(await lookupVercel("example.com", fetcher, localClock, signal())).toMatchObject({ status: "domain" });
    expect(await lookupVercel("example.com", fetcher, clock, signal())).toMatchObject({ code: "rate_limited" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the longest retry deadline from concurrently admitted provider responses", async () => {
    let complete!: (response: Response) => void;
    let now = NOW;
    const localClock = () => now;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValueOnce(json({}, 429, { "retry-after": "120" }));
    const first = lookupVercel("example.com", fetcher, localClock, signal());
    expect(await lookupVercel("another.com", fetcher, localClock, signal())).toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 120,
    });
    now += 10_000;
    complete(json({}, 429, { "retry-after": "1" }));
    await first;
    expect(await lookupVercel("example.com", fetcher, localClock, signal())).toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 110,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    () => new Response(null, { status: 302, headers: { location: "https://untrusted.test" } }),
    () => new Response("{broken", { headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify(body()), { headers: { "content-type": "text/html" } }),
    () => json({ padding: "x".repeat(262144) }),
  ])("rejects redirects, invalid JSON/content type and excessive response bytes", async (response) => {
    expect(await lookupVercel("example.com", async () => response(), clock, signal())).toEqual(invalid);
  });

  it("does not leak raw failures containing request data", async () => {
    const result = await lookupVercel(
      "example.com",
      async () => {
        throw new Error("private-owner-or-token");
      },
      clock,
      signal(),
    );
    expect(result).toEqual({ status: "failed", code: "transport", retryAfterSeconds: null });
    expect(JSON.stringify(result)).not.toContain("private-owner-or-token");
  });

  it("does not dispatch an already cancelled lookup", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    expect(await lookupVercel("example.com", fetcher, clock, controller.signal)).toMatchObject({
      status: "failed",
      code: "cancelled",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fences timeout and late success even when the transport ignores abort", async () => {
    vi.useFakeTimers();
    let complete!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const pending = lookupVercel("example.com", fetcher, clock, signal());
    await vi.advanceTimersByTimeAsync(15000);
    await expect(pending).resolves.toEqual({ status: "failed", code: "timeout", retryAfterSeconds: null });
    complete(json(body()));
    await Promise.resolve();
    expect(await pending).toMatchObject({ status: "failed", code: "timeout" });
  });

  it("shares simultaneous reads but cancels subscribers independently and never caches completed prices", async () => {
    let complete!: (response: Response) => void;
    let requestSignal!: AbortSignal;
    const fetcher = vi.fn((request: Request) => {
      requestSignal = request.signal;
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    });
    const controller = new AbortController();
    const first = lookupVercel("example.com", fetcher, clock, controller.signal);
    const second = lookupVercel("example.com", fetcher, clock, signal());
    await Promise.resolve();
    controller.abort();
    await expect(first).resolves.toMatchObject({ status: "failed", code: "cancelled" });
    expect(requestSignal.aborted).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    complete(json(body()));
    await expect(second).resolves.toMatchObject({ status: "domain", check: { availability: "available" } });
    const refresh = lookupVercel("example.com", fetcher, clock, signal());
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(2);
    complete(json(body({ domain: "example.com", available: false })));
    await expect(refresh).resolves.toMatchObject({ status: "domain", check: { availability: "unknown" }, quote: null });
  });

  it("aborts the provider after the final subscriber cancels and permits a fresh lookup", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn((request: Request) => {
      requests.push(request);
      return requests.length === 1 ? new Promise<Response>(() => {}) : Promise.resolve(json(body()));
    });
    const a = new AbortController(),
      b = new AbortController();
    const first = lookupVercel("example.com", fetcher, clock, a.signal),
      second = lookupVercel("example.com", fetcher, clock, b.signal);
    await Promise.resolve();
    a.abort();
    b.abort();
    expect(await first).toMatchObject({ status: "failed", code: "cancelled" });
    expect(await second).toMatchObject({ status: "failed", code: "cancelled" });
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(await lookupVercel("example.com", fetcher, clock, signal())).toMatchObject({ status: "domain" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("bounds the in-flight domain map without issuing excess requests", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const pending = Array.from({ length: 120 }, (_, index) =>
      lookupVercel(`fixture-${index}.com`, fetcher, clock, controller.signal),
    );
    expect(await lookupVercel("over-capacity.com", fetcher, clock, signal())).toEqual({
      status: "failed",
      code: "rate_limited",
      retryAfterSeconds: 60,
    });
    controller.abort();
    await Promise.all(pending);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(120);
  });
});

describe("domain configuration and routing compatibility", () => {
  it("defaults to public Vercel and supports explicit opt-out without borrowing credentials", () => {
    expect(standaloneProviderConfig({ VERCEL_TOKEN: "unused", VERCEL_TEAM_ID: "unused" })).toEqual({
      vercel: true,
      rdap: true,
      cloudflare: null,
      namecom: null,
      youtube: null,
      euipo: null,
    });
    expect(standaloneCapabilities(owner, standaloneProviderConfig({})).domains).toBe("vercel");
    expect(
      standaloneCapabilities(owner, standaloneProviderConfig({ FLUID_VERCEL_DOMAIN_CHECKS_ENABLED: "false" })).domains,
    ).toBe("rdap");
    expect(
      standaloneCapabilities(
        owner,
        standaloneProviderConfig({ FLUID_VERCEL_DOMAIN_CHECKS_ENABLED: "false", FLUID_RDAP_CHECKS_ENABLED: "false" }),
      ).domains,
    ).toBe("unavailable");
    expect(
      standaloneCapabilitiesSchema.safeParse(standaloneCapabilities(owner, standaloneProviderConfig({}))).success,
    ).toBe(true);
  });

  it("retains configured Cloudflare precedence and never falls back to another registrar after failure", async () => {
    const config = standaloneProviderConfig({
      FLUID_CLOUDFLARE_CHECKS_ENABLED: "true",
      FLUID_CLOUDFLARE_ACCOUNT_ID: accountId,
      FLUID_CLOUDFLARE_API_TOKEN: "synthetic-token",
    });
    expect(standaloneCapabilities(owner, config).domains).toBe("cloudflare");
    const fetcher = vi.fn(async (request: Request) => {
      // Only the configured registrar, and while it waits the authoritative registry.
      expect([
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/registrar/domain-check`,
        "https://rdap.verisign.com/com/v1/domain/example.com",
      ]).toContain(request.url);
      return request.url.startsWith("https://rdap.") ? new Response("", { status: 503 }) : json({}, 429);
    });
    expect(
      await runStandaloneLookup(owner, { tool: "domains", domain: "example.com" }, signal(), {
        config,
        fetch: fetcher,
        clock,
        admit: createLookupAdmission(clock),
      }),
    ).toMatchObject({ status: "failed", code: "rate_limited" });
    expect(
      fetcher.mock.calls.filter(([request]) => request.url.startsWith("https://api.cloudflare.com/")),
    ).toHaveLength(1);
  });

  it("routes opt-out to RDAP and preserves the all-disabled gate", async () => {
    const config = standaloneProviderConfig({ FLUID_VERCEL_DOMAIN_CHECKS_ENABLED: "false" });
    const fetcher = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://rdap.verisign.com/com/v1/domain/example.com");
      return json({ objectClassName: "domain", ldhName: "EXAMPLE.COM" });
    });
    expect(
      await runStandaloneLookup(owner, { tool: "domains", domain: "example.com" }, signal(), {
        config,
        fetch: fetcher,
        clock,
        admit: createLookupAdmission(clock),
      }),
    ).toMatchObject({ status: "domain", check: { availability: "taken" }, quote: null });
    expect(
      await runStandaloneLookup(owner, { tool: "domains", domain: "example.com" }, signal(), {
        config: { ...config, rdap: false },
        fetch: fetcher,
        clock,
        admit: createLookupAdmission(clock),
      }),
    ).toMatchObject({ status: "failed", code: "unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retains owner admission ahead of deduplication and releases it on provider failure", async () => {
    const config = standaloneProviderConfig({}),
      admit = createLookupAdmission(clock);
    const controller = new AbortController();
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const first = runStandaloneLookup(owner, { tool: "domains", domain: "example.com" }, controller.signal, {
      config,
      fetch: fetcher,
      clock,
      admit,
    });
    expect(
      await runStandaloneLookup(owner, { tool: "domains", domain: "example.com" }, signal(), {
        config,
        fetch: fetcher,
        clock,
        admit,
      }),
    ).toMatchObject({ status: "failed", code: "rate_limited" });
    controller.abort();
    await first;
    expect(
      await runStandaloneLookup(owner, { tool: "domains", domain: "example.com" }, signal(), {
        config,
        fetch: async () => json(body()),
        clock,
        admit,
      }),
    ).toMatchObject({ status: "domain" });
  });
});
