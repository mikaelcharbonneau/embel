import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { type StandaloneLookupResult } from "@/domain/standalone-live-checks";
import { providerDomainSchema } from "@/domain/standalone-provider-evidence";
import { domainCheckSchema, domainQuoteSchema } from "@/features/domain-workspace/model";
import { boundedProviderWork } from "./bounded-request";
import { parseProviderTarget, providerTime, type ProviderClock, type ProviderFetch } from "./contracts";
import { namecomConfigSchema, type NamecomConfig } from "./live-config";
import { liveProviderJson } from "./live-json";

const NAMECOM_DOMAIN_PROVIDER = "namecom_core";
const NAMECOM_DOMAIN_SOURCE_URL = "https://docs.name.com/api/v1/reference/domains/check-availability";
const RECHECK_AFTER_MS = 60_000; // Embel policy, not a price lock or provider guarantee.
const price = z.number().finite().nonnegative();
const purchaseTypes = [
  "registration",
  "aftermarket_i",
  "aftermarket_s",
  "aftermarket_b",
  "expiring",
  "backorder",
] as const;
const discoveryRecord = z.strictObject({
  domainName: providerDomainSchema,
  purchasable: z.boolean().default(false),
  premium: z.boolean().default(false),
  purchaseType: z.enum(["", ...purchaseTypes]).default(""),
  purchasePrice: price.optional(),
  renewalPrice: price.optional(),
  sld: z.string().max(253).optional(),
  tld: z.string().max(253).optional(),
  reason: z.string().max(2000).optional(),
});
const discoveryResponse = z.strictObject({ results: z.array(discoveryRecord).min(1).max(50) });
const pricingResponse = z.strictObject({
  premium: z.boolean().default(false),
  purchasePrice: price.nullable(),
  renewalPrice: price.nullable(),
  transferPrice: price.nullable().optional(),
});
type Failure = Extract<StandaloneLookupResult, { status: "failed" }>;
const failure = (code: Failure["code"], retryAfterSeconds: number | null = null): Failure => ({
  status: "failed",
  code,
  retryAfterSeconds,
});

/** Name.com documents USD. No floating-point multiplication, silent rounding or guessed free price. */
function usdMinorUnits(value: number): number | null {
  const decimal = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(decimal)) return null;
  const [whole, fraction = ""] = decimal.split(".");
  const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}
/** Validate raw numeric lexemes before JSON.parse can round/substitute their evidence.
 * All numeric fields in these two strict CORE response schemas are monetary. Quoted strings
 * are skipped as whole JSON tokens. Standard JSON.parse still validates the complete grammar.
 * Exponent notation, sub-cent lexemes and non-round-trippable amounts fail closed.
 */
