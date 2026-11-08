import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { lookupRdap } from "@/server/standalone-providers/rdap";
import { lookupCloudflare } from "@/server/standalone-providers/cloudflare-live";
import { lookupYoutube } from "@/server/standalone-providers/youtube-live";
import { lookupEuipo } from "@/server/standalone-providers/euipo-live";
import { liveProviderJson } from "@/server/standalone-providers/live-json";
import { standaloneProviderConfig } from "@/server/standalone-providers/live-config";
import { createLookupAdmission, runStandaloneLookup } from "@/server/standalone-providers/live-runtime";
import { quoteBlockReason } from "@/features/domain-workspace/model";
import { type TrademarkTarget } from "@/server/standalone-providers/contracts";
import { clock, NOW, json, noNetwork, signal, accountId } from "./fixtures";

beforeEach(noNetwork);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const registered = { objectClassName: "domain", ldhName: "EXAMPLE.COM", entities: [{ privateRegistrant: "never retained" }] };
describe("credential-free authoritative RDAP reads", () => {
  it("uses the reviewed registry endpoint, records exact registration only and discards contact metadata", async () => {
    const fetcher = vi.fn(async (request: Request) => { expect(request.url).toBe("https://rdap.verisign.com/com/v1/domain/example.com"); expect(request.redirect).toBe("error"); expect(request.cache).toBe("no-store"); return json(registered); });
    const result = await lookupRdap("example.com", fetcher, clock, signal());
    expect(result).toMatchObject({ status: "domain", check: { domain: "example.com", availability: "taken", checkedAt: new Date(NOW).toISOString() }, quote: null });
    expect(JSON.stringify(result)).not.toContain("privateRegistrant"); expect(JSON.stringify(result)).not.toContain("never retained");
  });
  it("preserves unknown for an authoritative RDAP 404", async () => {
    expect(await lookupRdap("example.com", async () => json({ errorCode: 404 }, 404), clock, signal())).toMatchObject({ status: "domain", check: { availability: "unknown" }, quote: null });
    expect(await lookupRdap("example.com", async () => new Response("", { status: 404, headers: { "content-type": "application/rdap+json" } }), clock, signal())).toMatchObject({ status: "domain", check: { availability: "unknown" }, quote: null });
  });
  it.each([403, 429, 500])("never treats HTTP %i as availability", async status => {
    expect(await lookupRdap("example.com", async () => json({ private: "not a record" }, status), clock, signal())).toMatchObject({ status: "failed" });
  });
  it.each([{ objectClassName: "domain", ldhName: "another.com" }, { errorCode: 404 }, { objectClassName: "nameserver", ldhName: "example.com" }])("rejects unmatched or contradictory success evidence", async body => {
    expect(await lookupRdap("example.com", async () => json(body), clock, signal())).toMatchObject({ status: "failed", code: "invalid_response" });
  });
  it.each(["unreviewed.xyz", "sub.example.com", "sub.sub.example.co.uk", "example.io"])("does not send unsupported target %s", async domain => {
    const fetcher = vi.fn(); expect(await lookupRdap(domain, fetcher, clock, signal())).toMatchObject({ status: "failed", code: "unsupported_target" }); expect(fetcher).not.toHaveBeenCalled();
  });
  it("fails closed on an HTTP redirect and cancels an oversized body", async () => {
    expect(await lookupRdap("example.com", async () => new Response(null, { status: 302, headers: { location: "https://evil.test" } }), clock, signal())).toMatchObject({ status: "failed", code: "invalid_response" });
    expect(await lookupRdap("example.com", async () => json({ padding: "x".repeat(262144) }), clock, signal())).toMatchObject({ status: "failed", code: "invalid_response" });
  });
  it("fences a transport that ignores cancellation and the deadline", async () => {
    vi.useFakeTimers(); const controller = new AbortController(); const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const cancelled = lookupRdap("example.com", fetcher, clock, controller.signal); controller.abort();
    await expect(cancelled).resolves.toMatchObject({ status: "failed", code: "cancelled" });
    const timeout = lookupRdap("example.com", fetcher, clock, signal()); await vi.advanceTimersByTimeAsync(15000);
    await expect(timeout).resolves.toMatchObject({ status: "failed", code: "timeout" });
  });
});

