import { z } from "zod";
import { accountProjectSummarySchema } from "./project-api";

/** Lifecycle CAS is independent of immutable context revision history. */
export const projectDeletionInputSchema = z.strictObject({
  expectedRevision: z.number().int().positive().max(2_147_483_647),
  expectedLifecycleVersion: z.number().int().min(0).max(2_147_483_646),
});
export const projectStopDeletionInputSchema = projectDeletionInputSchema.extend({ stopActiveWork: z.literal(true) });
export const projectDeletionStateSchema = z.enum(["active", "stopping", "awaiting_resolution", "deleted"]);
export function validateProjectDeletionState(
  project: {
    deleted_at: string | null;
    deletion_requested_at: string | null;
    deletion_state: z.infer<typeof projectDeletionStateSchema>;
  },
  ctx: z.RefinementCtx,
) {
  if (
    (project.deletion_state === "active") !== (project.deleted_at === null && project.deletion_requested_at === null) ||
    (project.deleted_at !== null && (project.deletion_state !== "deleted" || project.deletion_requested_at !== null))
  ) {
    ctx.addIssue({ code: "custom", message: "Project lifecycle markers must match its acknowledged deletion state" });
  }
}
export const projectDeletionSummarySchema = accountProjectSummarySchema
  .extend({
    deleted_at: z.iso.datetime({ offset: true }).nullable(),
    deletion_requested_at: z.iso.datetime({ offset: true }).nullable(),
    deletion_state: projectDeletionStateSchema,
    lifecycle_version: z.number().int().min(0).max(2_147_483_647),
  })
  .superRefine(validateProjectDeletionState);
export const projectDeletionResponseSchema = z.strictObject({ project: projectDeletionSummarySchema });
export type ProjectDeletionSummary = z.infer<typeof projectDeletionSummarySchema>;
