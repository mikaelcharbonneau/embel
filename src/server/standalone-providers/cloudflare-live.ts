import "server-only";
import { type StandaloneLookupResult } from "@/domain/standalone-live-checks";
import { domainCheckSchema, domainQuoteSchema } from "@/features/domain-workspace/model";
import { requestProviderJson } from "./bounded-request";
import { parseProviderTarget, type ProviderClock, type ProviderFetch } from "./contracts";
import { registrarWireSchema, REGISTRAR_PROVIDER_ID, REGISTRAR_SOURCE_URL } from "./registrar-check";

/** Exact decimal conversion; unknown currency exponents and rounding are never guessed. */
function minorUnits(value: string, currency: string): number | null {
  if (!["USD", "CAD", "EUR", "GBP"].includes(currency) || !/^\d{1,12}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(amount) ? amount : null;
}
export async function lookupCloudflare(
  domain: string,
  config: { accountId: string; token: string },
  fetcher: ProviderFetch,
  clock: ProviderClock,
  signal: AbortSignal,
): Promise<StandaloneLookupResult> {
  const target = parseProviderTarget({ tool: "domains", domain }, "domains");
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/registrar/domain-check`;
  const result = await requestProviderJson(
    { endpoint: "cloudflare_check", accountId: config.accountId, domain: target.domain },
    {
      clock,
      fetch: async (request) => {
        // The only credential-bearing request is this exact read-only endpoint.
        if (request.url !== endpoint || request.method !== "POST" || request.redirect !== "error")
          throw new Error("Invalid provider request");
        const headers = new Headers(request.headers);
        headers.set("Authorization", `Bearer ${config.token}`);
        return fetcher(new Request(request, { headers }));
      },
    },
    signal,
  );
  if (result.status === "failed")
    return { status: "failed", code: result.code, retryAfterSeconds: result.retryAfterSeconds };
  const decoded = registrarWireSchema.safeParse(result.body);
  if (!decoded.success || decoded.data.result.domains[0]!.name !== target.domain)
    return { status: "failed", code: "invalid_response", retryAfterSeconds: null };
  const record = decoded.data.result.domains[0]!;
  const check = domainCheckSchema.parse({
    id: result.responseSha256,
    domain: target.domain,
    provider: REGISTRAR_PROVIDER_ID,
    availability: record.registrable ? "available" : "unknown",
    checkedAt: result.observedAt,
    validUntil: new Date(Date.parse(result.observedAt) + 60000).toISOString(),
    evidenceReference: result.responseSha256,
    sourceUrl: REGISTRAR_SOURCE_URL,
    detail: record.registrable
      ? "Cloudflare reports this domain eligible for registration. This check does not reserve or register it."
      : `Cloudflare cannot register this domain: ${record.reason!.replaceAll("_", " ")}. This does not establish an existing registration.`,
  });
  const price = record.pricing;
  const first = price && minorUnits(price.registration_cost, price.currency),
    renewal = price && minorUnits(price.renewal_cost, price.currency);
  const quote =
    record.registrable && price && first !== null && first !== undefined && renewal !== null && renewal !== undefined
      ? domainQuoteSchema.parse({
          id: `price-${result.responseSha256}`,
          domain: target.domain,
          provider: REGISTRAR_PROVIDER_ID,
          checkId: check.id,
          issuedAt: check.checkedAt,
          expiresAt: check.validUntil,
          periodYears: 1,
          total: { amountMinor: first, currency: price.currency },
          renewal: { amountMinor: renewal, currency: price.currency },
          renewalTerms:
            "Current annual registrar price; registry rates may change. Confirm taxes and final terms with the registrar before purchasing.",
        })
      : null;
  return { status: "domain", check, quote };
}
