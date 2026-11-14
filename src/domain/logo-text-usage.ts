import { z } from "zod";
import { moneySchema } from "./jobs";

/** Token counts of one text request, and the price of those tokens at the fixed Creative
 * direction rates (microdollars). Recorded with each style-note and direction reply. */
export const logoTextUsageSchema = z
  .strictObject({
    inputTokens: moneySchema,
    cachedInputTokens: moneySchema,
    cacheWriteInputTokens: moneySchema,
    outputTokens: moneySchema,
  })
  .refine((u) => u.cachedInputTokens + u.cacheWriteInputTokens <= u.inputTokens, "Input token subcounts exceed total");
type LogoTextUsage = z.infer<typeof logoTextUsageSchema>;
export function logoTextUsageCost(usage: LogoTextUsage): number {
  const u = logoTextUsageSchema.parse(usage);
  const total =
    BigInt(u.inputTokens - u.cachedInputTokens - u.cacheWriteInputTokens) * 2_000_000n +
    BigInt(u.cachedInputTokens) * 100_000n +
    BigInt(u.cacheWriteInputTokens) * 2_500_000n +
    BigInt(u.outputTokens) * 10_000_000n;
  const value = Number((total + 999_999n) / 1_000_000n);
  return moneySchema.parse(value);
}
