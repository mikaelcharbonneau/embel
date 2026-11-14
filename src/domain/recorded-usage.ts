import { z } from "zod";
import { strategyOperationSchema } from "./strategy-jobs";

export const RECORDED_USAGE_LIMIT = 20;
export const recordedUsageOperationSchema = z.union([strategyOperationSchema, z.literal("naming.generate")]);
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const recordedTokensSchema = z
  .strictObject({ inputTokens: tokenCount, outputTokens: tokenCount, totalTokens: tokenCount.nullable() })
  .refine((tokens) => tokens.totalTokens === null || tokens.inputTokens + tokens.outputTokens === tokens.totalTokens, {
    message: "Recorded total must match input and output",
  });
export const recordedUsageSchema = z
  .strictObject({
    ownerId: z.uuid(),
    limit: z.literal(RECORDED_USAGE_LIMIT),
    entries: z
      .array(
        z.strictObject({
          id: z.uuid(),
          operation: recordedUsageOperationSchema,
          completedAt: z.iso.datetime({ offset: true }),
          tokens: recordedTokensSchema.nullable(),
        }),
      )
      .max(RECORDED_USAGE_LIMIT),
  })
  .refine((value) => new Set(value.entries.map((entry) => entry.id)).size === value.entries.length, {
    message: "Requests must be unique",
  });
export type RecordedUsage = z.infer<typeof recordedUsageSchema>;
