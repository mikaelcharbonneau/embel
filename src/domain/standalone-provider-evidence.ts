import { z } from "zod";
import { domainSyntaxError, normalizeDomain } from "../features/domain-workspace/model";
import { platformSchema, entrySchema } from "../features/handles-workspace/domain";
import { logoHashSchema, logoTimestampSchema, boundedLogoJson, uniqueLogoValues, logoIssue } from "./logo-vector";

// P6 bounds each decoded page payload in compact UTF-8, separately from its
// target/provenance envelope. Research retains five page results AND their hits.
export const PROVIDER_PAGE_PAYLOAD_MAX_UTF8_BYTES = 262_144;
const PROVIDER_MAX_RETAINED_PAGES = 5;
// The strict target/provenance fields fit within 16 KiB even with JSON escaping.
const PROVIDER_RESULT_ENVELOPE_MAX_UTF8_BYTES = 16_384;
// Query, coverage, edition and aggregate wrappers also fit within 16 KiB.
const PROVIDER_RESEARCH_OVERHEAD_MAX_UTF8_BYTES = 16_384;
const PROVIDER_RESEARCH_PAYLOAD_MAX_UTF8_BYTES =
  PROVIDER_MAX_RETAINED_PAGES * (2 * PROVIDER_PAGE_PAYLOAD_MAX_UTF8_BYTES + PROVIDER_RESULT_ENVELOPE_MAX_UTF8_BYTES) +
  PROVIDER_RESEARCH_OVERHEAD_MAX_UTF8_BYTES;
const PROVIDER_RESULT_MAX_UTF8_BYTES =
  PROVIDER_RESEARCH_PAYLOAD_MAX_UTF8_BYTES + PROVIDER_RESULT_ENVELOPE_MAX_UTF8_BYTES;
// P6 uses bounded integer numbers: JSONB's added spacing is below a 2x compact
// allowance. Other generic payloads must ALSO fit this bound after exponents
// expand. This is not the decoded wire-response/page-payload byte budget.
const PROVIDER_RESULT_MAX_JSONB_BYTES = 2 * PROVIDER_RESULT_MAX_UTF8_BYTES;
const providerEncoder = new TextEncoder();

export const providerDomainSchema = z
  .string()
  .min(1)
  .max(253)
  .refine(
    (v) => v === normalizeDomain(v) && domainSyntaxError(v) === null,
    "Use an existing supported canonical domain",
  );
export const providerTargetSchema = boundedLogoJson(
  z.discriminatedUnion("tool", [
    z.strictObject({ tool: z.literal("domains"), domain: providerDomainSchema }),
    z.strictObject({ tool: z.literal("handles"), platform: platformSchema, handle: entrySchema.shape.handle }),
    z.strictObject({
      tool: z.literal("trademarks"),
      mark: z.string().min(1).max(160),
      jurisdictions: z
        .array(
          z
            .string()
            .min(2)
            .max(32)
            .regex(/^[A-Z0-9-]+$/),
        )
        .min(1)
        .max(20)
        .refine(uniqueLogoValues, "Duplicate jurisdiction"),
      niceClasses: z.array(z.number().int().min(1).max(45)).max(45).refine(uniqueLogoValues, "Duplicate Nice class"),
      mode: z.literal("exact_word"),
    }),
  ]),
);
export type ProviderTarget = z.infer<typeof providerTargetSchema>;
const identifier = z.string().min(1).max(200);
export const providerSourceUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    if (/[\u0000-\u0020\u007f]/.test(value)) return false;
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !!url.hostname &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !value.includes("?") &&
        !value.includes("#")
      );
    } catch {
      return false;
    }
  }, "Use an HTTPS source without credentials, query or fragment");
