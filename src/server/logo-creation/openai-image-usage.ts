import "server-only";
import { z } from "zod";

/** Parser/resource bound, not a documented maximum provider charge. */
export const LOGO_IMAGE_TOKEN_COUNT_LIMIT = 1_000_000_000;
const count = z.number().int().nonnegative().max(LOGO_IMAGE_TOKEN_COUNT_LIMIT);

/** Preserve supplied billing evidence; never fill absent totals or modalities.
 * This pinned image-only contract supports older responses without the two
 * optional fields, but rejects contradictory evidence when it is supplied. */
export const logoImageUsageSchema = z.object({
  input_tokens: count,
  output_tokens: count,
  input_tokens_details: z.object({ text_tokens: count, image_tokens: count }),
  total_tokens: z.number().int().nonnegative().max(2 * LOGO_IMAGE_TOKEN_COUNT_LIMIT).optional(),
  output_tokens_details: z.object({ text_tokens: count, image_tokens: count }).optional(),
}).refine(value => value.input_tokens === value.input_tokens_details.text_tokens + value.input_tokens_details.image_tokens)
  .refine(value => value.total_tokens === undefined || value.total_tokens === value.input_tokens + value.output_tokens)
  .refine(value => value.output_tokens_details === undefined
    || (value.output_tokens_details.text_tokens === 0 && value.output_tokens_details.image_tokens === value.output_tokens));

export type LogoImageUsage = z.infer<typeof logoImageUsageSchema>;
