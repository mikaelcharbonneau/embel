import { z } from "zod";

export const jobStatusSchema = z.enum([
  "queued",
  "running",
  "partial",
  "cancel_requested",
  "cancelled",
  "succeeded",
  "failed",
  "needs_reconciliation",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;
export const moneySchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const stepOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("succeeded"),
    result: z.json(),
    costMicrousd: moneySchema,
    providerRequestId: z.string().max(200).nullable().default(null),
  }),
  z.strictObject({
    status: z.literal("failed"),
    code: z.string().max(100),
    result: z.json().optional(),
    costMicrousd: moneySchema,
    providerRequestId: z.string().max(200).nullable().default(null),
  }),
  z.strictObject({
    status: z.literal("needs_reconciliation"),
    code: z.string().max(100),
    result: z.json().optional(),
    costMicrousd: moneySchema,
    providerRequestId: z.string().max(200).nullable().default(null),
  }),
]);
export type StepOutcome = z.infer<typeof stepOutcomeSchema>;

export type ClaimedJob = {
  id: string;
  ownerId: string;
  projectId: string;
  operation: string;
  input: unknown;
  inputRevision: number;
  leaseToken: string;
  status: JobStatus;
  reservedCostMicrousd: number;
  actualCostMicrousd: number;
};
