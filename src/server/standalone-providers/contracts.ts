import "server-only";
import { z } from "zod";
import { isIP } from "node:net";
import {
  providerDomainSchema,
  providerTargetSchema,
  providerSourceUrlSchema,
  providerResultSchema,
  PROVIDER_PAGE_PAYLOAD_MAX_UTF8_BYTES,
  type ProviderTarget,
  type ProviderResult,
  type ProviderFailureCode,
} from "@/domain/standalone-provider-evidence";
import { entrySchema } from "@/features/handles-workspace/domain";

export type ProviderFetch = (request: Request) => Promise<Response>;
export type ProviderClock = () => number;
export type DomainTarget = Extract<ProviderTarget, { tool: "domains" }>;
export type HandleTarget = Extract<ProviderTarget, { tool: "handles" }>;
export type TrademarkTarget = Extract<ProviderTarget, { tool: "trademarks" }>;
export type ProviderRequest =
  | { endpoint: "cloudflare_check"; accountId: string; domain: string }
  | { endpoint: "youtube_channels"; handle: string };
export type ProviderJsonFailure = {
  status: "failed";
  code: ProviderFailureCode;
  retryAfterSeconds: number | null;
  observedAt: string;
};
export type ProviderJsonResult =
  | { status: "ok"; body: unknown; observedAt: string; responseSha256: string; providerRequestId: string | null }
  | ProviderJsonFailure;
export const PROVIDER_DEADLINE_MS = 15_000;
export const accountIdSchema = z.string().regex(/^[a-fA-F0-9]{32}$/);
export const providerRequestSchema: z.ZodType<ProviderRequest> = z.discriminatedUnion("endpoint", [
  z.strictObject({ endpoint: z.literal("cloudflare_check"), accountId: accountIdSchema, domain: providerDomainSchema }),
  z.strictObject({ endpoint: z.literal("youtube_channels"), handle: entrySchema.shape.handle }),
]);
export const transportDependenciesSchema = z.strictObject({
  fetch: z.custom<ProviderFetch>((v) => typeof v === "function"),
  clock: z.custom<ProviderClock>((v) => typeof v === "function"),
});

export const registrarReasons = [
  "domain_unavailable",
  "extension_not_supported_via_api",
  "extension_not_supported",
  "extension_disallows_registration",
  "domain_premium",
] as const;
export type RegistrarObservation = {
  eligibility: "eligible" | "ineligible";
  reason: "eligible" | (typeof registrarReasons)[number];
};
export const registrarObservationSchema: z.ZodType<RegistrarObservation> = z
  .strictObject({ eligibility: z.enum(["eligible", "ineligible"]), reason: z.enum(["eligible", ...registrarReasons]) })
  .refine((v) => (v.eligibility === "eligible") === (v.reason === "eligible"), "Conflicting eligibility");
export type SocialProfileObservation = {
  profile: "found" | "not_found";
  profileId: string | null;
  availability: "unknown";
  reservation: "unverified";
  ownership: "unverified";
};
export const socialProfileObservationSchema: z.ZodType<SocialProfileObservation> = z
  .strictObject({
    profile: z.enum(["found", "not_found"]),
    profileId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\x21-\x7e]+$/)
      .nullable(),
    availability: z.literal("unknown"),
    reservation: z.literal("unverified"),
    ownership: z.literal("unverified"),
  })
  .refine((v) => (v.profile === "found") === (v.profileId !== null), "Conflicting profile evidence");

const jurisdiction = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[A-Z0-9-]+$/);
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const jurisdictions = z.array(jurisdiction).max(20).refine(unique);
const classes = z.array(z.number().int().min(1).max(45)).max(45).refine(unique);
const identifier = z.string().min(1).max(200);
const timestamp = z.iso.datetime({ offset: true });
export const trademarkTargetSchema = providerTargetSchema.refine(
  (v) => v.tool === "trademarks",
) as z.ZodType<TrademarkTarget>;
export type TrademarkHit = {
  registryId: string;
  jurisdiction: string;
  mark: string;
  recordUrl: string;
  niceClasses: number[];
  statusText: string;
  updatedAt: string | null;
};
export type TrademarkPage = {
  target: TrademarkTarget;
  jurisdictions: string[];
  datasetAsOf: string | null;
  hits: TrademarkHit[];
  nextCursor: string | null;
  complete: boolean;
};
export type ReviewedTrademarkSource = {
  providerId: string;
  adapterVersion: string;
  sourceUrl: string;
  termsReference: string;
  allowedRecordHosts: readonly string[];
  jurisdictions: readonly string[];
  niceEdition: string;
  readPage(target: TrademarkTarget, cursor: string | null, signal: AbortSignal): Promise<ProviderResult<TrademarkPage>>;
};
export type TrademarkResearch = {
  query: TrademarkTarget;
  coverage: { requested: string[]; searched: string[]; missing: string[]; niceEdition: string };
  pages: ProviderResult<TrademarkPage>[];
  hits: TrademarkHit[];
  completeness: "complete" | "partial";
  legalClearance: "not_assessed";
  filing: "not_submitted";
};

