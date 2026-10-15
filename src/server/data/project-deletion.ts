import "server-only";
import { z } from "zod";
import { projectDeletionInputSchema, projectDeletionSummarySchema } from "@/domain/project-deletion";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";

/** A safe, specific user-facing conflict; never expose arbitrary database text. */
export class ProjectDeletionBusyError extends ApiError {
  constructor() { super("conflict"); }
}

export async function setProjectDeleted(auth: AuthenticatedContext, projectId: string, input: unknown, deleted: boolean) {
  if (!z.uuid().safeParse(projectId).success) throw new ApiError("not_found");
  const parsed = projectDeletionInputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError("invalid_input");
  const { data, error } = await auth.client.rpc("set_project_deleted", {
    p_project_id: projectId,
    p_expected_revision: parsed.data.expectedRevision,
    p_expected_lifecycle_version: parsed.data.expectedLifecycleVersion,
    p_deleted: deleted,
  }).single();
  if (error) {
    if (error.code === "P0002") throw new ApiError("not_found");
    if (error.code === "PT409" && error.message === "project_busy") throw new ProjectDeletionBusyError();
    if (["40001", "PT409", "23505"].includes(error.code ?? "")) throw new ApiError("conflict");
    if (["22023", "23514", "23502", "22003"].includes(error.code ?? "")) throw new ApiError("invalid_input");
    throw new ApiError("integration_unavailable");
  }
  const project = projectDeletionSummarySchema.safeParse(data);
  if (!project.success) throw new ApiError("integration_unavailable");
  if (project.data.owner_id.toLowerCase() !== auth.userId.toLowerCase() || project.data.id.toLowerCase() !== projectId.toLowerCase()) throw new ApiError("not_found");
  if ((project.data.deleted_at !== null) !== deleted || project.data.current_revision !== parsed.data.expectedRevision ||
      project.data.lifecycle_version !== parsed.data.expectedLifecycleVersion + 1) throw new ApiError("integration_unavailable");
  return project.data;
}