/** Preserve sub-millisecond ordering retained by PostgreSQL timestamptz/ISO inputs. */
function compareTimestamps(left: string, right: string): number {
  const parts = (value: string) => ({
    whole: Date.parse(value.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/, "")),
    fraction: /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/.exec(value)?.[1] ?? "",
  });
  const a = parts(left),
    b = parts(right);
  if (a.whole !== b.whole) return a.whole < b.whole ? -1 : 1;
  const width = Math.max(a.fraction.length, b.fraction.length),
    af = a.fraction.padEnd(width, "0"),
    bf = b.fraction.padEnd(width, "0");
  return af === bf ? 0 : af < bf ? -1 : 1;
}
export const providerProvenanceSchema = boundedLogoJson(
  z
    .strictObject({
      providerId: identifier,
      adapterVersion: identifier,
      contractVersion: z.literal(1),
      sourceUrl: providerSourceUrlSchema,
      sourceReference: logoHashSchema,
      providerRequestId: identifier.nullable(),
      checkedAt: logoTimestampSchema.nullable(),
      observedAt: logoTimestampSchema,
      freshUntil: logoTimestampSchema.nullable(),
      rightsBasis: z.enum(["official_api", "licensed_api"]),
    })
    .superRefine((v, ctx) => {
      if (v.checkedAt !== null && compareTimestamps(v.checkedAt, v.observedAt) > 0)
        logoIssue(ctx, "A check cannot follow its observation");
      if (v.freshUntil !== null && compareTimestamps(v.observedAt, v.freshUntil) >= 0)
        logoIssue(ctx, "Expiry must follow observation");
    }),
);
export type ProviderProvenance = z.infer<typeof providerProvenanceSchema>;
export const providerFailureCodeSchema = z.enum([
  "unavailable",
  "unsupported_target",
  "not_authorized",
  "rate_limited",
  "timeout",
  "cancelled",
  "transport",
  "invalid_response",
]);
export type ProviderFailureCode = z.infer<typeof providerFailureCodeSchema>;
export type ProviderResult<T> =
  | { status: "observed"; target: ProviderTarget; provenance: ProviderProvenance; value: T }
  | {
      status: "failed";
      target: ProviderTarget;
      code: ProviderFailureCode;
      retryAfterSeconds: number | null;
      observedAt: string;
    };
/** Caller enforces its strict feature/page payload bound; this bounded envelope
 * preserves that full allowance and cannot authenticate provider execution. */
export function providerResultSchema<T>(value: z.ZodType<T>): z.ZodType<ProviderResult<T>> {
  return boundedLogoJson(
    z
      .discriminatedUnion("status", [
        z.strictObject({
          status: z.literal("observed"),
          target: providerTargetSchema,
          provenance: providerProvenanceSchema,
          value,
        }),
        z.strictObject({
          status: z.literal("failed"),
          target: providerTargetSchema,
          code: providerFailureCodeSchema,
          retryAfterSeconds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
          observedAt: logoTimestampSchema,
        }),
      ])
      .superRefine((result, ctx) => {
        try {
          const header =
            result.status === "observed"
              ? { status: result.status, target: result.target, provenance: result.provenance }
              : result;
          if (providerEncoder.encode(JSON.stringify(header)).byteLength > PROVIDER_RESULT_ENVELOPE_MAX_UTF8_BYTES)
            logoIssue(ctx, "Provider envelope exceeds its compact UTF-8 ceiling");
          if (providerEncoder.encode(JSON.stringify(result)).byteLength > PROVIDER_RESULT_MAX_UTF8_BYTES)
            logoIssue(ctx, "Provider result exceeds its compact UTF-8 ceiling");
        } catch {
          logoIssue(ctx, "Provider result must be representable as JSON");
        }
      }),
    PROVIDER_RESULT_MAX_JSONB_BYTES,
  );
}
export function evidenceFreshnessAt(provenance: ProviderProvenance, now: number): "fresh" | "stale" | "unknown" {
  const parsed = providerProvenanceSchema.safeParse(provenance);
  if (!parsed.success || !Number.isFinite(now)) return "unknown";
  const p = parsed.data;
  if (p.checkedAt === null || p.freshUntil === null) return "unknown";
  let clock: string;
  try {
    clock = new Date(now).toISOString();
  } catch {
    return "unknown";
  }
  if (compareTimestamps(p.observedAt, clock) > 0) return "unknown";
  return compareTimestamps(clock, p.freshUntil) >= 0 ? "stale" : "fresh";
}
