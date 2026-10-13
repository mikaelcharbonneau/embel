import "server-only";
import { z } from "zod";
import { inspirationCatalog, inspirationMutationSchema, inspirationOverviewSchema, sameInspirationChoice, type InspirationOverview } from "@/domain/inspiration";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ApiError } from "@/server/http/errors";

function uuid(value: string) {
  const result = z.uuid().safeParse(value);
  if (!result.success) throw new ApiError("not_found");
  return result.data.toLowerCase();
}
async function call(auth: AuthenticatedContext, projectId: string, name: string, args: Record<string, unknown>): Promise<InspirationOverview> {
  const result = await auth.client.rpc(name, args);
  if (result.error) {
    if (result.error.code === "P0002") throw new ApiError("not_found");
    if (["PT409", "40001", "23505"].includes(result.error.code)) throw new ApiError("conflict");
    if (["22023", "23514", "22P02"].includes(result.error.code)) throw new ApiError("invalid_input");
    throw new ApiError("integration_unavailable");
  }
  const parsed = inspirationOverviewSchema.safeParse(result.data);
  if (!parsed.success) throw new ApiError("integration_unavailable");
  if (parsed.data.ownerId !== auth.userId || parsed.data.projectId !== projectId) throw new ApiError("not_found");
  return parsed.data;
}
export async function getProjectInspiration(auth: AuthenticatedContext, id: string) {
  const projectId = uuid(id);
  return call(auth, projectId, "get_project_inspiration", { p_project_id: projectId });
}
export async function setProjectInspiration(auth: AuthenticatedContext, id: string, reference: string, value: unknown) {
  const projectId = uuid(id), referenceId = uuid(reference), parsed = inspirationMutationSchema.safeParse(value);
  const design = inspirationCatalog.find(item => item.id === referenceId);
  if (!parsed.success || !design || parsed.data.elements.some(element => !design.elements.includes(element))) throw new ApiError("invalid_input");
  const result = await call(auth, projectId, "set_project_inspiration_reaction", { p_project_id: projectId, p_reference_id: referenceId, p_input: parsed.data });
  const choice = result.choices.find(item => item.referenceId === referenceId);
  if (result.projectRevision !== parsed.data.expectedProjectRevision || !choice || choice.revision !== parsed.data.expectedRevision + 1 || !sameInspirationChoice(choice, parsed.data)) throw new ApiError("integration_unavailable");
  return result;
}