function decodeNamecomJson(text: string): unknown {
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[^\s{}\[\],:]+/g) ?? [];
  for (const token of tokens) {
    if (!/^-?\d/.test(token)) continue;
    if (!/^\d{1,14}(?:\.\d{1,2})?$/.test(token)) throw new Error("Invalid monetary response");
    const [whole, fraction = ""] = token.split(".");
    const exact = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
    const decoded = usdMinorUnits(Number(token));
    if (exact > BigInt(Number.MAX_SAFE_INTEGER) || decoded === null || BigInt(decoded) !== exact)
      throw new Error("Inexact monetary response");
  }
  return JSON.parse(text) as unknown;
}
function usdText(minor: number): string {
  const cents = BigInt(minor);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")} USD`;
}
function digest(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

// No credentials, domain results or completed observations are retained. Conservative shared cooldown
// covers this transport, including other domains/accounts. It is not a distributed account quota.
const cooldowns = new WeakMap<ProviderFetch, WeakMap<ProviderClock, { retryAt: number | null }>>();
function cooldown(fetcher: ProviderFetch, clock: ProviderClock) {
  let clocks = cooldowns.get(fetcher);
  if (!clocks) {
    clocks = new WeakMap();
    cooldowns.set(fetcher, clocks);
  }
  let state = clocks.get(clock);
  if (!state) {
    state = { retryAt: null };
    clocks.set(clock, state);
  }
  return state;
}
function retryDeadline(header: string | null, now: number): number {
  if (header !== null && /^\d+$/.test(header)) return Math.min(Number.MAX_SAFE_INTEGER, now + Number(header) * 1000);
  if (header !== null) {
    const date = Date.parse(header);
    if (Number.isFinite(date) && new Date(date).toUTCString() === header) return Math.max(now, date);
  }
  return now + 60_000;
}

/** Read-only CORE discovery accepts 1–50 unique exact domains, preserves input order and never
 * trusts response ordering. Pricing has at most four concurrent reads under one 15-second deadline.
 * The app currently uses single-domain lookups; this helper does not expand the HTTP request contract.
 */
export async function lookupNamecomBatch(
  domains: readonly string[],
  rawConfig: NamecomConfig,
  fetcher: ProviderFetch,
  clock: ProviderClock,
  signal: AbortSignal,
): Promise<StandaloneLookupResult[]> {
  if (!Array.isArray(domains) || domains.length < 1 || domains.length > 50)
    throw new TypeError("Expected 1–50 domains");
  const targets = domains.map((domain) => parseProviderTarget({ tool: "domains", domain }, "domains").domain);
  if (new Set(targets).size !== targets.length) throw new TypeError("Expected unique domains");
  const parsedConfig = namecomConfigSchema.safeParse(rawConfig);
  if (!parsedConfig.success) return targets.map(() => failure("unavailable"));
  const config = parsedConfig.data;
  if (signal.aborted) return targets.map(() => failure("cancelled"));
  const base =
    config.environment === "production" ? "https://api.name.com/core/v1" : "https://api.dev.name.com/core/v1";
  const provider = config.environment === "production" ? NAMECOM_DOMAIN_PROVIDER : "namecom_core_sandbox";
  const state = cooldown(fetcher, clock);
  const work = await boundedProviderWork(
    async (child) => {
      const request = async (domain?: string, years?: number) => {
        const now = providerTime(clock).ms;
        if (child.aborted) return failure("cancelled");
        if (state.retryAt !== null && state.retryAt > now)
          return failure("rate_limited", Math.min(86400, Math.ceil((state.retryAt - now) / 1000)));
        // Only these two fixed read-only paths ever receive the credential. No redirects or caller URLs.
        const url =
          domain === undefined
            ? `${base}/domains:checkAvailability`
            : `${base}/domains/${domain}:getPricing?years=${years}`;
        const response = await liveProviderJson(
          new Request(url, {
            method: domain === undefined ? "POST" : "GET",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              Authorization: `Basic ${Buffer.from(`${config.username}:${config.token}`, "utf8").toString("base64")}`,
            },
            ...(domain === undefined ? { body: JSON.stringify({ domainNames: targets }) } : {}),
          }),
          async (outgoing) => {
            const response = await fetcher(outgoing);
            if (response.status === 429) {
              const deadline = retryDeadline(response.headers.get("retry-after"), providerTime(clock).ms);
              state.retryAt = Math.max(state.retryAt ?? deadline, deadline);
            }
            return response;
          },
          clock,
          child,
          false,
          decodeNamecomJson,
        );
        if (response.status === "failed")
          return failure(
            response.code,
            response.code === "rate_limited"
              ? Math.min(
                  86400,
                  Math.max(0, Math.ceil(((state.retryAt ?? now + 60_000) - providerTime(clock).ms) / 1000)),
                )
              : response.retryAfterSeconds,
          );
        return response;
      };
      const discovery = await request();
      if (discovery.status === "failed") return targets.map(() => discovery);
      const decoded = discoveryResponse.safeParse(discovery.body);
      if (!decoded.success) return targets.map(() => failure("invalid_response"));
      const records = new Map(decoded.data.results.map((record) => [record.domainName, record]));
      if (
        records.size !== targets.length ||
        decoded.data.results.length !== targets.length ||
        targets.some((domain) => !records.has(domain))
      )
        return targets.map(() => failure("invalid_response"));
      const results: StandaloneLookupResult[] = new Array(targets.length);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, targets.length) }, async () => {
          while (next < targets.length && !child.aborted) {
            const index = next++,
              domain = targets[index]!,
              record = records.get(domain)!;
            const checkId = digest(provider, domain, discovery.digest);
            const expiresAt = new Date(Date.parse(discovery.observedAt) + RECHECK_AFTER_MS).toISOString();
            const check = (availability: "available" | "unknown", detail: string) =>
              domainCheckSchema.parse({
                id: checkId,
                domain,
                provider,
                availability,
                checkedAt: discovery.observedAt,
                validUntil: expiresAt,
                evidenceReference: discovery.digest,
                sourceUrl: NAMECOM_DOMAIN_SOURCE_URL,
                detail,
              });
            const unknown = (detail: string): StandaloneLookupResult => ({
              status: "domain",
              check: check("unknown", detail),
              quote: null,
            });
            if (config.environment === "sandbox") {
              results[index] = unknown(
                "Name.com sandbox simulation only. This does not establish real-world availability or prices. Live registration remains unknown.",
              );
            } else if (!record.purchasable) {
              results[index] = unknown(
                "Name.com did not confirm this domain as purchasable. This does not prove an existing registration. No price or reservation was established.",
              );
            } else if (!record.purchaseType) {
              results[index] = unknown(
                "Name.com did not identify the purchase type. New-registration availability and pricing could not be verified.",
              );
            } else if (record.purchaseType !== "registration") {
              const amount = record.purchasePrice === undefined ? null : usdMinorUnits(record.purchasePrice);
              if (record.purchasePrice !== undefined && amount === null) {
                results[index] = failure("invalid_response");
                continue;
              }
              // Lead with one plain sentence; keep Name.com's exact listing type as evidence.
              const offer = record.purchaseType.startsWith("aftermarket_")
                ? "lists it for resale by its current owner"
                : record.purchaseType === "expiring"
                  ? "offers it as an expiring domain"
                  : record.purchaseType === "backorder"
                    ? "offers it only as a backorder"
                    : `offers it as a "${record.purchaseType}" acquisition`;
              results[index] = unknown(
                `Not available as a new registration: Name.com ${offer}${amount === null ? "." : ` for ${usdText(amount)} before tax.`}${amount === null ? " Acquisition price unavailable." : ""} Listing type: ${record.purchaseType}. Its registration length and renewal terms are unverified, and third-party fulfillment may be delayed or declined. No purchase is enabled.`,
              );
            } else {
              // Explicit term avoids pricing .ai's two-year minimum as one year. Other unsupported terms
              // fail closed; never silently retry another term or multiply discovery/renewal prices.
              const years = domain.endsWith(".ai") ? 2 : 1;
              const pricing = await request(domain, years);
              if (pricing.status === "failed") {
                results[index] = pricing;
                continue;
              }
              const priceRecord = pricingResponse.safeParse(pricing.body);
              if (!priceRecord.success || priceRecord.data.premium !== record.premium) {
                results[index] = failure("invalid_response");
                continue;
              }
              const { purchasePrice, renewalPrice } = priceRecord.data;
              if (purchasePrice === null) {
                results[index] = unknown(
                  `Name.com is not accepting registration for this domain and the requested ${years}-year term. No current registration quote was established.`,
                );
                continue;
              }
              const total = usdMinorUnits(purchasePrice),
                renewal = renewalPrice === null ? null : usdMinorUnits(renewalPrice);
              if (total === null || (renewalPrice !== null && renewal === null)) {
                results[index] = failure("invalid_response");
                continue;
              }
              const registrationCheck = check(
                "available",
                `Name.com reports new-registration availability.${record.premium ? " Registry premium." : ""} This does not reserve the domain. Recheck after one minute; this is Embel's policy, not a provider guarantee.`,
              );
              const quote = domainQuoteSchema.parse({
                id: digest(checkId, pricing.digest, String(years)),
                domain,
                provider,
                checkId,
                issuedAt: pricing.observedAt,
                expiresAt,
                periodYears: years,
                total: { amountMinor: total, currency: "USD" },
                renewal: renewal === null ? null : { amountMinor: renewal, currency: "USD" },
                renewalTerms: `${renewal === null ? "Renewal unavailable" : "Current renewal total"} for ${years} ${years === 1 ? "year" : "years"}. Prices exclude tax; future rates may change. Recheck with Name.com before purchase; no price lock or reservation.`,
              });
              results[index] = { status: "domain", check: registrationCheck, quote };
            }
          }
        }),
      );
      return results;
    },
    clock,
    signal,
  );
  if (work.status === "failed") return targets.map(() => failure(work.code, work.retryAfterSeconds));
  return work.value;
}

export async function lookupNamecom(
  domain: string,
  config: NamecomConfig,
  fetcher: ProviderFetch,
  clock: ProviderClock,
  signal: AbortSignal,
): Promise<StandaloneLookupResult> {
  return (await lookupNamecomBatch([domain], config, fetcher, clock, signal))[0]!;
}
