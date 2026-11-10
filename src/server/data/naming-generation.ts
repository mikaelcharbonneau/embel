import "server-only";
import { z } from "zod";
import {
  namingFeedCursorSchema,
  namingUsageSchema,
  type NamingFeedCursor,
  type NamingGenerationFeed,
  type NamingRun,
  type NamingUsage,
} from "@/domain/naming-generation";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError, type ApiErrorCode } from "../http/errors";
import { normalizeNamingRows } from "./project-naming";

/**
 * Naming generation (November 2026 rebuild): thin owner-scoped wrappers over the
 * definer RPCs in docs/archive/naming-generation-contract.md. SQL owns admission, the
 * frozen brief and duplicate prevention; this module validates shapes, checks
 * that every row belongs to the signed-in account and maps errors to HTTP.
 */
export const NAMING_FEED_PAGE_LIMIT = 100;

const conflictCodes: readonly ApiErrorCode[] = ["naming_active", "project_revision_changed", "preferences_changed"];
const inputCodes: readonly ApiErrorCode[] = ["preferences_incomplete", "invalid_naming_request"];

/** The contract raises its code as the exception message; never echo other text. */
export function namingDatabaseError(error: { code?: unknown; message?: unknown }): ApiError {
  const code = String(error.code ?? ""),
    message = String(error.message ?? "") as ApiErrorCode;
  if (["PGRST301", "PGRST302", "PGRST303", "42501"].includes(code)) return new ApiError("unauthenticated");
  if (["P0002", "PGRST116"].includes(code)) return new ApiError("not_found");
  if (code === "40001") return new ApiError(conflictCodes.includes(message) ? message : "conflict");
  if (code === "22023") return new ApiError(inputCodes.includes(message) ? message : "invalid_input");
  if (code === "55000") return new ApiError("naming_unavailable");
  if (code === "23505") return new ApiError("conflict");
  if (["23514", "22P02", "23502"].includes(code)) return new ApiError("invalid_input");
  return new ApiError("integration_unavailable");
}

export function projectKey(value: string) {
  if (!z.uuid().safeParse(value).success) throw new ApiError("not_found");
  return value.toLowerCase();
}
function stored<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError("integration_unavailable");
  return parsed.data;
}
export async function rpc<T>(
  auth: AuthenticatedContext,
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const { data, error } = await auth.client.rpc(name, args);
  if (error) throw namingDatabaseError(error);
  return stored(schema, normalizeNamingRows(data, auth.userId));
}

/** Every entry must be one of this project's generated names. */
export function verifyFeed(
  auth: AuthenticatedContext,
  projectId: string,
  feed: NamingGenerationFeed,
): NamingGenerationFeed {
  if (feed.projectId !== projectId) throw new ApiError("not_found");
  const seen = new Set<string>();
  for (const row of feed.entries) {
    const { candidate, retention } = row.entry;
    if (
      candidate.ownerId !== auth.userId ||
      candidate.projectId !== projectId ||
      retention.ownerId !== auth.userId ||
      retention.projectId !== projectId ||
      retention.candidateId !== candidate.id
    )
      throw new ApiError("not_found");
    if (candidate.origin.kind !== "brainstorm" || candidate.origin.runId !== row.runId || seen.has(candidate.id))
      throw new ApiError("integration_unavailable");
    seen.add(candidate.id);
  }
  return feed;
}

export type NamingStartResult = { feed: NamingGenerationFeed; run: NamingRun; reused: boolean };

export type NamingJobUsage = NamingUsage & { jobId: string };
const usageRowSchema = z.strictObject({ jobId: z.uuid(), ...namingUsageSchema.shape });

/** Token counts recorded by a run's saved rounds. Jobs without saved rounds are omitted. */
export async function getNamingUsage(auth: AuthenticatedContext, jobIds: readonly string[]): Promise<NamingJobUsage[]> {
  const ids = [...new Set(jobIds.map((value) => value.toLowerCase()))];
  if (!ids.length) return [];
  if (ids.length > 100 || ids.some((value) => !z.uuid().safeParse(value).success)) throw new ApiError("invalid_input");
  const rows = await rpc(auth, "get_naming_usage", { p_jobs: ids }, z.array(usageRowSchema).max(ids.length));
  const seen = new Set<string>();
  for (const row of rows) {
    if (!ids.includes(row.jobId) || seen.has(row.jobId)) throw new ApiError("integration_unavailable");
    seen.add(row.jobId);
  }
  return rows;
}

/** GET feed query: an optional paired `(createdAt, id)` cursor and a bounded limit. */
export function readNamingFeedQuery(request: Request): { cursor?: NamingFeedCursor; limit: number } {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys())
    if (!["cursorCreatedAt", "cursorId", "limit"].includes(key) || params.getAll(key).length !== 1)
      throw new ApiError("invalid_input");
  if (params.has("cursorCreatedAt") !== params.has("cursorId")) throw new ApiError("invalid_input");
  let cursor: NamingFeedCursor | undefined;
  if (params.has("cursorId")) {
    const parsed = namingFeedCursorSchema.safeParse({
      createdAt: params.get("cursorCreatedAt"),
      id: params.get("cursorId"),
    });
    if (!parsed.success) throw new ApiError("invalid_input");
    cursor = parsed.data;
  }
  const limit = params.has("limit") ? Number(params.get("limit")) : NAMING_FEED_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > NAMING_FEED_PAGE_LIMIT) throw new ApiError("invalid_input");
  return { ...(cursor ? { cursor } : {}), limit };
}
