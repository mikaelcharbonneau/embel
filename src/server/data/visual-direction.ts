import "server-only";
import { z } from "zod";
import {
  reviewVisualDirectionSchema,
  visualDirectionOverviewSchema,
  sameVisualGuidance,
  type VisualDirectionOverview,
} from "@/domain/visual-direction";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ApiError } from "@/server/http/errors";

function projectId(value: string) {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new ApiError("not_found");
  return parsed.data.toLowerCase();
}
async function call(
  auth: AuthenticatedContext,
  id: string,
  method: string,
  input?: unknown,
): Promise<VisualDirectionOverview> {
  const result = await auth.client.rpc(method, { p_project_id: id, ...(input ? { p_input: input } : {}) });
  if (result.error) {
    if (result.error.code === "P0002") throw new ApiError("not_found");
    if (["PT409", "40001", "23505"].includes(result.error.code)) throw new ApiError("conflict");
    if (["22023", "23514", "22P02"].includes(result.error.code)) throw new ApiError("invalid_input");
    throw new ApiError("integration_unavailable");
  }
  const parsed = visualDirectionOverviewSchema.safeParse(result.data);
  if (!parsed.success) throw new ApiError("integration_unavailable");
  if (parsed.data.inspiration.ownerId !== auth.userId || parsed.data.inspiration.projectId !== id)
    throw new ApiError("not_found");
  return parsed.data;
}
export async function getVisualDirection(auth: AuthenticatedContext, id: string) {
  return call(auth, projectId(id), "get_project_visual_direction");
}
export async function saveVisualDirection(auth: AuthenticatedContext, id: string, raw: unknown) {
  const input = reviewVisualDirectionSchema.safeParse(raw);
  if (!input.success) throw new ApiError("invalid_input");
  const overview = await call(auth, projectId(id), "review_project_visual_direction", input.data);
  const saved = overview.current;
  if (
    !saved ||
    overview.stale ||
    saved.revision !== input.data.expectedRevision + 1 ||
    saved.projectRevision !== input.data.expectedProjectRevision ||
    saved.selectionRevision !== input.data.expectedSelectionRevision ||
    !sameVisualGuidance(saved.guidance, input.data.guidance)
  )
    throw new ApiError("integration_unavailable");
  return overview;
}
