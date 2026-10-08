import "server-only";
import { z } from "zod";
import type { LogoBillingObservation } from "../../domain/logo-jobs";
import type { LogoImageConfiguration } from "./openai-logo-provider";
import { logoImageUsageSchema } from "./openai-image-usage";

/** Official Standard rates checked 2026-10-07. This version is deliberately
 * independent of the mutable application's current-model selection.
 * https://developers.openai.com/api/docs/pricing
 * https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst
 * https://developers.openai.com/api/docs/guides/image-generation#cost-and-latency
 * Direct synchronous Images generations AND edits use the full input rates;
 * Responses cached-input discounts and Batch prices do not apply. */
export const SUNBURST_STANDARD_IMAGE_PRICING = Object.freeze({
  binding: Object.freeze({ model: "gpt-image-2.5-sunburst-2026-09-08", api: "direct-images", serviceTier: "standard", rateVersion: "2026-10-07.v1" } as const),
  currency: "USD" as const,
  verifiedAt: "2026-10-07" as const,
  endpoints: Object.freeze(["/v1/images/generations", "/v1/images/edits"] as const),
  microusdPerToken: Object.freeze({ textInput: 5, imageInput: 8, imageOutput: 30 } as const),
});
const basis = SUNBURST_STANDARD_IMAGE_PRICING.binding;
const bindingSchema = z.strictObject({ model: z.literal(basis.model), api: z.literal(basis.api),
  serviceTier: z.literal(basis.serviceTier), rateVersion: z.literal(basis.rateVersion) });
export type LogoImagePricingBinding = { model: string; api: string; serviceTier: string; rateVersion: string };
const unknown: LogoBillingObservation = Object.freeze({ status: "unknown", confirmedMicrousd: null });

/** Explicit injection into LogoImageConfiguration.priceUsage only. This does
 * not create configuration, admit a policy, verify access, or establish a
 * predispatch reservation. Trusted composition must bind this exact basis to
 * its separately reviewed immutable policy identity. Unsupported bases fail
 * closed, and incomplete usage never becomes a zero-cost observation. */
export function createSunburstStandardImageUsagePricer(binding: LogoImagePricingBinding): LogoImageConfiguration["priceUsage"] | null {
  if (!bindingSchema.safeParse(binding).success) return null;
  const rates = SUNBURST_STANDARD_IMAGE_PRICING.microusdPerToken;
  return usage => {
    const parsed = logoImageUsageSchema.safeParse(usage);
    if (!parsed.success) return unknown;
    const value = parsed.data;
    const charge = BigInt(value.input_tokens_details.text_tokens) * BigInt(rates.textInput)
      + BigInt(value.input_tokens_details.image_tokens) * BigInt(rates.imageInput)
      + BigInt(value.output_tokens) * BigInt(rates.imageOutput);
    if (charge > BigInt(Number.MAX_SAFE_INTEGER)) return unknown;
    // No reservation/cap enters this calculation: retain the actual observed
    // charge, including an overrun. Explicit complete zero usage is valid.
    return { status: "recorded", confirmedMicrousd: Number(charge) };
  };
}
