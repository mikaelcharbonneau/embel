import "server-only";
import { z } from "zod";
import {
  identityReferenceQuerySchema,
  identityReferencesOverviewSchema,
  referenceSourceResultSchema,
  setReferenceReactionResponseSchema,
  setReferenceReactionSchema,
  type IdentityReferencesOverview,
  type SetReferenceReactionResponse,
} from "@/domain/identity-references";
import type { AuthenticatedContext } from "../auth/context";
import { defaultReferenceSource } from "../identity/reference-source";
import { ApiError } from "../http/errors";

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError("invalid_input");
  return result.data;
}
function stored<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError("integration_unavailable");
  return result.data;
}
function id(value: string): string {
  if (!z.uuid().safeParse(value).success) throw new ApiError("not_found");
  return value.toLowerCase();
}
function queryInput(value: unknown) {
  const query = input(identityReferenceQuerySchema, value);
  // PostgreSQL serializes UUIDs canonically. Normalize before ownership checks
  // and intent/echo comparisons so a committed mutation cannot appear to fail.
  return query.cursor
    ? {
        ...query,
        cursor: { ...query.cursor, projectId: id(query.cursor.projectId), referenceId: id(query.cursor.referenceId) },
      }
    : query;
}
function invariant(value: boolean): asserts value {
  if (!value) throw new ApiError("integration_unavailable");
}
function scope(auth: AuthenticatedContext, projectId: string, value: { ownerId: string; projectId: string }): void {
  if (value.ownerId !== auth.userId || value.projectId !== projectId) throw new ApiError("not_found");
}
function databaseError(error: { code?: unknown } | null): void {
  if (!error) return;
  if (["P0002", "PGRST116"].includes(String(error.code))) throw new ApiError("not_found");
  if (["PT409", "23505", "40001"].includes(String(error.code))) throw new ApiError("conflict");
  if (["22023", "23514", "23502", "22P02", "22007", "22008", "22003"].includes(String(error.code)))
    throw new ApiError("invalid_input");
  throw new ApiError("integration_unavailable");
}
async function ownedProject(auth: AuthenticatedContext, projectId: string): Promise<void> {
  const { data, error } = await auth.client
    .from("projects")
    .select("id,owner_id")
    .eq("id", projectId)
    .eq("owner_id", auth.userId)
    .maybeSingle();
  if (error) throw new ApiError("integration_unavailable");
  if (!data || data.id !== projectId || data.owner_id !== auth.userId) throw new ApiError("not_found");
}

/** Persisted rows remain visible if discovery is disconnected. GET never imports
 * source rows or fetches attribution URLs. Authorization precedes adapter access. */
export async function getIdentityReferences(
  auth: AuthenticatedContext,
  projectId: string,
  value: unknown = {},
): Promise<IdentityReferencesOverview> {
  projectId = id(projectId);
  const query = queryInput(value);
  if (query.cursor && query.cursor.projectId !== projectId) throw new ApiError("invalid_input");
  await ownedProject(auth, projectId);
  const result = await auth.client.rpc("get_identity_references", { p_project_id: projectId, p_query: query });
  databaseError(result.error);
  const response = stored(identityReferencesOverviewSchema, result.data);
  scope(auth, projectId, response);
  invariant(JSON.stringify(response.query) === JSON.stringify(query));
  const source = stored(referenceSourceResultSchema, await defaultReferenceSource.list(auth, projectId, query));
  if (source.status === "available") {
    scope(auth, projectId, source);
    invariant(JSON.stringify(source.query) === JSON.stringify(query));
  }
  return { ...response, feed: source.status === "available" ? { status: "available" } : source };
}

/** The RPC performs the project lock and exact CAS atomically. The receipt cannot
 * substitute a different selection or imply that a client's page was refreshed. */
export async function setReferenceReaction(
  auth: AuthenticatedContext,
  projectId: string,
  referenceId: string,
  value: unknown,
): Promise<SetReferenceReactionResponse> {
  projectId = id(projectId);
  referenceId = id(referenceId);
  const parsed = input(setReferenceReactionSchema, value);
  const result = await auth.client.rpc("set_identity_reference_reaction", {
    p_project_id: projectId,
    p_reference_id: referenceId,
    p_input: parsed,
  });
  databaseError(result.error);
  const response = stored(setReferenceReactionResponseSchema, result.data);
  scope(auth, projectId, response);
  invariant(
    response.entry.reference.id === referenceId &&
      response.entry.reaction.revision === parsed.expectedRevision + 1 &&
      response.entry.reaction.ensemble === parsed.ensemble &&
      JSON.stringify(response.entry.reaction.elements) === JSON.stringify(parsed.elements),
  );
  return response;
}

/** Bound raw query bytes before URLSearchParams/JSON work. Scalar repetition and
 * unknown fields fail; excludedTag alone is intentionally repeatable. */
export function readIdentityReferenceQuery(request: Request) {
  const url = new URL(request.url);
  if (new TextEncoder().encode(url.search).byteLength > 32_768) throw new ApiError("invalid_input");
  const params = url.searchParams;
  for (const key of params.keys())
    if (!["limit", "cursor", "excludedTag"].includes(key) || (key !== "excludedTag" && params.getAll(key).length !== 1))
      throw new ApiError("invalid_input");
  const value: Record<string, unknown> = { excludedTags: params.getAll("excludedTag") };
  const limit = params.get("limit"),
    cursor = params.get("cursor");
  if (limit !== null) {
    if (!/^[0-9]+$/.test(limit)) throw new ApiError("invalid_input");
    value.limit = Number(limit);
  }
  if (cursor !== null) {
    try {
      value.cursor = JSON.parse(cursor);
    } catch {
      throw new ApiError("invalid_input");
    }
  }
  return queryInput(value);
}
