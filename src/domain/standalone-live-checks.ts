import { z } from "zod";
import { domainCheckSchema, domainQuoteSchema } from "@/features/domain-workspace/model";
import { evidenceSchema } from "@/features/handles-workspace/domain";
import { providerFailureCodeSchema, providerTargetSchema } from "./standalone-provider-evidence";

/** Lookup receipts are transient. They are never writable account draft fields. */
export const standaloneLookupInputSchema = providerTargetSchema;
export type StandaloneLookupInput = z.infer<typeof standaloneLookupInputSchema>;
const sourceUrl = z
  .url()
  .max(2048)
  .refine((value) => value.startsWith("https://"));
export const trademarkLookupSchema = z.strictObject({
  query: providerTargetSchema.refine((value) => value.tool === "trademarks"),
  searched: z.array(z.literal("EM")).max(1),
  missing: z.array(z.string().min(2).max(32)).max(20),
  hits: z
    .array(
      z.strictObject({
        registryId: z.string().regex(/^\d{9}$/),
        mark: z.string().min(1).max(160),
        niceClasses: z.array(z.number().int().min(1).max(45)).max(45),
        status: z.string().min(1).max(100),
      }),
    )
    .max(500),
  checkedAt: z.iso.datetime(),
  datasetAsOf: z.null(),
  completeness: z.literal("partial"),
  interrupted: providerFailureCodeSchema.nullable(),
  sourceUrl,
  legalClearance: z.literal("not_assessed"),
  filing: z.literal("not_submitted"),
});
export type TrademarkLookup = z.infer<typeof trademarkLookupSchema>;
export const standaloneLookupResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("domain"), check: domainCheckSchema, quote: domainQuoteSchema.nullable() }),
  z.strictObject({ status: z.literal("handle"), evidence: evidenceSchema }),
  z.strictObject({ status: z.literal("trademark"), research: trademarkLookupSchema }),
  z.strictObject({
    status: z.literal("failed"),
    code: providerFailureCodeSchema,
    retryAfterSeconds: z.number().int().min(0).max(86400).nullable(),
  }),
]);
export type StandaloneLookupResult = z.infer<typeof standaloneLookupResultSchema>;
export const standaloneLookupResponseSchema = z.strictObject({
  ownerId: z.uuid(),
  result: standaloneLookupResultSchema,
});
export const standaloneCapabilitiesSchema = z.strictObject({
  ownerId: z.uuid(),
  domains: z.enum(["rdap", "cloudflare", "vercel", "namecom", "unavailable"]),
  youtube: z.boolean(),
  euipo: z.boolean(),
});
export type StandaloneCapabilities = z.infer<typeof standaloneCapabilitiesSchema>;
export const lookupFailureMessage: Record<z.infer<typeof providerFailureCodeSchema>, string> = {
  unavailable: "This provider is not connected.",
  unsupported_target:
    "This provider does not support this exact lookup. Continue with the official registry or profile link.",
  not_authorized: "The provider did not authorize this lookup. No availability result was established.",
  rate_limited: "The lookup limit was reached. Wait a minute before checking again.",
  timeout: "The provider did not respond in time. Completed results are retained.",
  cancelled: "Check cancelled.",
  transport: "The provider could not be reached. No availability result was established.",
  invalid_response: "The provider response could not be verified. No availability result was established.",
};
