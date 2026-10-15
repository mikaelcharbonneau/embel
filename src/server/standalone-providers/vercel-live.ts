import "server-only";
import { z } from "zod";
import { type StandaloneLookupResult } from "@/domain/standalone-live-checks";
import { providerDomainSchema } from "@/domain/standalone-provider-evidence";
import { domainCheckSchema, domainQuoteSchema } from "@/features/domain-workspace/model";
import { parseProviderTarget, providerTime, type ProviderClock, type ProviderFetch } from "./contracts";
import { liveProviderJson } from "./live-json";

export const VERCEL_DOMAIN_PROVIDER = "vercel_registrar";
export const VERCEL_DOMAIN_SOURCE_URL = "https://vercel.com/docs/rest-api/domains-registrar/get-domain-availability-and-pricing";
const endpoint = "https://api.vercel.com/v1/registrar/domains/search";
// Embel's recheck policy, not a provider TTL, price lock or reservation.
const RECHECK_AFTER_MS = 60_000;
const MAX_IN_FLIGHT = 120;
const wireResult = z.discriminatedUnion("available", [
  z.strictObject({ domain: providerDomainSchema, available: z.literal(false) }),
  z.strictObject({ domain: providerDomainSchema, available: z.literal(true),
    // The existing quote contract can represent terms of one through ten years.
    years: z.number().int().min(1).max(10), price: z.number().finite().nonnegative(),
    renewalPrice: z.number().finite().nonnegative(), premium: z.boolean() }),
]);
const wireResponse = z.strictObject({ results: z.array(wireResult).length(1) });
type FailureCode = Extract<StandaloneLookupResult, { status: "failed" }>["code"];
const failure = (code: FailureCode, retryAfterSeconds: number | null = null): StandaloneLookupResult => ({ status: "failed", code, retryAfterSeconds });

/** USD is documented by this endpoint. Never silently round sub-cent prices. */
function usdMinorUnits(value: number): number | null {
  const decimal = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(decimal)) return null;
  const [whole, fraction = ""] = decimal.split(".");
  const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}

function retryDeadline(header: string | null, now: number): number | null {
  if (header === null) return null;
  // Keep the full deadline even when the response schema displays at most a day.
  if (/^\d+$/.test(header)) return Math.min(Number.MAX_SAFE_INTEGER, now + Number(header) * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) && new Date(date).toUTCString() === header ? Math.max(now, date) : null;
}

async function readVercel(domain: string, fetcher: ProviderFetch, clock: ProviderClock, signal: AbortSignal, onRateLimit: (retryAt: number) => void): Promise<StandaloneLookupResult> {
  let providerRetryAt: number | null = null;
  // No credentials, user IDs, prompts, notes or project context leave the app.
  const response = await liveProviderJson(new Request(endpoint, { method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ domains: [domain] }),
  }), async request => {
    const result = await fetcher(request);
    if (result.status === 429) providerRetryAt = retryDeadline(result.headers.get("retry-after"), providerTime(clock).ms);
    return result;
  }, clock, signal);
  if (response.status === "failed") {
    if (response.code !== "rate_limited") return failure(response.code, response.retryAfterSeconds);
    const now = providerTime(clock).ms, retryAt = providerRetryAt ?? now + 60_000;
    onRateLimit(retryAt);
    return failure("rate_limited", Math.min(86400, Math.max(0, Math.ceil((retryAt - now) / 1000))));
  }
  if (signal.aborted) return failure("cancelled");
  const decoded = wireResponse.safeParse(response.body);
  if (!decoded.success || decoded.data.results[0]!.domain !== domain) return failure("invalid_response");
  const record = decoded.data.results[0]!;
  const total = record.available ? usdMinorUnits(record.price) : null;
  const renewal = record.available ? usdMinorUnits(record.renewalPrice) : null;
  if (record.available && (total === null || renewal === null)) return failure("invalid_response");
  const recheckAt = new Date(Date.parse(response.observedAt) + RECHECK_AFTER_MS).toISOString();
  const check = domainCheckSchema.parse({ id: response.digest, domain, provider: VERCEL_DOMAIN_PROVIDER,
    availability: record.available ? "available" : "unknown", checkedAt: response.observedAt,
    validUntil: recheckAt, evidenceReference: response.digest, sourceUrl: VERCEL_DOMAIN_SOURCE_URL,
    detail: record.available
      ? `Vercel reports this domain available.${record.premium ? " Premium domain." : ""} This does not reserve it. Embel requires a recheck after one minute; this is not a provider guarantee.`
      : "Vercel reports this domain unavailable or could not confirm its availability. This does not prove an existing registration. Embel requires a recheck after one minute; this is not a provider guarantee.",
  });
  const quote = record.available ? domainQuoteSchema.parse({ id: `price-${response.digest}`, domain,
    provider: VERCEL_DOMAIN_PROVIDER, checkId: check.id, issuedAt: response.observedAt,
    expiresAt: recheckAt, periodYears: record.years,
    total: { amountMinor: total, currency: "USD" }, renewal: { amountMinor: renewal, currency: "USD" },
    renewalTerms: `Current renewal total for ${record.years} ${record.years === 1 ? "year" : "years"}; future rates may change. Confirm taxes and final checkout terms with the registrar. Embel's recheck window is not a price guarantee.`,
  }) : null;
  return { status: "domain", check, quote };
}

