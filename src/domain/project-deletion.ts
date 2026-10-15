import { z } from "zod";
import { accountProjectSummarySchema } from "./project-api";

/** Lifecycle CAS is independent of immutable context revision history. */
export const projectDeletionInputSchema = z.strictObject({
  expectedRevision: z.number().int().positive().max(2_147_483_647),
  expectedLifecycleVersion: z.number().int().min(0).max(2_147_483_646),
});
export const projectDeletionSummarySchema = accountProjectSummarySchema.extend({
  deleted_at: z.iso.datetime({ offset: true }).nullable(),
  lifecycle_version: z.number().int().min(0).max(2_147_483_647),
});
export const projectDeletionResponseSchema = z.strictObject({ project: projectDeletionSummarySchema });
export type ProjectDeletionInput = z.infer<typeof projectDeletionInputSchema>;
export type ProjectDeletionSummary = z.infer<typeof projectDeletionSummarySchema>;
