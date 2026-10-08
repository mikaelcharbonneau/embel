import type { AccountProjectSummary } from "@/domain/project-api";
import { accountProjectPageSchema, compareProjectCursors, projectCursor, type AccountProjectPage, type ProjectCursor } from "@/domain/project-pages";

export type ProjectListing = { ownerId: string; items: AccountProjectSummary[]; nextCursor: ProjectCursor | null };

/** Validate each bounded reply before merging; accumulated rows are not a response page. */
export function mergeProjectPage(previous: ProjectListing | null, incoming: AccountProjectPage, requestedCursor: ProjectCursor | null): ProjectListing {
  const page = accountProjectPageSchema.parse(incoming);
  if (!requestedCursor) {
    if (previous) throw new Error("Unexpected initial project page");
    return page;
  }
  if (!previous?.nextCursor || previous.ownerId !== page.ownerId || compareProjectCursors(previous.nextCursor, requestedCursor) !== 0 ||
      page.items.some(row => compareProjectCursors(projectCursor(row), requestedCursor) >= 0) ||
      (page.nextCursor && compareProjectCursors(page.nextCursor, requestedCursor) >= 0)) throw new Error("Project continuation could not be verified");
  const items = new Map(previous.items.map(row => [row.id.toLowerCase(), row]));
  for (const row of page.items) {
    if (items.has(row.id.toLowerCase())) throw new Error("Overlapping project continuation");
    items.set(row.id.toLowerCase(), row);
  }
  return { ownerId: page.ownerId, items: [...items.values()], nextCursor: page.nextCursor };
}
