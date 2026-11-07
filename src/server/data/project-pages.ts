import "server-only";
import { z } from "zod";
import { accountProjectSummarySchema } from "@/domain/project-api";
import { accountProjectPageSchema, compareProjectCursors, listProjectPageSchema, projectCursor, projectCursorSchema } from "@/domain/project-pages";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { enrichProjectDeletionStates } from "./project-deletion";
import { projectDisplayName, readSelectedProjectNames } from "./project-display-names";

/** Bounded continuation over existing authenticated project SELECT/RLS rights. */
export async function listProjectPage(auth: AuthenticatedContext, input: unknown) {
  const parsed = listProjectPageSchema.safeParse(input);
  if (!parsed.success) throw new ApiError("invalid_input");
  const { limit, cursor, state } = parsed.data;
  let query = auth.client.from("projects").select("id,owner_id,scope,title,current_revision,created_at,deleted_at,lifecycle_version,deletion_requested_at").eq("owner_id", auth.userId);
  const beforeCursor = cursor ? `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})` : null;
  if (state === "deleted") {
    const marked = "deleted_at.not.is.null,deletion_requested_at.not.is.null";
    query = query.or(beforeCursor ? `and(or(${marked}),or(${beforeCursor}))` : marked);
  } else {
    query = query.is("deleted_at", null).is("deletion_requested_at", null);
    if (beforeCursor) query = query.or(beforeCursor);
  }
  const { data, error } = await query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (error) throw new ApiError("integration_unavailable");
  const rows = z.array(accountProjectSummarySchema).max(limit + 1).safeParse(data);
  if (!rows.success || rows.data.some(row => row.owner_id !== auth.userId || row.deleted_at === undefined || row.deletion_requested_at === undefined ||
      (state === "deleted" ? row.deleted_at === null && row.deletion_requested_at === null : row.deleted_at !== null || row.deletion_requested_at !== null) || row.lifecycle_version === undefined || !projectCursorSchema.safeParse(projectCursor(row)).success) ||
      new Set(rows.data.map(row => row.id.toLowerCase())).size !== rows.data.length ||
      rows.data.some((row, index) => (cursor && compareProjectCursors(projectCursor(row), cursor) >= 0) ||
        (index > 0 && compareProjectCursors(projectCursor(rows.data[index - 1]!), projectCursor(row)) <= 0))) throw new ApiError("integration_unavailable");
  const page = rows.data.slice(0, limit);
  // Lists show the chosen brand name, as the project bar does; the cursor keeps
  // using the stored row, so paging is unaffected by display names.
  const names = await readSelectedProjectNames(auth, page);
  const selected = page.map(row => ({ ...row, title: projectDisplayName(row.title, names.get(row.id.toLowerCase()), 160) }));
  // Enrichment verifies the same lifecycle epoch; a concurrent Restore cannot
  // attach new state to an old page or cross the collection's active/deleted filter.
  const items = state === "deleted" ? await enrichProjectDeletionStates(auth, selected) : selected.map(row => ({ ...row, deletion_state: "active" as const }));
  if (state === "deleted" && items.some(row => row.deletion_state === "active")) throw new ApiError("integration_unavailable");
  return accountProjectPageSchema.parse({ ownerId: auth.userId, items, nextCursor: rows.data.length > limit ? projectCursor(items.at(-1)!) : null });
}
