import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { lookupNamecom, lookupNamecomBatch } from "@/server/standalone-providers/namecom-live";
import { standaloneProviderConfig, type NamecomConfig } from "@/server/standalone-providers/live-config";
import {
  runStandaloneLookup,
  standaloneCapabilities,
  createLookupAdmission,
} from "@/server/standalone-providers/live-runtime";
import { standaloneLookupResultSchema } from "@/domain/standalone-live-checks";
import { quoteBlockReason } from "@/features/domain-workspace/model";
import { clock, NOW, json, noNetwork, signal, accountId } from "./fixtures";

beforeEach(noNetwork);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const config: NamecomConfig = {
  username: "synthetic-user",
  token: "synthetic-private-token",
  environment: "production",
};
const owner = "11111111-1111-4111-8111-111111111111";
const available = (domainName = "example.com", patch: Record<string, unknown> = {}) => ({
  domainName,
  purchasable: true,
  purchaseType: "registration",
  ...patch,
});
const prices = (patch: Record<string, unknown> = {}) => ({ purchasePrice: 12.99, renewalPrice: 15.49, ...patch });
function transport(record: Record<string, unknown> = available(), pricing: Record<string, unknown> = prices()) {
  return vi.fn(async (request: Request) => (request.method === "POST" ? json({ results: [record] }) : json(pricing)));
}

