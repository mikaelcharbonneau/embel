import "server-only";
import { z } from "zod";
import { providerResultSchema, type ProviderResult } from "@/domain/standalone-provider-evidence";
import { requestProviderJson } from "./bounded-request";
import { parseProviderTarget, providerFailure, providerTime, socialProfileObservationSchema, transportDependenciesSchema, type ProviderFetch, type ProviderClock, type HandleTarget, type SocialProfileObservation } from "./contracts";

export const SOCIAL_PROVIDER_ID = "youtube_data_api";
export const SOCIAL_ADAPTER_VERSION = "youtube-for-handle-v1";
export const SOCIAL_SOURCE_URL = "https://developers.google.com/youtube/v3/docs/channels/list";
const channelSchema = z.strictObject({
  kind: z.literal("youtube#channel"), id: z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/), etag: z.string().max(200).optional(),
});
const wireSchema = z.strictObject({
  kind: z.literal("youtube#channelListResponse"), etag: z.string().max(200).optional(),
  // The discovery document includes these deprecated metadata fields. They
  // grant no profile evidence; an actual page token is still unexpected.
  eventId: z.string().max(1024).optional(), visitorId: z.string().max(1024).optional(), tokenPagination: z.strictObject({}).optional(),
  pageInfo: z.strictObject({ totalResults: z.number().int().min(0).max(1), resultsPerPage: z.number().int().nonnegative().optional() }).optional(),
  items: z.array(channelSchema).max(1).optional(),
}).refine(({ items, pageInfo }) => {
  if (!items) return pageInfo?.totalResults === 0;
  return !pageInfo || (pageInfo.totalResults === items.length && (pageInfo.resultsPerPage ?? items.length) >= items.length);
});

/** Profile existence observation only. A zero-result lookup never proves availability. */
export function createSocialProfileContract(deps: { fetch: ProviderFetch; clock: ProviderClock }): { check(target: HandleTarget, signal: AbortSignal): Promise<ProviderResult<SocialProfileObservation>> } {
  const parsed = transportDependenciesSchema.safeParse(deps);
  if (!parsed.success) throw new TypeError("Invalid social configuration");
  const config = parsed.data; providerTime(config.clock);
  return { async check(input, signal) {
    const target = parseProviderTarget(input, "handles"), start = providerTime(config.clock);
    if (signal.aborted) return providerFailure(target, "cancelled", start.iso);
    if (target.platform !== "youtube") return providerFailure(target, "unsupported_target", start.iso);
    const response = await requestProviderJson({ endpoint: "youtube_channels", handle: target.handle }, config, signal);
    if (response.status === "failed") return { ...response, target };
    if (signal.aborted) return providerFailure(target, "cancelled", response.observedAt);
    const decoded = wireSchema.safeParse(response.body);
    if (!decoded.success) return providerFailure(target, "invalid_response", response.observedAt);
    const record = decoded.data.items?.[0];
    return providerResultSchema(socialProfileObservationSchema).parse({ status: "observed", target, value: { profile: record ? "found" : "not_found", profileId: record?.id ?? null, availability: "unknown", reservation: "unverified", ownership: "unverified" }, provenance: { providerId: SOCIAL_PROVIDER_ID, adapterVersion: SOCIAL_ADAPTER_VERSION, contractVersion: 1, sourceUrl: SOCIAL_SOURCE_URL, sourceReference: response.responseSha256, providerRequestId: null, checkedAt: response.observedAt, observedAt: response.observedAt, freshUntil: new Date(Date.parse(response.observedAt) + 3_600_000).toISOString(), rightsBasis: "official_api" } });
  } };
}
