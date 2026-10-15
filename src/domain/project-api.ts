import { z } from "zod";
import { contextSnapshotSchema, projectScopeSchema } from "./projects";

// Public response contracts only. Authorization stays in the server and database.
// Individual field bounds do not replace the combined UTF-8 request limit.
export const PROJECT_MUTATION_MAX_BYTES = 32_768;
export const accountSessionSchema = z.strictObject({ user: z.strictObject({ id: z.uuid() }) });

export const accountProjectSummarySchema = z.object({
  id: z.uuid(),
  owner_id: z.uuid(),
  scope: projectScopeSchema,
  title: z.string().trim().min(1).max(160),
  current_revision: z.number().int().positive(),
  created_at: z.string(),
  // Older RPC readers remain compatible; listing and lifecycle mutations require these fields.
  deleted_at: z.iso.datetime({ offset: true }).nullable().optional(),
  lifecycle_version: z.number().int().nonnegative().optional(),
});
export const accountProjectSchema = accountProjectSummarySchema.extend({ context: contextSnapshotSchema });
export const accountRevisionSchema = z.object({
  project_id: z.uuid(),
  owner_id: z.uuid(),
  revision: z.number().int().positive(),
  context: contextSnapshotSchema,
  input_hash: z.string(),
  created_at: z.string(),
});
export const accountProjectListSchema = z.strictObject({ projects: z.array(accountProjectSummarySchema).max(100) });
export const accountProjectResponseSchema = z.strictObject({ project: accountProjectSchema });
export const accountRevisionResponseSchema = z.strictObject({ revision: accountRevisionSchema });
export const updateProjectInputSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  context: contextSnapshotSchema,
  title: z.string().trim().min(1).max(160).optional(),
});
export const expandProjectInputSchema = z.strictObject({ expectedRevision: z.number().int().positive() });

export type AccountProjectSummary = z.infer<typeof accountProjectSummarySchema>;
export type AccountProject = z.infer<typeof accountProjectSchema>;
export type AccountRevision = z.infer<typeof accountRevisionSchema>;
