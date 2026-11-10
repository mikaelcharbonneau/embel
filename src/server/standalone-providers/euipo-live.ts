import "server-only";
import { z } from "zod";
import { type StandaloneLookupResult, trademarkLookupSchema } from "@/domain/standalone-live-checks";
import { createTrademarkSearchContract } from "./trademark-search";
import { liveProviderJson } from "./live-json";
import {
  parseProviderTarget,
  providerFailure,
  providerTime,
  type TrademarkTarget,
  type ReviewedTrademarkSource,
  type ProviderClock,
  type ProviderFetch,
} from "./contracts";

export const EUIPO_SOURCE = "https://dev.euipo.europa.eu/product/trademark-search_110/api/trademark-search";
const tokenSchema = z.object({
  access_token: z
    .string()
    .min(1)
    .max(16000)
    .regex(/^[\x21-\x7e]+$/),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z.number().int().positive(),
});
const pageSchema = z.strictObject({
  trademarks: z
    .array(
      z.strictObject({
        applicationNumber: z.string().regex(/^\d{9}$/),
        wordMarkSpecification: z.strictObject({ verbalElement: z.string().min(1).max(160) }),
        niceClasses: z
          .array(z.number().int().min(1).max(45))
          .max(45)
          .refine((value) => new Set(value).size === value.length),
        status: z.enum([
          "RECEIVED",
          "UNDER_EXAMINATION",
          "APPLICATION_PUBLISHED",
          "REGISTRATION_PENDING",
          "REGISTERED",
          "WITHDRAWN",
          "REFUSED",
          "OPPOSITION_PENDING",
          "APPEALED",
          "CANCELLATION_PENDING",
          "CANCELLED",
          "SURRENDERED",
          "EXPIRED",
          "APPEALABLE",
          "START_OF_OPPOSITION_PERIOD",
          "ACCEPTANCE_PENDING",
          "ACCEPTED",
          "REMOVED_FROM_REGISTER",
        ]),
      }),
    )
    .max(100),
  size: z.literal(100),
  totalElements: z.number().int().min(0).max(2147483647),
  totalPages: z.number().int().min(0).max(2147483647),
  page: z.number().int().min(0).max(4),
});
/** Public Search 1.1.0; production only. Sandbox sample records must never become live evidence. */
export function createEuipoSource(
  config: { clientId: string; clientSecret: string },
  fetcher: ProviderFetch,
  clock: ProviderClock,
): ReviewedTrademarkSource {
  let accessToken: string | null = null;
  return {
    providerId: "euipo",
    adapterVersion: "euipo-exact-1.1.0",
    sourceUrl: EUIPO_SOURCE,
    termsReference: "https://dev.euipo.europa.eu/faq",
    allowedRecordHosts: ["api.euipo.europa.eu"],
    jurisdictions: ["EM"],
    niceEdition: "Not supplied by the search API",
    async readPage(input, cursor, signal) {
      const target = parseProviderTarget(input, "trademarks"),
        now = providerTime(clock);
      // Asterisk is a query wildcard even inside quoted RSQL values; never broaden a literal search.
      if (
        target.jurisdictions.length !== 1 ||
        target.jurisdictions[0] !== "EM" ||
        /[*\u0000-\u001f\u007f]/.test(target.mark) ||
        (cursor !== null && !/^[1-4]$/.test(cursor))
      )
        return providerFailure(target, "unsupported_target", now.iso);
      if (signal.aborted) return providerFailure(target, "cancelled", now.iso);
      if (!accessToken) {
        const token = await liveProviderJson(
          new Request("https://euipo.europa.eu/cas-server-webapp/oidc/accessToken", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: new URLSearchParams({
              client_id: config.clientId,
              client_secret: config.clientSecret,
              grant_type: "client_credentials",
              scope: "uid",
            }),
          }),
          fetcher,
          clock,
          signal,
        );
        if (token.status === "failed")
          return providerFailure(target, token.code, token.observedAt, token.retryAfterSeconds);
        const decoded = tokenSchema.safeParse(token.body);
        if (!decoded.success) return providerFailure(target, "invalid_response", token.observedAt);
        accessToken = decoded.data.access_token;
      }
      if (signal.aborted) return providerFailure(target, "cancelled", providerTime(clock).iso);
      const literal = target.mark.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
      const query = `wordMarkSpecification.verbalElement=='${literal}';markBasis==EU_TRADEMARK${target.niceClasses.length ? `;niceClasses=in=(${target.niceClasses.join(",")})` : ""}`;
      const page = cursor === null ? 0 : Number(cursor);
      const params = new URLSearchParams({
        query,
        page: String(page),
        size: "100",
        fields:
          "page,size,totalElements,totalPages,trademarks(applicationNumber,wordMarkSpecification(verbalElement),niceClasses,status)",
      });
      const response = await liveProviderJson(
        new Request(`https://api.euipo.europa.eu/trademark-search/trademarks?${params}`, {
          headers: {
            accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
            "X-IBM-Client-Id": config.clientId,
          },
        }),
        fetcher,
        clock,
        signal,
      );
      if (response.status === "failed")
        return providerFailure(target, response.code, response.observedAt, response.retryAfterSeconds);
      const parsed = pageSchema.safeParse(response.body);
      if (!parsed.success) return providerFailure(target, "invalid_response", response.observedAt);
      const value = parsed.data;
      const exact = (mark: string) => mark.normalize("NFC").toLowerCase();
      if (
        value.page !== page ||
        value.totalPages !== Math.ceil(value.totalElements / 100) ||
        value.trademarks.length !== Math.min(100, Math.max(0, value.totalElements - 100 * page)) ||
        value.trademarks.some(
          (mark) =>
            exact(mark.wordMarkSpecification.verbalElement) !== exact(target.mark) ||
            (target.niceClasses.length && !target.niceClasses.some((nice) => mark.niceClasses.includes(nice))),
        )
      )
        return providerFailure(target, "invalid_response", response.observedAt);
      const complete = page + 1 >= value.totalPages;
      return {
        status: "observed",
        target,
        provenance: {
          providerId: "euipo",
          adapterVersion: "euipo-exact-1.1.0",
          contractVersion: 1,
          sourceUrl: EUIPO_SOURCE,
          sourceReference: response.digest,
          providerRequestId: null,
          checkedAt: response.observedAt,
          observedAt: response.observedAt,
          freshUntil: new Date(Date.parse(response.observedAt) + 900000).toISOString(),
          rightsBasis: "official_api",
        },
        value: {
          target,
          jurisdictions: ["EM"],
          datasetAsOf: null,
          complete,
          nextCursor: complete ? null : String(page + 1),
          hits: value.trademarks.map((mark) => ({
            registryId: mark.applicationNumber,
            jurisdiction: "EM",
            mark: mark.wordMarkSpecification.verbalElement,
            recordUrl: `https://api.euipo.europa.eu/trademark-search/trademarks/${mark.applicationNumber}`,
            niceClasses: mark.niceClasses,
            statusText: mark.status,
            updatedAt: null,
          })),
        },
      };
    },
  };
}

