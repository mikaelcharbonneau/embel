import "server-only";
import { z } from "zod";
import {
  assetDetailQuerySchema,
  assetDetailSchema,
  assetLibraryPageSchema,
  assetLibraryQuerySchema,
  assetRetentionResponseSchema,
  assetSelectionResponseSchema,
  selectAssetVersionSchema,
  setAssetRetentionSchema,
  type AssetDetail,
  type AssetLibraryItem,
  type AssetProjectSummary,
  type AssetVersionDetail,
} from "@/domain/asset-library";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { projectDisplayName, readProjectDisplayNames } from "./project-display-names";

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
function assetId(value: string): string {
  if (!z.uuid().safeParse(value).success) throw new ApiError("not_found");
  return value.toLowerCase();
}
/** Only validated UUID values are canonicalized. Strict schemas still reject
 * unknown fields and malformed values, including owner IDs supplied by callers. */
function canonicalUuid(value: unknown): unknown {
  return typeof value === "string" && z.uuid().safeParse(value).success ? value.toLowerCase() : value;
}
function queryInput<T>(schema: z.ZodType<T>, value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return input(schema, value);
  const normalized = { ...value } as Record<string, unknown>;
  if ("projectId" in normalized) normalized.projectId = canonicalUuid(normalized.projectId);
  if (normalized.cursor && typeof normalized.cursor === "object" && !Array.isArray(normalized.cursor)) {
    const cursor = { ...normalized.cursor } as Record<string, unknown>;
    for (const key of ["assetId", "projectId", "versionId"])
      if (key in cursor) cursor[key] = canonicalUuid(cursor[key]);
    normalized.cursor = cursor;
  }
  return input(schema, normalized);
}
function databaseError(error: { code?: unknown } | null): void {
  if (!error) return;
  if (["P0002", "PGRST116"].includes(String(error.code))) throw new ApiError("not_found");
  if (["PT409", "23505", "40001"].includes(String(error.code))) throw new ApiError("conflict");
  if (["22023", "23514", "23502", "22P02", "22007", "22008", "22003"].includes(String(error.code)))
    throw new ApiError("invalid_input");
  throw new ApiError("integration_unavailable");
}
function invariant(value: boolean): asserts value {
  if (!value) throw new ApiError("integration_unavailable");
}
function scope(auth: AuthenticatedContext, value: { id: string; ownerId: string }, expectedId?: string): void {
  if (value.ownerId !== auth.userId || (expectedId !== undefined && value.id !== expectedId))
    throw new ApiError("not_found");
}
async function rpc<T>(
  auth: AuthenticatedContext,
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await auth.client.rpc(name, args);
  databaseError(response.error);
  return stored(schema, response.data);
}
/** These metadata RPCs never inspect bytes. Verified/missing integrity observations
 * may only come from an actual private-file verification boundary, not a row claim. */
