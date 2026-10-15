import { z } from "zod";
import { accountProjectSummarySchema } from "./project-api";

export const PROJECT_PAGE_MAX_SIZE = 100;
export const PROJECT_PAGE_DEFAULT_SIZE = 50;
const exactTimestamp = z.iso.datetime({ offset: true }).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/);
export const projectCursorSchema = z.strictObject({ createdAt: exactTimestamp, id: z.uuid() });
export type ProjectCursor = z.infer<typeof projectCursorSchema>;
export const listProjectPageSchema = z.strictObject({ state: z.enum(["active", "deleted"]).default("active"), cursor: projectCursorSchema.optional(), limit: z.number().int().min(1).max(PROJECT_PAGE_MAX_SIZE).default(PROJECT_PAGE_DEFAULT_SIZE) });
const projectSummary = accountProjectSummarySchema.extend({ created_at: exactTimestamp, deleted_at: exactTimestamp.nullable(), lifecycle_version: z.number().int().nonnegative() });

/** PostgreSQL timestamps retain six fractional digits; Date alone loses the last three. */
function microseconds(timestamp: string) {
  const fraction = /\.(\d{1,6})/.exec(timestamp)?.[1] ?? "";
  return BigInt(Date.parse(timestamp)) * 1000n + BigInt(fraction.padEnd(6, "0").slice(3));
}
export function compareProjectCursors(a: ProjectCursor, b: ProjectCursor) {
  const timeA = microseconds(a.createdAt), timeB = microseconds(b.createdAt);
  if (timeA !== timeB) return timeA > timeB ? 1 : -1;
  const idA = a.id.toLowerCase(), idB = b.id.toLowerCase();
  return idA === idB ? 0 : idA > idB ? 1 : -1;
}
export function projectCursor(project: { id: string; created_at: string }): ProjectCursor { return { id: project.id, createdAt: project.created_at }; }
export const accountProjectPageSchema = z.strictObject({ ownerId: z.uuid(), items: z.array(projectSummary).max(PROJECT_PAGE_MAX_SIZE), nextCursor: projectCursorSchema.nullable() }).superRefine((page, ctx) => {
  const last = page.items.at(-1);
  if (page.items.some(item => item.owner_id !== page.ownerId) || new Set(page.items.map(item => item.id.toLowerCase())).size !== page.items.length ||
      page.items.some((item, index) => index > 0 && compareProjectCursors(projectCursor(page.items[index - 1]!), projectCursor(item)) <= 0) ||
      (page.nextCursor && (!last || page.nextCursor.id !== last.id || page.nextCursor.createdAt !== last.created_at))) {
    ctx.addIssue({ code: "custom", message: "Project page must be owned, unique, ordered and anchored to its final row" });
  }
});
export type AccountProjectPage = z.infer<typeof accountProjectPageSchema>;