export async function lookupEuipo(
  target: TrademarkTarget,
  config: { clientId: string; clientSecret: string },
  fetcher: ProviderFetch,
  clock: ProviderClock,
  signal: AbortSignal,
): Promise<StandaloneLookupResult> {
  // One source instance per lookup keeps OAuth tokens request-local and never persists them.
  const result = await createTrademarkSearchContract(createEuipoSource(config, fetcher, clock), clock).search(
    target,
    signal,
  );
  if (result.status === "failed")
    return { status: "failed", code: result.code, retryAfterSeconds: result.retryAfterSeconds };
  const failed = result.value.pages.find((page) => page.status === "failed");
  return {
    status: "trademark",
    research: trademarkLookupSchema.parse({
      query: target,
      searched: result.value.coverage.searched,
      missing: result.value.coverage.missing,
      hits: result.value.hits.map((hit) => ({
        registryId: hit.registryId,
        mark: hit.mark,
        niceClasses: hit.niceClasses,
        status: hit.statusText,
      })),
      checkedAt: result.provenance.observedAt,
      datasetAsOf: null,
      completeness: "partial",
      interrupted: failed?.status === "failed" ? failed.code : null,
      sourceUrl: EUIPO_SOURCE,
      legalClearance: "not_assessed",
      filing: "not_submitted",
    }),
  };
}
