import { z } from "zod";
import { operationSchema } from "./providers";

export const jobStatusSchema = z.enum(["queued", "running", "partial", "cancel_requested", "cancelled", "succeeded", "failed", "needs_reconciliation"]);
export type JobStatus = z.infer<typeof jobStatusSchema>;
export const moneySchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const enqueueJobSchema = z.strictObject({
  projectId: z.uuid(),
  operation: operationSchema,
  inputRevision: z.number().int().positive(),
  idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  // The server resolves inputs and computes the estimate; the browser may only accept a cap.
  acceptedMaxCostMicrousd: moneySchema,
});

export const stepOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("succeeded"), result: z.json(), costMicrousd: moneySchema, providerRequestId: z.string().max(200).nullable().default(null) }),
  z.strictObject({ status: z.literal("failed"), code: z.string().max(100), result: z.json().optional(), costMicrousd: moneySchema, providerRequestId: z.string().max(200).nullable().default(null) }),
  z.strictObject({ status: z.literal("needs_reconciliation"), code: z.string().max(100), result: z.json().optional(), costMicrousd: moneySchema, providerRequestId: z.string().max(200).nullable().default(null) }),
]);
export type StepOutcome = z.infer<typeof stepOutcomeSchema>;

export type ClaimedJob = {
  id: string; ownerId: string; projectId: string; operation: string;
  input: unknown; inputRevision: number; leaseToken: string;
  status: JobStatus; reservedCostMicrousd: number; actualCostMicrousd: number;
};

export function assertAffordableStep(remainingMicrousd: number, maximumStepMicrousd: number): void {
  moneySchema.parse(remainingMicrousd);
  moneySchema.parse(maximumStepMicrousd);
  if (maximumStepMicrousd > remainingMicrousd) throw new Error("Cost cap exceeded");
}
