import "server-only";
import { z } from "zod";
import type { AccountProjectSummary } from "@/domain/project-api";
import { projectDeletionInputSchema, projectDeletionStateSchema, projectDeletionSummarySchema, projectStopDeletionInputSchema } from "@/domain/project-deletion";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";

export class ProjectDeletionRetryError extends ApiError {
  constructor() { super("conflict"); }
}
function databaseError(error: { code?: string; message?: string } | null) {
  if (!error) return;
  if (error.code === "P0002") throw new ApiError("not_found");
  if (error.code === "PT409" && error.message === "project_deletion_retry") throw new ProjectDeletionRetryError();
  if (["40001", "PT409", "23505"].includes(error.code ?? "")) throw new ApiError("conflict");
  if (["22023", "23514", "23502", "22003"].includes(error.code ?? "")) throw new ApiError("invalid_input");
  throw new ApiError("integration_unavailable");
}
function ownedSummary(auth: AuthenticatedContext, projectId: string, data: unknown) {
  const project = projectDeletionSummarySchema.safeParse(data);
  if (!project.success) throw new ApiError("integration_unavailable");
  const p = project.data;
  if (p.owner_id.toLowerCase() !== auth.userId.toLowerCase() || p.id.toLowerCase() !== projectId.toLowerCase()) throw new ApiError("not_found");
  if ((p.deletion_state === "active") !== (p.deleted_at === null && p.deletion_requested_at === null) ||
      (p.deleted_at !== null && p.deletion_state !== "deleted")) throw new ApiError("integration_unavailable");
  return p;
}

export async function setProjectDeleted(auth: AuthenticatedContext, projectId: string, input: unknown, deleted: boolean) {
  if (!z.uuid().safeParse(projectId).success) throw new ApiError("not_found");
  const parsed = (deleted ? projectStopDeletionInputSchema : projectDeletionInputSchema).safeParse(input);
  if (!parsed.success) throw new ApiError("invalid_input");
  const args = { p_project_id: projectId, p_expected_revision: parsed.data.expectedRevision, p_expected_lifecycle_version: parsed.data.expectedLifecycleVersion };
  // Only retry the explicit lock-contention sentinel, whose entire SQL transaction
  // has rolled back. Never retry unknown outcomes or ordinary lifecycle conflicts.
  let data: unknown;
  for (let attempt = 0; ; attempt++) {
    const result = await auth.client.rpc(deleted ? "request_project_deletion" : "restore_project_deletion", args);
    if (deleted && result.error?.code === "PT409" && result.error.message === "project_deletion_retry" && attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
      continue;
    }
    databaseError(result.error); data = result.data; break;
  }
  const project = ownedSummary(auth, projectId, data);
  if ((project.deletion_state !== "active") !== deleted || project.current_revision !== parsed.data.expectedRevision ||
      project.lifecycle_version !== parsed.data.expectedLifecycleVersion + 1) throw new ApiError("integration_unavailable");
  return project;
}

export async function getProjectDeletion(auth: AuthenticatedContext, projectId: string) {
  if (!z.uuid().safeParse(projectId).success) throw new ApiError("not_found");
  const { data, error } = await auth.client.rpc("get_project_deletion", { p_project_id: projectId });
  databaseError(error);
  return ownedSummary(auth, projectId, data);
}

const lifecycleSchema = z.object({
  id: z.uuid(), owner_id: z.uuid(), current_revision: z.number().int().positive(), lifecycle_version: z.number().int().nonnegative(),
  deleted_at: z.iso.datetime({ offset: true }).nullable(), deletion_requested_at: z.iso.datetime({ offset: true }).nullable(),
  deletion_state: projectDeletionStateSchema,
});
/** One bounded owner read. Never merge a concurrent Restore into a stale page. */
export async function enrichProjectDeletionStates(auth: AuthenticatedContext, rows: readonly AccountProjectSummary[]) {
  if (rows.length > 100 || new Set(rows.map(row => row.id.toLowerCase())).size !== rows.length || rows.some(row => row.owner_id !== auth.userId)) throw new ApiError("integration_unavailable");
  if (!rows.length) return [];
  const { data, error } = await auth.client.rpc("get_project_deletion_states", { p_project_ids: rows.map(row => row.id) });
  databaseError(error);
  const parsed = z.array(lifecycleSchema).max(100).safeParse(data);
  if (!parsed.success || parsed.data.length !== rows.length || new Set(parsed.data.map(row => row.id.toLowerCase())).size !== rows.length) throw new ApiError("integration_unavailable");
  return rows.map(row => {
    const state = parsed.data.find(item => item.id.toLowerCase() === row.id.toLowerCase());
    if (!state || state.owner_id !== auth.userId || state.current_revision !== row.current_revision || state.lifecycle_version !== row.lifecycle_version ||
        state.deleted_at !== row.deleted_at || state.deletion_requested_at !== row.deletion_requested_at) throw new ApiError("integration_unavailable");
    return ownedSummary(auth, row.id, { ...row, ...state });
  });
}