/** Exact public DNS names only; never accepts IP, localhost or local-network names. No DNS lookup occurs. */
export function publicProviderHost(host: string): boolean {
  return (
    host === host.toLowerCase() &&
    host.length <= 253 &&
    !isIP(host) &&
    !host.includes(":") &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) &&
    host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    host.includes(".") &&
    !/(?:^|\.)(?:localhost|local|internal|lan|home|onion|invalid)$/.test(host)
  );
}
export const publicProviderUrlSchema = providerSourceUrlSchema.refine((value) => {
  try {
    const url = new URL(value);
    return !url.port && publicProviderHost(url.hostname);
  } catch {
    return false;
  }
}, "Use a public HTTPS source");
const trademarkHitSchema: z.ZodType<TrademarkHit> = z.strictObject({
  registryId: identifier,
  jurisdiction,
  mark: z.string().min(1).max(160),
  recordUrl: publicProviderUrlSchema,
  niceClasses: classes,
  statusText: identifier,
  updatedAt: timestamp.nullable(),
});
export const trademarkPageSchema: z.ZodType<TrademarkPage> = z
  .strictObject({
    target: trademarkTargetSchema,
    jurisdictions: jurisdictions.refine((v) => v.length > 0),
    datasetAsOf: timestamp.nullable(),
    hits: z.array(trademarkHitSchema).max(100),
    nextCursor: z.string().min(1).max(500).nullable(),
    complete: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.complete && v.nextCursor !== null) ctx.addIssue({ code: "custom", message: "Complete page cannot continue" });
    if (new TextEncoder().encode(JSON.stringify(v)).byteLength > PROVIDER_PAGE_PAYLOAD_MAX_UTF8_BYTES)
      ctx.addIssue({ code: "custom", message: "Page payload exceeds byte limit" });
  });
export const trademarkResearchSchema: z.ZodType<TrademarkResearch> = z.strictObject({
  query: trademarkTargetSchema,
  coverage: z.strictObject({
    requested: jurisdictions.refine((v) => v.length > 0),
    searched: jurisdictions,
    missing: jurisdictions,
    niceEdition: z.string().min(1).max(64),
  }),
  pages: z.array(providerResultSchema(trademarkPageSchema)).min(1).max(5),
  hits: z.array(trademarkHitSchema).max(500),
  completeness: z.enum(["complete", "partial"]),
  legalClearance: z.literal("not_assessed"),
  filing: z.literal("not_submitted"),
});
export const reviewedTrademarkSourceSchema = z.strictObject({
  providerId: identifier,
  adapterVersion: identifier,
  sourceUrl: publicProviderUrlSchema,
  termsReference: z.string().min(1).max(2048),
  allowedRecordHosts: z.array(z.string().refine(publicProviderHost)).min(1).max(20).refine(unique),
  jurisdictions: jurisdictions.refine((v) => v.length > 0),
  niceEdition: z.string().min(1).max(64),
  readPage: z.custom<ReviewedTrademarkSource["readPage"]>((v) => typeof v === "function"),
});

export function parseProviderTarget<T extends ProviderTarget["tool"]>(
  input: unknown,
  tool: T,
): Extract<ProviderTarget, { tool: T }> {
  const parsed = providerTargetSchema.safeParse(input);
  if (!parsed.success || parsed.data.tool !== tool) throw new TypeError("Invalid provider target");
  return parsed.data as Extract<ProviderTarget, { tool: T }>;
}
export function providerTime(clock: ProviderClock): { ms: number; iso: string } {
  let ms: number;
  try {
    ms = clock();
    if (!Number.isFinite(ms)) throw new Error();
    const iso = new Date(ms).toISOString();
    if (!timestamp.safeParse(iso).success) throw new Error();
    return { ms, iso };
  } catch {
    throw new RangeError("Invalid provider clock");
  }
}
export function providerFailure(
  target: ProviderTarget,
  code: ProviderFailureCode,
  observedAt: string,
  retryAfterSeconds: number | null = null,
): Extract<ProviderResult<never>, { status: "failed" }> {
  return { status: "failed", target, code, retryAfterSeconds, observedAt };
}
