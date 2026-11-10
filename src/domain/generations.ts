import { z } from "zod";

/** What the browser sees of a generation run: status, timing and outputs.
 * Never the frozen input, the workflow id or any cost (docs/generation-engine.md). */
export const generationRunSchema = z.strictObject({
  id: z.uuid(),
  kind: z
    .string()
    .regex(/^[a-z]+(\.[a-z_]+)+$/u)
    .max(64),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  credits: z.number().int().nonnegative(),
  errorCode: z.string().max(64).nullable(),
  cancelRequested: z.boolean(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  /** The project revision the run was admitted against, when its kind has one. */
  inputRevision: z.number().int().positive().nullable(),
  outputs: z.array(z.strictObject({ key: z.string().min(1).max(64), output: z.unknown() })).max(20),
});
export type GenerationRun = z.infer<typeof generationRunSchema>;
export const generationRunResponseSchema = z.strictObject({ run: generationRunSchema });
export const generationListResponseSchema = z.strictObject({ runs: z.array(generationRunSchema).max(64) });

/** Credits, never prices. */
export const creditSummarySchema = z.strictObject({
  planId: z.string(),
  balance: z.number().int(),
  periodEnd: z.string(),
});
export const creditSummaryResponseSchema = z.strictObject({ credits: creditSummarySchema });
