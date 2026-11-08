import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { lookupDnsDelegation } from "@/server/standalone-providers/dns-delegation";
import { standaloneProviderConfig } from "@/server/standalone-providers/live-config";
import { createLookupAdmission, runStandaloneLookup } from "@/server/standalone-providers/live-runtime";
import { VERCEL_DOMAIN_PROVIDER } from "@/server/standalone-providers/vercel-live";
import { standaloneLookupResultSchema } from "@/domain/standalone-live-checks";
import { acceptedDomainCheckProvider, DNS_DOMAIN_PROVIDER, REGISTRY_DOMAIN_PROVIDER } from "@/features/domain-workspace/model";
import { domainInputEntries } from "@/features/domain-workspace/domain-search-controls";
import { clock, json, noNetwork, NOW, signal } from "./fixtures";

beforeEach(noNetwork);
afterEach(() => { vi.unstubAllGlobals(); });
// Synthetic registrar, registry and DNS answers only; nothing here reaches the network.
const owner = "123e4567-e89b-42d3-a456-426614174000";
const vercel = (domain: string, available: boolean) => json({ results: [available
  ? { domain, available: true, years: 1, price: 11.25, renewalPrice: 12.5, premium: false } : { domain, available: false }] });
async function lookup(domain: string, fetcher: (request: Request) => Promise<Response>, nameServers: (domain: string, signal: AbortSignal) => Promise<string[]>) {
  return runStandaloneLookup(owner, { tool: "domains", domain }, signal(), {
    config: standaloneProviderConfig({}), fetch: fetcher, clock, nameServers, admit: createLookupAdmission(clock),
  });
}

describe("taken domains on extensions without a registry lookup", () => {
  it("confirms a registration from the .io delegation after the registrar declines, without a price", async () => {
    const fetcher = vi.fn(async () => vercel("launchpad.io", false));
    const nameServers = vi.fn(async () => ["NS1.Example-DNS.net", "ns2.example-dns.net."]);
    const result = await lookup("launchpad.io", fetcher, nameServers);
    expect(standaloneLookupResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ status: "domain", quote: null, check: { domain: "launchpad.io", provider: DNS_DOMAIN_PROVIDER, availability: "taken",
      checkedAt: new Date(NOW).toISOString(), validUntil: new Date(NOW + 60_000).toISOString() } });
    if (result.status !== "domain") throw new Error("Expected a domain result");
    expect(result.check.detail).toContain("the .io registry delegates it to name servers");
    expect(result.check.sourceUrl).toBeUndefined();
    // One registrar request; .io has no RDAP service, so the registry is never fetched.
    expect(fetcher).toHaveBeenCalledTimes(1); expect(nameServers).toHaveBeenCalledExactlyOnceWith("launchpad.io", expect.any(AbortSignal));
  });

  it("keeps the registrar's unknown when DNS lists no name servers or cannot be read", async () => {
    for (const nameServers of [async () => [], async () => ["not a host name"], async () => { throw new Error("SERVFAIL"); }]) {
      const result = await lookup("quietname.co", async () => vercel("quietname.co", false), nameServers);
      expect(result).toMatchObject({ status: "domain", check: { provider: VERCEL_DOMAIN_PROVIDER, availability: "unknown" } });
    }
  });

  it("asks DNS only when the registrar declines and the registry has no RDAP service", async () => {
    const nameServers = vi.fn(async () => ["ns1.example-dns.net"]);
    expect(await lookup("freshname.io", async () => vercel("freshname.io", true), nameServers)).toMatchObject({ check: { provider: VERCEL_DOMAIN_PROVIDER, availability: "available" } });
    const rdap = vi.fn(async (request: Request) => request.url.startsWith("https://api.vercel.com/") ? vercel("launchpad.info", false)
      : (expect(request.url).toBe("https://rdap.identitydigital.services/rdap/domain/launchpad.info"), json({ objectClassName: "domain", ldhName: "LAUNCHPAD.INFO" }, 200, { "content-type": "application/rdap+json" })));
    expect(await lookup("launchpad.info", rdap, nameServers)).toMatchObject({ check: { provider: REGISTRY_DOMAIN_PROVIDER, availability: "taken" } });
    expect(rdap).toHaveBeenCalledTimes(2); expect(nameServers).not.toHaveBeenCalled();
  });

  it("reports nothing for other shapes, failures or cancellation", async () => {
    const delegated = async () => ["ns1.example-dns.net"];
    for (const domain of ["example.fr", "example.com", "shop.example.io"]) {
      expect(await lookupDnsDelegation(domain, clock, signal(), delegated)).toEqual({ status: "failed", code: "unsupported_target", retryAfterSeconds: null });
    }
    expect(await lookupDnsDelegation("example.us", clock, signal(), async () => { throw new Error("timeout"); })).toEqual({ status: "failed", code: "transport", retryAfterSeconds: null });
    const controller = new AbortController();
    expect(await lookupDnsDelegation("example.me", clock, controller.signal, async () => { controller.abort(); return ["ns1.example-dns.net"]; })).toEqual({ status: "failed", code: "cancelled", retryAfterSeconds: null });
  });

  it("is accepted by the client only as a confirmed registration", () => {
    expect(acceptedDomainCheckProvider({ provider: DNS_DOMAIN_PROVIDER, availability: "taken" }, VERCEL_DOMAIN_PROVIDER)).toBe(true);
    expect(acceptedDomainCheckProvider({ provider: DNS_DOMAIN_PROVIDER, availability: "taken" }, REGISTRY_DOMAIN_PROVIDER)).toBe(true);
    for (const availability of ["available", "unknown"] as const) {
      expect(acceptedDomainCheckProvider({ provider: DNS_DOMAIN_PROVIDER, availability }, VERCEL_DOMAIN_PROVIDER)).toBe(false);
    }
  });
});

it("shows each searched name once, keeping the first spelling", () => {
  expect(domainInputEntries("launchpad\nLaunchpad, launchpad\n flynge ,launchpad")).toEqual(["launchpad", "flynge"]);
});