describe("Name.com CORE exact registration discovery and term pricing", () => {
  it("uses only literal-colon fixed read endpoints, Basic auth, explicit term and exact USD totals", async () => {
    const fetcher = transport();
    const result = await lookupNamecom("example.com", config, fetcher, clock, signal());
    expect(result).toMatchObject({
      status: "domain",
      check: { provider: "namecom_core", availability: "available", domain: "example.com" },
      quote: {
        periodYears: 1,
        total: { amountMinor: 1299, currency: "USD" },
        renewal: { amountMinor: 1549, currency: "USD" },
      },
    });
    expect(fetcher.mock.calls.map(([request]) => request.url)).toEqual([
      "https://api.name.com/core/v1/domains:checkAvailability",
      "https://api.name.com/core/v1/domains/example.com:getPricing?years=1",
    ]);
    expect(await fetcher.mock.calls[0]![0].json()).toEqual({ domainNames: ["example.com"] });
    expect(fetcher.mock.calls[1]![0].body).toBeNull();
    for (const [request] of fetcher.mock.calls) {
      expect(request.headers.get("Authorization")).toBe(
        `Basic ${Buffer.from(`${config.username}:${config.token}`).toString("base64")}`,
      );
      expect(request.redirect).toBe("error");
      expect(request.cache).toBe("no-store");
      expect(request.credentials).toBe("omit");
    }
    expect(JSON.stringify(result)).not.toContain(config.token);
    expect(JSON.stringify(result)).not.toContain(config.username);
    expect(standaloneLookupResultSchema.safeParse(result).success).toBe(true);
    if (result.status !== "domain" || !result.quote) throw new Error("fixture quote");
    expect(quoteBlockReason(result.quote, result.check, NOW)).toBeNull();
    expect(quoteBlockReason(result.quote, result.check, NOW + 60_000)).toContain("expired");
    expect(result.quote.renewalTerms).toContain("exclude tax");
  });
  it("explicitly prices .ai for two years, uses returned premium totals, never multiplies discovery prices", async () => {
    const fetcher = transport(
      available("example.ai", { premium: true, purchasePrice: 50, renewalPrice: 30 }),
      prices({ premium: true, purchasePrice: 160.25, renewalPrice: 180.5 }),
    );
    const result = await lookupNamecom("example.ai", config, fetcher, clock, signal());
    expect(fetcher.mock.calls[1]![0].url).toBe("https://api.name.com/core/v1/domains/example.ai:getPricing?years=2");
    expect(result).toMatchObject({
      status: "domain",
      check: { availability: "available", detail: expect.stringContaining("Registry premium") },
      quote: {
        periodYears: 2,
        total: { amountMinor: 16025 },
        renewal: { amountMinor: 18050 },
        renewalTerms: expect.stringContaining("for 2 years"),
      },
    });
  });
  it("accepts explicit zero prices without inventing omitted prices", async () => {
    expect(
      await lookupNamecom(
        "example.com",
        config,
        transport(available(), prices({ purchasePrice: 0, renewalPrice: 0 })),
        clock,
        signal(),
      ),
    ).toMatchObject({ status: "domain", quote: { total: { amountMinor: 0 }, renewal: { amountMinor: 0 } } });
    expect(
      await lookupNamecom("example.com", config, transport(available(), { renewalPrice: 15 }), clock, signal()),
    ).toMatchObject({ status: "failed", code: "invalid_response" });
  });
  it("supports null renewal while retaining the correctly priced registration term", async () => {
    expect(
      await lookupNamecom(
        "example.com",
        config,
        transport(available(), prices({ renewalPrice: null })),
        clock,
        signal(),
      ),
    ).toMatchObject({
      status: "domain",
      check: { availability: "available" },
      quote: { renewal: null, renewalTerms: expect.stringContaining("Renewal unavailable for 1 year") },
    });
  });
  it("keeps a null registration price unknown and never falls back to discovery price or another term", async () => {
    const fetcher = transport(available("example.ai", { purchasePrice: 99 }), prices({ purchasePrice: null }));
    expect(await lookupNamecom("example.ai", config, fetcher, clock, signal())).toMatchObject({
      status: "domain",
      check: { availability: "unknown", detail: expect.stringContaining("2-year term") },
      quote: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["aftermarket_i", "aftermarket_s", "aftermarket_b", "expiring", "backorder"])(
    "does not confuse %s with new registration or use registration pricing",
    async (purchaseType) => {
      const fetcher = transport(
        available("example.ai", { purchaseType, purchasePrice: 5000.01, renewalPrice: 999, premium: true }),
      );
      const result = await lookupNamecom("example.ai", config, fetcher, clock, signal());
      expect(result).toMatchObject({
        status: "domain",
        check: { availability: "unknown", detail: expect.stringContaining("5000.01 USD") },
        quote: null,
      });
      if (result.status !== "domain") throw new Error("fixture result");
      expect(result.check.detail).toContain(purchaseType);
      expect(result.check.detail).toContain("registration length and renewal terms are unverified");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("never invents a free acquisition fee if the discovery price is absent", async () => {
    const result = await lookupNamecom(
      "example.com",
      config,
      transport(available("example.com", { purchaseType: "aftermarket_i" })),
      clock,
      signal(),
    );
    expect(result).toMatchObject({
      status: "domain",
      check: { availability: "unknown", detail: expect.stringContaining("Acquisition price unavailable") },
      quote: null,
    });
  });
  it.each([
    { domainName: "example.com" },
    { domainName: "example.com", purchasable: false },
    { domainName: "example.com", purchasable: true },
  ])("accepts documented false/empty omissions conservatively: %j", async (record) => {
    const fetcher = vi.fn(async () => json({ results: [record] }));
    expect(await lookupNamecom("example.com", config, fetcher, clock, signal())).toMatchObject({
      status: "domain",
      check: { availability: "unknown" },
      quote: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("discards free-text provider reasons and never establishes taken from an unpurchasable response", async () => {
    const fetcher = vi.fn(async () =>
      json({ results: [{ domainName: "example.com", reason: "private provider details and instructions" }] }),
    );
    const result = await lookupNamecom("example.com", config, fetcher, clock, signal());
    expect(result).toMatchObject({ status: "domain", check: { availability: "unknown" } });
    expect(JSON.stringify(result)).not.toContain("private provider details");
  });
  it("accepts 50 unordered exact results, preserves input order and domain-specific evidence IDs", async () => {
    const domains = Array.from({ length: 50 }, (_, i) => `example${i}.com`);
    const fetcher = vi.fn(async (request: Request) => {
      expect(await request.json()).toEqual({ domainNames: domains });
      return json({ results: [...domains].reverse().map((domainName) => ({ domainName })) });
    });
    const result = await lookupNamecomBatch(domains, config, fetcher, clock, signal());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.map((item) => (item.status === "domain" ? item.check.domain : null))).toEqual(domains);
    expect(new Set(result.map((item) => (item.status === "domain" ? item.check.id : null))).size).toBe(50);
  });
  it.each(
    [
      [],
      Array.from({ length: 51 }, (_, i) => `example${i}.com`),
      ["example.com", "example.com"],
      ["https://example.com"],
      ["example.com/secret"],
    ].map((domains) => ({ domains })),
  )("rejects invalid/oversized/duplicate input before any request: %j", async ({ domains }) => {
    const fetcher = vi.fn();
    await expect(lookupNamecomBatch(domains, config, fetcher, clock, signal())).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { results: [] },
    { results: [available("other.com")] },
    { results: [available(), available()] },
    { results: [available(), available("other.com")] },
    { results: [{ domainName: "EXAMPLE.COM" }] },
    { results: [available("example.com", { purchasable: "true" })] },
    { results: [available("example.com", { purchaseType: "new_unknown_type" })] },
    { results: [available("example.com", { purchasePrice: -1 })] },
  ])("rejects mismatched, duplicate or malformed discovery: %j", async (body) => {
    const fetcher = vi.fn(async () => json(body));
    expect(await lookupNamecom("example.com", config, fetcher, clock, signal())).toMatchObject({
      status: "failed",
      code: "invalid_response",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    prices({ premium: true }),
    prices({ purchasePrice: 1.005 }),
    prices({ renewalPrice: 1.005 }),
    prices({ purchasePrice: -1 }),
    prices({ purchasePrice: "12.99" }),
    prices({ purchasePrice: 1e21 }),
    prices({ purchasePrice: 90071992547409.92 }),
    { purchasePrice: 12 },
    {},
  ])("rejects inconsistent, missing or inexact registration pricing: %j", async (pricing) => {
    expect(await lookupNamecom("example.com", config, transport(available(), pricing), clock, signal())).toMatchObject({
      status: "failed",
      code: "invalid_response",
    });
  });
  it("rejects sub-cent acquisition prices rather than rounding", async () => {
    expect(
      await lookupNamecom(
        "example.com",
        config,
        transport(available("example.com", { purchaseType: "aftermarket_i", purchasePrice: 1.005 })),
        clock,
        signal(),
      ),
    ).toMatchObject({ status: "failed", code: "invalid_response" });
  });
  it.each(["70368744177664.01", "12.990000000000000000001", "1e-324", "1e2", "-0", "90071992547409.91"])(
    "rejects lossy/sub-cent/exponent money lexemes before JSON.parse: %s",
    async (raw) => {
      const fetcher = vi.fn(async (request: Request) =>
        request.method === "POST"
          ? json({ results: [available()] })
          : new Response(`{"purchasePrice":${raw},"renewalPrice":12.99}`, {
              headers: { "content-type": "application/json" },
            }),
      );
      expect(await lookupNamecom("example.com", config, fetcher, clock, signal())).toMatchObject({
        status: "failed",
        code: "invalid_response",
      });
    },
  );
  it("also validates raw acquisition and renewal money while ignoring numeric-looking strings", async () => {
    const acquisition = async () =>
      new Response(
        '{"results":[{"domainName":"example.com","purchasable":true,"purchaseType":"aftermarket_i","purchasePrice":70368744177664.01}]}',
        { headers: { "content-type": "application/json" } },
      );
    expect(await lookupNamecom("example.com", config, acquisition, clock, signal())).toMatchObject({
      status: "failed",
      code: "invalid_response",
    });
    const renewal = async (request: Request) =>
      request.method === "POST"
        ? json({ results: [available("example.com", { reason: 'untrusted 1e-324 \\"12.990000000000001"' })] })
        : new Response('{"purchasePrice":12.99,"renewalPrice":1e-324}', {
            headers: { "content-type": "application/json" },
          });
    expect(await lookupNamecom("example.com", config, renewal, clock, signal())).toMatchObject({
      status: "failed",
      code: "invalid_response",
    });
    expect(
      await lookupNamecom(
        "example.com",
        config,
        transport(available("example.com", { reason: 'untrusted 1e-324 \\"12.990000000000001"' })),
        clock,
        signal(),
      ),
    ).toMatchObject({ status: "domain", check: { availability: "available" } });
  });
  it("labels sandbox simulations unknown and never issues live prices", async () => {
    const fetcher = transport();
    expect(
      await lookupNamecom(
        "example.com",
        { ...config, username: "synthetic-user-test", environment: "sandbox" },
        fetcher,
        clock,
        signal(),
      ),
    ).toMatchObject({
      status: "domain",
      check: {
        provider: "namecom_core_sandbox",
        availability: "unknown",
        detail: expect.stringContaining("sandbox simulation"),
      },
      quote: null,
    });
    expect(fetcher.mock.calls[0]![0].url).toBe("https://api.dev.name.com/core/v1/domains:checkAvailability");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("Name.com transport safety, cancellation and provider rate limits", () => {
  it.each([
    [401, "not_authorized"],
    [403, "not_authorized"],
    [429, "rate_limited"],
    [500, "transport"],
    [400, "invalid_response"],
    [404, "invalid_response"],
    [422, "invalid_response"],
  ] as const)("keeps HTTP %s unknown without exposing errors or retrying", async (status, code) => {
    const fetcher = vi.fn(async () => json({ message: config.token }, status));
    const result = await lookupNamecom("example.com", config, fetcher, clock, signal());
    expect(result).toMatchObject({ status: "failed", code });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(config.token);
  });
  it("does not fall back to discovery prices when the pricing request fails", async () => {
    const fetcher = vi.fn(async (request: Request) =>
      request.method === "POST"
        ? json({ results: [available("example.com", { purchasePrice: 10 })] })
        : json({ message: "private" }, 503),
    );
    expect(await lookupNamecom("example.com", config, fetcher, clock, signal())).toMatchObject({
      status: "failed",
      code: "transport",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    () =>
      new Response("{}", {
        status: 302,
        headers: { location: "https://other.test", "content-type": "application/json" },
      }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () => new Response("{", { headers: { "content-type": "application/json" } }),
    () => new Response(" ".repeat(262145), { headers: { "content-type": "application/json" } }),
  ])("refuses redirects, non-JSON, malformed and oversized responses", async (makeResponse) => {
    const fetcher = vi.fn(async () => makeResponse());
    expect(await lookupNamecom("example.com", config, fetcher, clock, signal())).toMatchObject({
      status: "failed",
      code: "invalid_response",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("fences an unexpected final response URL", async () => {
    const response = json({ results: [available()] });
    Object.defineProperty(response, "url", { value: "https://other.test" });
    expect(await lookupNamecom("example.com", config, async () => response, clock, signal())).toMatchObject({
      status: "failed",
      code: "invalid_response",
    });
  });
  it("sanitizes thrown errors", async () => {
    const result = await lookupNamecom(
      "example.com",
      config,
      async () => {
        throw new Error(config.token);
      },
      clock,
      signal(),
    );
    expect(result).toMatchObject({ status: "failed", code: "transport" });
    expect(JSON.stringify(result)).not.toContain(config.token);
  });
  it("rejects invalid Basic credentials and hosts before transmission", async () => {
    const fetcher = vi.fn();
    for (const bad of [
      { ...config, username: "user:other" },
      { ...config, token: "unsafe\nheader" },
      { ...config, environment: "https://other.test" },
    ]) {
      expect(await lookupNamecom("example.com", bad as NamecomConfig, fetcher, clock, signal())).toMatchObject({
        status: "failed",
        code: "unavailable",
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("never starts an already-cancelled lookup", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    expect(await lookupNamecom("example.com", config, fetcher, clock, controller.signal)).toMatchObject({
      status: "failed",
      code: "cancelled",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds the entire discovery plus pricing flow to 15 seconds even when transport ignores abort", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return json({ results: [available()] });
      }
      return new Promise<Response>(() => {});
    });
    const pending = lookupNamecom("example.com", config, fetcher, clock, signal());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ status: "failed", code: "timeout" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]).toBeDefined();
  });
  it("fences caller cancellation during pricing and discards late success", async () => {
    const controller = new AbortController();
    let release!: (response: Response) => void;
    const fetcher = vi.fn(async (request: Request) =>
      request.method === "POST"
        ? json({ results: [available()] })
        : new Promise<Response>((resolve) => {
            release = resolve;
          }),
    );
    const pending = lookupNamecom("example.com", config, fetcher, clock, controller.signal);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    controller.abort();
    expect(await pending).toMatchObject({ status: "failed", code: "cancelled" });
    expect(fetcher.mock.calls[1]![0].signal.aborted).toBe(true);
    release(json(prices()));
  });
  it.each(["120", new Date(NOW + 120_000).toUTCString()])(
    "honors Retry-After %s across domains with no automatic retry",
    async (retry) => {
      let now = NOW;
      const ticking = () => now;
      const fetcher = vi.fn(async () => json({ message: "rate limit" }, 429, { "retry-after": retry }));
      expect(await lookupNamecom("example.com", config, fetcher, ticking, signal())).toMatchObject({
        status: "failed",
        code: "rate_limited",
        retryAfterSeconds: 120,
      });
      now += 60_000;
      expect(await lookupNamecom("other.com", config, fetcher, ticking, signal())).toMatchObject({
        status: "failed",
        code: "rate_limited",
        retryAfterSeconds: 60,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      now += 60_000;
      await lookupNamecom("other.com", config, fetcher, ticking, signal());
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
});

describe("optional Name.com selection preserves existing live providers", () => {
  const env = { FLUID_NAMECOM_USERNAME: config.username, FLUID_NAMECOM_API_TOKEN: config.token };
  it.each([undefined, "false", "TRUE", "1"])("is disabled without an exact explicit true flag (%s)", (flag) => {
    const settings = standaloneProviderConfig({ ...env, FLUID_NAMECOM_CHECKS_ENABLED: flag });
    expect(settings.namecom).toBeNull();
    expect(standaloneCapabilities(owner, settings).domains).toBe("vercel");
  });
  it.each([
    { FLUID_NAMECOM_USERNAME: undefined },
    { FLUID_NAMECOM_API_TOKEN: undefined },
    { FLUID_NAMECOM_ENVIRONMENT: "sandbox" },
    { FLUID_NAMECOM_ENVIRONMENT: "invalid" },
    { FLUID_NAMECOM_USERNAME: "invalid:user" },
  ])("fails closed for missing/malformed credentials and nonproduction environments: %j", (patch) => {
    const settings = standaloneProviderConfig({ ...env, FLUID_NAMECOM_CHECKS_ENABLED: "true", ...patch });
    expect(settings.namecom).toBeNull();
    expect(standaloneCapabilities(owner, settings).domains).toBe("vercel");
  });
  it("keeps Cloudflare → Vercel → RDAP precedence when Name.com is disabled", () => {
    const settings = standaloneProviderConfig({
      ...env,
      FLUID_CLOUDFLARE_CHECKS_ENABLED: "true",
      FLUID_CLOUDFLARE_ACCOUNT_ID: accountId,
      FLUID_CLOUDFLARE_API_TOKEN: "synthetic",
    });
    expect(standaloneCapabilities(owner, settings).domains).toBe("cloudflare");
    expect(standaloneCapabilities(owner, { ...settings, cloudflare: null }).domains).toBe("vercel");
    expect(standaloneCapabilities(owner, { ...settings, cloudflare: null, vercel: false }).domains).toBe("rdap");
    expect(standaloneCapabilities(owner, { ...settings, cloudflare: null, vercel: false, rdap: false }).domains).toBe(
      "unavailable",
    );
  });
  it("selects enabled valid production Name.com consistently for capabilities and execution", async () => {
    const settings = standaloneProviderConfig({ ...env, FLUID_NAMECOM_CHECKS_ENABLED: "true" });
    expect(settings.namecom).toEqual(config);
    expect(standaloneCapabilities(owner, settings)).toEqual({
      ownerId: owner,
      domains: "namecom",
      youtube: false,
      euipo: false,
    });
    const fetcher = transport();
    expect(
      await runStandaloneLookup(owner, { tool: "domains", domain: "example.com" }, signal(), {
        config: settings,
        fetch: fetcher,
        clock,
        admit: createLookupAdmission(clock),
      }),
    ).toMatchObject({ status: "domain", check: { provider: "namecom_core", availability: "available" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("never falls through to a different provider on Name.com failure", async () => {
    const settings = standaloneProviderConfig({ ...env, FLUID_NAMECOM_CHECKS_ENABLED: "true" });
    const fetcher = vi.fn(async () => json({}, 403));
    expect(
      await runStandaloneLookup(owner, { tool: "domains", domain: "example.com" }, signal(), {
        config: settings,
        fetch: fetcher,
        clock,
        admit: createLookupAdmission(clock),
      }),
    ).toMatchObject({ status: "failed", code: "not_authorized" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  describe("registry confirmation of unregistrable domains", () => {
    const settings = () => standaloneProviderConfig({ ...env, FLUID_NAMECOM_CHECKS_ENABLED: "true" });
    const routed = (record: Record<string, unknown>, registry: "registered" | "missing") =>
      vi.fn(async (request: Request) =>
        request.url.startsWith("https://rdap.verisign.com/")
          ? registry === "registered"
            ? json({ objectClassName: "domain", ldhName: "EXAMPLE.COM" })
            : json({ errorCode: 404 }, 404)
          : json({ results: [record] }),
      );
    const run = (fetcher: ReturnType<typeof routed>) =>
      runStandaloneLookup(owner, { tool: "domains", domain: "example.com" }, signal(), {
        config: settings(),
        fetch: fetcher,
        clock,
        admit: createLookupAdmission(clock),
      });
    it("reports Taken from the registry when Name.com cannot sell an existing registration", async () => {
      const fetcher = routed(available("example.com", { purchasable: false }), "registered");
      const result = await run(fetcher);
      expect(result).toMatchObject({
        status: "domain",
        quote: null,
        check: {
          provider: "Public registry RDAP",
          availability: "taken",
          sourceUrl: "https://rdap.verisign.com/com/v1/domain/example.com",
        },
      });
      expect(standaloneLookupResultSchema.safeParse(result).success).toBe(true);
      expect(fetcher.mock.calls.map(([request]) => request.url)).toEqual([
        "https://api.name.com/core/v1/domains:checkAvailability",
        "https://rdap.verisign.com/com/v1/domain/example.com",
      ]);
    });
    it("keeps the resale offer in front of the registry evidence", async () => {
      const result = await run(
        routed(available("example.com", { purchaseType: "aftermarket_b", purchasePrice: 2873.85 }), "registered"),
      );
      if (result.status !== "domain") throw new Error("fixture result");
      expect(result.check.availability).toBe("taken");
      expect(result.quote).toBeNull();
      expect(result.check.detail).toMatch(
        /^Not available as a new registration: Name\.com lists it for resale by its current owner for 2873\.85 USD before tax\./u,
      );
      expect(result.check.detail).toContain("Listing type: aftermarket_b.");
      expect(result.check.detail).toContain("The authoritative registry returned an exact registration record.");
    });
    it("keeps Name.com's unknown result when the registry has no record", async () => {
      expect(await run(routed(available("example.com", { purchasable: false }), "missing"))).toMatchObject({
        status: "domain",
        check: { provider: "namecom_core", availability: "unknown" },
      });
    });
    it("never consults the registry for an available domain", async () => {
      const fetcher = vi.fn(async (request: Request) =>
        request.method === "POST" ? json({ results: [available()] }) : json(prices()),
      );
      expect(await run(fetcher)).toMatchObject({ check: { provider: "namecom_core", availability: "available" } });
      expect(fetcher.mock.calls.every(([request]) => !request.url.includes("rdap"))).toBe(true);
    });
  });
});
