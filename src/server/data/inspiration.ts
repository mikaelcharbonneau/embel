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
  const overview = await call(auth, projectId, "get_project_inspiration", { p_project_id: projectId });
  return withAvailableReferences(auth, overview);
}
async function withAvailableReferences(auth: AuthenticatedContext, overview: InspirationOverview): Promise<InspirationOverview> {
  // Additive rollout: new references remain browseable but unsaveable until their
  // immutable catalog rows are installed. Old web clients keep their old RPC shape.
  const fallback = { ...overview, availableReferenceIds: inspirationCatalog.filter(item => !item.availableSince).map(item => item.id) };
  try {
    const available = await auth.client.rpc("get_inspiration_reference_ids");
    const ids = z.array(z.uuid()).max(100).safeParse(available.error ? null : available.data);
    return ids.success ? { ...overview, availableReferenceIds: ids.data.filter(id => inspirationCatalog.some(item => item.id === id)) } : fallback;
  } catch {
    // Optional discovery must never turn an acknowledged selection write into
    // an apparently failed save or encourage replay of a completed mutation.
    return fallback;
  }
}
export async function setProjectInspiration(auth: AuthenticatedContext, id: string, reference: string, value: unknown) {
  const projectId = uuid(id), referenceId = uuid(reference), parsed = inspirationMutationSchema.safeParse(value);
  const design = inspirationCatalog.find(item => item.id === referenceId);
  if (!parsed.success || !design || parsed.data.elements.some(element => !design.elements.includes(element))) throw new ApiError("invalid_input");
  const result = await call(auth, projectId, "set_project_inspiration_reaction", { p_project_id: projectId, p_reference_id: referenceId, p_input: parsed.data });
  const choice = result.choices.find(item => item.referenceId === referenceId);
  if (result.projectRevision !== parsed.data.expectedProjectRevision || !choice || choice.revision !== parsed.data.expectedRevision + 1 || !sameInspirationChoice(choice, parsed.data)) throw new ApiError("integration_unavailable");
  return withAvailableReferences(auth, result);
}
