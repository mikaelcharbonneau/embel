import "server-only";
import { z } from "zod";
import { accountProjectSummarySchema } from "@/domain/project-api";
import { accountProjectPageSchema, compareProjectCursors, listProjectPageSchema, projectCursor, projectCursorSchema } from "@/domain/project-pages";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";

/** Bounded continuation over existing authenticated project SELECT/RLS rights. */
export async function listProjectPage(auth: AuthenticatedContext, input: unknown) {
  const parsed = listProjectPageSchema.safeParse(input);
  if (!parsed.success) throw new ApiError("invalid_input");
  const { limit, cursor } = parsed.data;
  let query = auth.client.from("projects").select("id,owner_id,scope,title,current_revision,created_at").eq("owner_id", auth.userId);
  if (cursor) query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
  const { data, error } = await query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (error) throw new ApiError("integration_unavailable");
  const rows = z.array(accountProjectSummarySchema).max(limit + 1).safeParse(data);
  if (!rows.success || rows.data.some(row => row.owner_id !== auth.userId || !projectCursorSchema.safeParse(projectCursor(row)).success) ||
      new Set(rows.data.map(row => row.id.toLowerCase())).size !== rows.data.length ||
      rows.data.some((row, index) => (cursor && compareProjectCursors(projectCursor(row), cursor) >= 0) ||
        (index > 0 && compareProjectCursors(projectCursor(rows.data[index - 1]!), projectCursor(row)) <= 0))) throw new ApiError("integration_unavailable");
  const items = rows.data.slice(0, limit);
  return accountProjectPageSchema.parse({ ownerId: auth.userId, items, nextCursor: rows.data.length > limit ? projectCursor(items.at(-1)!) : null });
}