function metadataVersions(versions: readonly AssetVersionDetail[]): void {
  for (const version of versions)
    invariant(
      (version.fileState === "metadata_only" || version.fileState === "unverified") &&
        version.fileVerification === null,
    );
}
function checkDetail(auth: AuthenticatedContext, id: string, response: AssetDetail): void {
  scope(auth, response.asset, id);
  metadataVersions([...response.versions.items, ...(response.selectedVersion ? [response.selectedVersion] : [])]);
}
function checkItem(auth: AuthenticatedContext, item: AssetLibraryItem): void {
  scope(auth, item.asset);
  metadataVersions([
    ...item.matchingVersions.items,
    ...(item.selectedVersion ? [item.selectedVersion] : []),
    ...(item.displayedVersion ? [item.displayedVersion] : []),
  ]);
}
/** Library titles use the project's visible name, as the project bar and cards do. */
async function withProjectNames<T extends { project: AssetProjectSummary }>(
  auth: AuthenticatedContext,
  rows: readonly T[],
): Promise<T[]> {
  const names = await readProjectDisplayNames(
    auth,
    rows.map((row) => row.project),
  );
  return rows.map((row) => ({
    ...row,
    project: {
      ...row.project,
      title: projectDisplayName(row.project.title, names.get(row.project.id.toLowerCase()), 200),
    },
  }));
}
export async function listAccountAssets(auth: AuthenticatedContext, value: unknown = {}) {
  const query = queryInput(assetLibraryQuerySchema, value);
  const response = await rpc(auth, "list_account_assets", { p_query: query }, assetLibraryPageSchema);
  if (response.ownerId !== auth.userId) throw new ApiError("not_found");
  invariant(JSON.stringify(response.query) === JSON.stringify(query));
  for (const item of response.items) checkItem(auth, item);
  return { ...response, items: await withProjectNames(auth, response.items) };
}
export async function getAssetDetail(auth: AuthenticatedContext, id: string, value: unknown = {}) {
  id = assetId(id);
  const query = queryInput(assetDetailQuerySchema, value);
  if (query.cursor && query.cursor.assetId !== id) throw new ApiError("invalid_input");
  const response = await rpc(auth, "get_asset_detail", { p_asset_id: id, p_query: query }, assetDetailSchema);
  checkDetail(auth, id, response);
  invariant(response.versions.format === (query.format ?? null) && response.versions.items.length <= query.limit);
  if (query.cursor) invariant(query.cursor.projectId === response.asset.projectId);
  return (await withProjectNames(auth, [response]))[0]!;
}
export async function setAssetRetention(auth: AuthenticatedContext, id: string, value: unknown) {
  id = assetId(id);
  const parsed = input(setAssetRetentionSchema, value);
  const response = await rpc(
    auth,
    "set_asset_retention",
    {
      p_asset_id: id,
      p_expected_retention_revision: parsed.expectedRetentionRevision,
      p_liked: parsed.liked,
      p_saved: parsed.saved,
    },
    assetRetentionResponseSchema,
  );
  scope(auth, response.asset, id);
  invariant(
    response.asset.retentionRevision === parsed.expectedRetentionRevision + 1 &&
      response.asset.liked === parsed.liked &&
      response.asset.saved === parsed.saved,
  );
  return response;
}
export async function selectAssetVersion(auth: AuthenticatedContext, id: string, value: unknown) {
  id = assetId(id);
  const parsed = input(selectAssetVersionSchema, value);
  parsed.versionId = parsed.versionId.toLowerCase();
  const response = await rpc(
    auth,
    "select_asset_version",
    {
      p_asset_id: id,
      p_version_id: parsed.versionId,
      p_expected_project_revision: parsed.expectedProjectRevision,
      p_expected_selection_revision: parsed.expectedSelectionRevision,
      p_accept_stale_basis: parsed.acceptStaleBasis,
    },
    assetSelectionResponseSchema,
  );
  checkDetail(auth, id, response);
  const selection = response.asset.currentSelection;
  invariant(
    response.project.current_revision === parsed.expectedProjectRevision &&
      response.asset.selectionRevision === parsed.expectedSelectionRevision + 1 &&
      selection?.versionId === parsed.versionId &&
      selection.receipt.status === "recorded" &&
      selection.receipt.acceptedStaleBasis === parsed.acceptStaleBasis,
  );
  return (await withProjectNames(auth, [response]))[0]!;
}
/** Cursor JSON retains its complete filter/asset binding. Unknown or repeated
 * query fields fail before RPC; owner IDs and private paths are never accepted. */
export function readAssetQuery(request: Request, kind: "library" | "detail" = "library") {
  const params = new URL(request.url).searchParams;
  const allowed =
    kind === "library" ? ["tab", "projectId", "format", "cursor", "limit"] : ["format", "cursor", "limit"];
  for (const key of params.keys())
    if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new ApiError("invalid_input");
  const value: Record<string, unknown> = {};
  for (const key of allowed) {
    const raw = params.get(key);
    if (raw === null) continue;
    if (key === "cursor") {
      if (raw.length > 2_048) throw new ApiError("invalid_input");
      try {
        value.cursor = JSON.parse(raw);
      } catch {
        throw new ApiError("invalid_input");
      }
    } else if (key === "limit") {
      if (!/^[0-9]+$/.test(raw)) throw new ApiError("invalid_input");
      value.limit = Number(raw);
    } else value[key] = raw;
  }
  return kind === "library" ? queryInput(assetLibraryQuerySchema, value) : queryInput(assetDetailQuerySchema, value);
}
