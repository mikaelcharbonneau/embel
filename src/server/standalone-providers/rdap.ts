import "server-only";
import { z } from "zod";
import { type StandaloneLookupResult } from "@/domain/standalone-live-checks";
import { domainCheckSchema } from "@/features/domain-workspace/model";
import { parseProviderTarget, type ProviderFetch, type ProviderClock } from "./contracts";
import { liveProviderJson } from "./live-json";

// Exact IANA RDAP bootstrap entries reviewed 2026-10-13. Never follow provider links/redirects.
const services: Record<string, string> = {
  com: "https://rdap.verisign.com/com/v1/", net: "https://rdap.verisign.com/net/v1/",
  org: "https://rdap.publicinterestregistry.org/rdap/", app: "https://pubapi.registry.google/rdap/",
  dev: "https://pubapi.registry.google/rdap/", ca: "https://rdap.ca.fury.ca/rdap/",
  ai: "https://rdap.identitydigital.services/rdap/", uk: "https://rdap.nominet.uk/uk/",
};
export const RDAP_PROVIDER = "Public registry RDAP";
export async function lookupRdap(domain: string, fetcher: ProviderFetch, clock: ProviderClock, signal: AbortSignal): Promise<StandaloneLookupResult> {
  const target = parseProviderTarget({ tool: "domains", domain }, "domains");
  const labels = target.domain.split("."), tld = labels.at(-1)!;
  // Restrict to reviewed registrable shapes; an absent subdomain is never a registration lookup.
  if (!services[tld] || !(labels.length === 2 || tld === "uk" && labels.length === 3 && ["co", "org", "me"].includes(labels[1]!))) return { status: "failed", code: "unsupported_target", retryAfterSeconds: null };
  const url = `${services[tld]}domain/${target.domain}`;
  const result = await liveProviderJson(new Request(url, { headers: { accept: "application/rdap+json, application/json" } }), fetcher, clock, signal, true);
  if (result.status === "failed") return { status: "failed", code: result.code, retryAfterSeconds: result.retryAfterSeconds };
  const found = z.object({ objectClassName: z.literal("domain"), ldhName: z.string().max(253) }).safeParse(result.body);
  const missing = z.object({ errorCode: z.literal(404) }).safeParse(result.body);
  if (result.httpStatus === 200 ? !found.success || found.data.ldhName.toLowerCase() !== target.domain : result.body !== null && !missing.success) return { status: "failed", code: "invalid_response", retryAfterSeconds: null };
  return { status: "domain", quote: null, check: domainCheckSchema.parse({ id: result.digest, domain: target.domain, provider: RDAP_PROVIDER,
    availability: result.httpStatus === 200 ? "taken" : "unknown", checkedAt: result.observedAt, validUntil: new Date(Date.parse(result.observedAt) + 60000).toISOString(), evidenceReference: result.digest,
    sourceUrl: url, detail: result.httpStatus === 200 ? "The authoritative registry returned an exact registration record. Ownership and purchase are not verified." : "The registry returned no registration record. Reserved names and other restrictions may still apply; availability is unknown." }) };
}