const registrarConfig = { accountId, token: "synthetic-private-token" };
const registrarBody = (record: unknown) => ({ success: true, errors: [], messages: [], result: { domains: [record] } });
describe("configured Cloudflare registration eligibility and provider prices", () => {
  it("sends credentials solely to the exact read-only endpoint and binds precise annual prices to the fresh check", async () => {
    const fetcher = vi.fn(async (request: Request) => { expect(request.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/registrar/domain-check`); expect(request.headers.get("Authorization")).toBe("Bearer synthetic-private-token"); expect(await request.json()).toEqual({ domains: ["example.com"] }); return json(registrarBody({ name: "example.com", registrable: true, tier: "standard", pricing: { currency: "USD", registration_cost: "8.57", renewal_cost: "9.2" } })); });
    const result = await lookupCloudflare("example.com", registrarConfig, fetcher, clock, signal());
    expect(result).toMatchObject({ status: "domain", check: { availability: "available" }, quote: { total: { amountMinor: 857, currency: "USD" }, renewal: { amountMinor: 920 }, periodYears: 1 } });
    if (result.status !== "domain" || !result.quote) throw new Error("missing fixture quote");
    expect(quoteBlockReason(result.quote, result.check, NOW)).toBeNull(); expect(quoteBlockReason(result.quote, result.check, NOW + 60000)).toContain("expired");
    expect(JSON.stringify(result)).not.toContain(registrarConfig.token);
  });
  it.each(["domain_unavailable", "domain_premium", "extension_not_supported", "extension_not_supported_via_api", "extension_disallows_registration"])("keeps %s distinct from a registered-domain claim", async reason => {
    expect(await lookupCloudflare("example.com", registrarConfig, async () => json(registrarBody({ name: "example.com", registrable: false, reason })), clock, signal())).toMatchObject({ status: "domain", check: { availability: "unknown" }, quote: null });
  });
  it.each([{ currency: "USD", registration_cost: "8.577", renewal_cost: "9.00" }, { currency: "JPY", registration_cost: "857", renewal_cost: "900" }])("does not round or guess a currency exponent", async pricing => {
    expect(await lookupCloudflare("example.com", registrarConfig, async () => json(registrarBody({ name: "example.com", registrable: true, pricing })), clock, signal())).toMatchObject({ status: "domain", check: { availability: "available" }, quote: null });
  });
});

describe("official YouTube observations", () => {
  it.each([{ items: [] }, { items: [{ kind: "youtube#channel", id: "UCfixture" }] }])("never claims handle availability for found or missing profiles", async ({ items }) => {
    const fetcher = vi.fn(async (request: Request) => { expect(request.headers.get("X-Goog-Api-Key")).toBe("synthetic-key"); expect(request.url).not.toContain("synthetic-key"); return json({ kind: "youtube#channelListResponse", items }); });
    const result = await lookupYoutube({ tool: "handles", platform: "youtube", handle: "example" }, "synthetic-key", fetcher, clock, signal());
    expect(result).toMatchObject({ status: "handle", evidence: { outcome: items.length ? "unknown" : "profile_missing", authority: "platform_api" } });
  });
});

const target: TrademarkTarget = { tool: "trademarks", mark: "Café Fixture", jurisdictions: ["EM", "CA"], niceClasses: [9], mode: "exact_word" };
const euipoConfig = { clientId: "synthetic-id", clientSecret: "synthetic-secret" };
const mark = { applicationNumber: "018692868", wordMarkSpecification: { verbalElement: "Café Fixture" }, niceClasses: [9], status: "REGISTERED" };
const trademarkPage = (trademarks = [mark], patch = {}) => ({ trademarks, size: 100, totalElements: trademarks.length, totalPages: trademarks.length ? 1 : 0, page: 0, ...patch });
describe("official EUIPO search with explicit narrow coverage", () => {
  it("uses a request-local token, exact RSQL name and EU-only records; dataset freshness and legal clearance remain unknown", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (request: Request) => {
      requests.push(request);
      if (requests.length === 1) { expect(request.url).toBe("https://euipo.europa.eu/cas-server-webapp/oidc/accessToken"); expect(new URLSearchParams(await request.text()).get("scope")).toBe("uid"); return json({ access_token: "synthetic-access", token_type: "Bearer", expires_in: 7200 }); }
      const url = new URL(request.url); expect(url.origin).toBe("https://api.euipo.europa.eu"); expect(url.searchParams.get("query")).toBe("wordMarkSpecification.verbalElement=='Café Fixture';markBasis==EU_TRADEMARK;niceClasses=in=(9)");
      expect(request.headers.get("Authorization")).toBe("Bearer synthetic-access"); return json(trademarkPage());
    });
    const result = await lookupEuipo(target, euipoConfig, fetcher, clock, signal());
    expect(result).toMatchObject({ status: "trademark", research: { searched: ["EM"], missing: ["CA"], completeness: "partial", datasetAsOf: null, legalClearance: "not_assessed", filing: "not_submitted", hits: [{ registryId: "018692868" }] } });
    expect(JSON.stringify(result)).not.toContain("synthetic-access"); expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });
  it("does not dispatch for absent EU coverage or wildcard mark intent", async () => {
    const fetcher = vi.fn();
    for (const input of [{ ...target, jurisdictions: ["CA"] }, { ...target, mark: "Caf*" }]) expect(await lookupEuipo(input, euipoConfig, fetcher, clock, signal())).toMatchObject({ status: "failed", code: "unsupported_target" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves validated first-page hits when a later page is rate limited", async () => {
    const marks = Array.from({ length: 100 }, (_, index) => ({ ...mark, applicationNumber: String(18000000 + index).padStart(9, "0") }));
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "fixture", token_type: "bearer", expires_in: 7200 }))
      .mockResolvedValueOnce(json(trademarkPage(marks, { totalElements: 101, totalPages: 2 })))
      .mockResolvedValueOnce(json({}, 429));
    const result = await lookupEuipo(target, euipoConfig, fetcher, clock, signal());
    expect(result).toMatchObject({ status: "trademark", research: { interrupted: "rate_limited", completeness: "partial" } });
    expect(result.status === "trademark" && result.research.hits).toHaveLength(100);
  });
  it.each([trademarkPage([{ ...mark, wordMarkSpecification: { verbalElement: "Other" } }]), trademarkPage([mark], { page: 1 }), trademarkPage([mark], { totalPages: 3 })])("fails closed on query or pagination mismatch", async page => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "fixture", token_type: "bearer", expires_in: 7200 })).mockResolvedValueOnce(json(page));
    expect(await lookupEuipo(target, euipoConfig, fetcher, clock, signal())).toMatchObject({ status: "failed", code: "invalid_response" });
  });
  it("bounds the complete token+search flow, including a token server that never returns", async () => {
    vi.useFakeTimers();
    const pending = lookupEuipo(target, euipoConfig, () => new Promise<Response>(() => {}), clock, signal()); await vi.advanceTimersByTimeAsync(15000);
    await expect(pending).resolves.toMatchObject({ status: "failed", code: "timeout" });
  });
});

describe("runtime configuration and bounded admission", () => {
  it("requires opt-ins as well as provider-specific credentials", () => {
    expect(standaloneProviderConfig({ FLUID_CLOUDFLARE_ACCOUNT_ID: accountId, FLUID_CLOUDFLARE_API_TOKEN: "secret", FLUID_YOUTUBE_API_KEY: "secret", FLUID_EUIPO_CLIENT_ID: "id", FLUID_EUIPO_CLIENT_SECRET: "secret" })).toEqual({ rdap: true, vercel: true, cloudflare: null, namecom: null, youtube: null, euipo: null });
    expect(standaloneProviderConfig({ FLUID_RDAP_CHECKS_ENABLED: "false", FLUID_YOUTUBE_CHECKS_ENABLED: "true", FLUID_YOUTUBE_API_KEY: "secret" })).toEqual({ rdap: false, vercel: true, cloudflare: null, namecom: null, youtube: { apiKey: "secret" }, euipo: null });
    expect(standaloneProviderConfig({ FLUID_YOUTUBE_CHECKS_ENABLED: "true", FLUID_YOUTUBE_API_KEY: "secret\nheader" }).youtube).toBeNull();
  });
  it("bounds per-owner concurrency, lookups per minute and permits another owner", () => {
    let now = NOW; const admit = createLookupAdmission(() => now), first = admit("owner");
    expect(first).toBeTypeOf("function"); expect(admit("owner")).toBeNull(); const other = admit("other"); expect(other).toBeTypeOf("function"); other!(); first!();
    for (let i = 0; i < 29; i++) admit("owner")!(); expect(admit("owner")).toBeNull(); now += 60000; expect(admit("owner")).toBeTypeOf("function");
  });
  it("never invokes providers when cancellation or admission denies execution", async () => {
    const fetcher = vi.fn(), denied = () => null, controller = new AbortController(); controller.abort();
    await expect(runStandaloneLookup("owner", { tool: "domains", domain: "example.com" }, signal(), { fetch: fetcher, admit: denied })).resolves.toMatchObject({ status: "failed", code: "rate_limited" });
    await expect(runStandaloneLookup("owner", { tool: "domains", domain: "example.com" }, controller.signal, { fetch: fetcher })).resolves.toMatchObject({ status: "failed", code: "cancelled" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("asks the authoritative registry while the registrar is rate limited, and keeps the wait otherwise", async () => {
    const config = { rdap: true, vercel: true, cloudflare: null, namecom: null, youtube: null, euipo: null } as const;
    const registrar = (request: Request) => request.url.startsWith("https://api.vercel.com/") ? new Response("{}", { status: 429, headers: { "retry-after": "30", "content-type": "application/json" } }) : null;
    const taken = vi.fn(async (request: Request) => registrar(request) ?? new Response(JSON.stringify({ objectClassName: "domain", ldhName: "EXAMPLE.COM" }), { status: 200, headers: { "content-type": "application/rdap+json" } }));
    await expect(runStandaloneLookup("owner-taken", { tool: "domains", domain: "example.com" }, signal(), { config, fetch: taken })).resolves.toMatchObject({ status: "domain", quote: null, check: { availability: "taken", provider: "Public registry RDAP" } });
    const down = vi.fn(async (request: Request) => registrar(request) ?? new Response("", { status: 503 }));
    await expect(runStandaloneLookup("owner-down", { tool: "domains", domain: "another.com" }, signal(), { config, fetch: down })).resolves.toMatchObject({ status: "failed", code: "rate_limited" });
  });
  it("does not leak raw transport failures", async () => {
    const result = await liveProviderJson(new Request("https://api.euipo.europa.eu/fixture"), async () => { throw new Error("private-token"); }, clock, signal());
    expect(result).toMatchObject({ status: "failed", code: "transport" }); expect(JSON.stringify(result)).not.toContain("private-token");
  });
});