type InFlight = { controller: AbortController; promise: Promise<StandaloneLookupResult>; subscribers: number };
type TransportState = { requests: Map<string, InFlight>; retryAt: number | null };
const transports = new WeakMap<ProviderFetch, WeakMap<ProviderClock, TransportState>>();

/** Only simultaneous exact public-domain reads are shared; completed responses are never cached.
 * Each caller can cancel independently. The last cancellation aborts the provider read.
 * A provider 429 pauses every domain on this transport until its retry window ends.
 * Only the retry deadline survives completion, never domain names or lookup results.
 * Dependency scoping prevents test/custom transports and clocks from sharing observations.
 */
export async function lookupVercel(domain: string, fetcher: ProviderFetch, clock: ProviderClock, signal: AbortSignal): Promise<StandaloneLookupResult> {
  const target = parseProviderTarget({ tool: "domains", domain }, "domains");
  if (signal.aborted) return failure("cancelled");
  let clocks = transports.get(fetcher);
  if (!clocks) { clocks = new WeakMap(); transports.set(fetcher, clocks); }
  let pending = clocks.get(clock);
  if (!pending) { pending = { requests: new Map(), retryAt: null }; clocks.set(clock, pending); }
  const state = pending, now = providerTime(clock).ms;
  if (state.retryAt !== null && state.retryAt > now) return failure("rate_limited", Math.min(86400, Math.ceil((state.retryAt - now) / 1000)));
  state.retryAt = null;
  const requests = state.requests;
  let entry = requests.get(target.domain);
  if (!entry) {
    if (requests.size >= MAX_IN_FLIGHT) return failure("rate_limited", 60);
    const controller = new AbortController();
    const created: InFlight = { controller, subscribers: 0,
      promise: readVercel(target.domain, fetcher, clock, controller.signal, retryAt => {
        state.retryAt = Math.max(state.retryAt ?? retryAt, retryAt);
      })
        .catch(() => failure(controller.signal.aborted ? "cancelled" : "invalid_response"))
        .finally(() => { if (requests.get(target.domain) === created) requests.delete(target.domain); }),
    };
    requests.set(target.domain, created); entry = created;
  }
  const shared = entry;
  shared.subscribers++;
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: StandaloneLookupResult) => {
      if (settled) return;
      settled = true; signal.removeEventListener("abort", cancel); shared.subscribers--;
      if (shared.subscribers === 0 && requests.get(target.domain) === shared) {
        requests.delete(target.domain); shared.controller.abort();
      }
      resolve(structuredClone(result));
    };
    const cancel = () => finish(failure("cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    void shared.promise.then(result => finish(signal.aborted ? failure("cancelled") : result));
  });
}
