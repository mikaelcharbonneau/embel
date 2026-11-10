import "server-only";
import { z } from "zod";
import {
  sameScreeningBasis,
  screeningCheckInputSchema,
  screeningCheckResponseSchema,
  screeningCursorSchema,
  screeningOverviewSchema,
  screeningRecordInputSchema,
  screeningRecordSchema,
  type ScreeningBasis,
  type ScreeningCursor,
} from "@/domain/project-screening";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ApiError } from "@/server/http/errors";
import { runStandaloneLookup } from "@/server/standalone-providers/live-runtime";

function id(raw: string): string {
  const value = z.uuid().safeParse(raw);
  if (!value.success) throw new ApiError("not_found");
  return value.data.toLowerCase();
}
function input<T>(schema: z.ZodType<T>, raw: unknown): T {
  const value = schema.safeParse(raw);
  if (!value.success) throw new ApiError("invalid_input");
  return value.data;
}
async function rpc<T>(
  auth: AuthenticatedContext,
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const result = await auth.client.rpc(name, args);
  if (result.error) {
    if (result.error.code === "P0002") throw new ApiError("not_found");
    if (["PT409", "23505", "40001"].includes(result.error.code)) throw new ApiError("conflict");
    if (["22023", "23514", "22P02", "22007", "22008"].includes(result.error.code)) throw new ApiError("invalid_input");
    throw new ApiError("integration_unavailable");
  }
  const value = schema.safeParse(result.data);
  if (!value.success) throw new ApiError("integration_unavailable");
  return value.data;
}
function scope(auth: AuthenticatedContext, projectId: string, value: { ownerId: string; projectId: string }) {
  if (value.ownerId !== auth.userId || value.projectId !== projectId) throw new ApiError("not_found");
}
export async function getProjectScreening(auth: AuthenticatedContext, rawId: string, cursor?: ScreeningCursor) {
  const projectId = id(rawId);
  const result = await rpc(
    auth,
    "get_project_screening",
    { p_project_id: projectId, p_cursor: cursor ? input(screeningCursorSchema, cursor) : null },
    screeningOverviewSchema,
  );
  scope(auth, projectId, result);
  return result;
}
export async function recordProjectScreening(auth: AuthenticatedContext, rawId: string, raw: unknown) {
  const projectId = id(rawId),
    value = input(screeningRecordInputSchema, raw);
  if (Date.parse(value.observedAt) > Date.now()) throw new ApiError("invalid_input");
  value.selectionId = value.selectionId.toLowerCase();
  value.requestId = value.requestId.toLowerCase();
  const result = await rpc(
    auth,
    "record_project_screening",
    { p_project_id: projectId, p_input: value },
    screeningRecordSchema,
  );
  scope(auth, projectId, result.basis);
  if (
    result.requestId !== value.requestId ||
    result.basis.selectionId !== value.selectionId ||
    result.basis.projectRevision !== value.expectedProjectRevision ||
    JSON.stringify(result.criteria) !== JSON.stringify(value.criteria) ||
    result.notes !== value.notes ||
    JSON.stringify(result.sourceUrls) !== JSON.stringify(value.sourceUrls) ||
    Date.parse(result.observedAt) !== Date.parse(value.observedAt)
  )
    throw new ApiError("integration_unavailable");
  return result;
}
function requireBasis(
  basis: ScreeningBasis | null,
  value: z.infer<typeof screeningCheckInputSchema>,
): asserts basis is ScreeningBasis {
  if (
    !basis ||
    basis.selectionId !== value.selectionId.toLowerCase() ||
    basis.projectRevision !== value.expectedProjectRevision
  )
    throw new ApiError("conflict");
  if (value.criteria.tool === "trademarks" && value.criteria.mark !== basis.name) throw new ApiError("invalid_input");
}
/** Read-only live check; never accepts or persists a browser's claimed provider result. */
export async function checkProjectScreening(
  auth: AuthenticatedContext,
  rawId: string,
  raw: unknown,
  signal: AbortSignal,
) {
  const projectId = id(rawId),
    value = input(screeningCheckInputSchema, raw);
  const before = await getProjectScreening(auth, projectId);
  requireBasis(before.currentBasis, value);
  if (signal.aborted) throw new ApiError("integration_unavailable");
  const result = await runStandaloneLookup(auth.userId, value.criteria, signal);
  if (signal.aborted) throw new ApiError("integration_unavailable");
  const after = await getProjectScreening(auth, projectId);
  if (signal.aborted) throw new ApiError("integration_unavailable");
  if (!sameScreeningBasis(before.currentBasis, after.currentBasis)) throw new ApiError("conflict");
  const response = screeningCheckResponseSchema.safeParse({
    basis: before.currentBasis,
    criteria: value.criteria,
    result,
    completedAt: new Date().toISOString(),
  });
  if (!response.success) throw new ApiError("integration_unavailable");
  return response.data;
}
export function readScreeningCursor(request: Request): ScreeningCursor | undefined {
  const url = new URL(request.url);
  if (
    url.search.length > 1024 ||
    [...url.searchParams.keys()].some((key) => key !== "cursor") ||
    url.searchParams.getAll("cursor").length > 1
  )
    throw new ApiError("invalid_input");
  const value = url.searchParams.get("cursor");
  if (value === null) return undefined;
  try {
    return input(screeningCursorSchema, JSON.parse(value));
  } catch {
    throw new ApiError("invalid_input");
  }
}
