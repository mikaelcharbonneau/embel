import { ideaPageSchema, type IdeaContent, type IdeaPage } from "@/domain/ideas";
import { compareProjectCursors, type ProjectCursor } from "@/domain/project-pages";
import { AccountRequestError } from "@/components/workspace/account-api";

export type IdeaListing = Omit<IdeaPage, "items"> & { items: IdeaPage["items"] };
export const sameIdeaId = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

export function emptyIdeaContent(): IdeaContent {
  return { title: "", description: "", theme: "", state: "to_explore", details: { problem: "", audience: "", solution: "", differentiation: "", revenueHypotheses: "", validationSteps: "", notes: "" } };
}

/** Continuations are checked against the exact current anchor before private rows are merged. */
export function mergeIdeaPage(previous: IdeaListing | null, input: IdeaPage, cursor: ProjectCursor | null): IdeaListing {
  const page = ideaPageSchema.parse(input);
  if (!cursor) {
    if (previous) throw new AccountRequestError(502);
    return page;
  }
  if (!previous || !sameIdeaId(previous.ownerId, page.ownerId) || previous.nextCursor?.id !== cursor.id || previous.nextCursor.createdAt !== cursor.createdAt ||
      page.items.some(item => compareProjectCursors({ id: item.id, createdAt: item.createdAt }, cursor) >= 0) ||
      page.items.some(item => previous.items.some(loaded => sameIdeaId(loaded.id, item.id)))) throw new AccountRequestError(502);
  return { ...page, items: [...previous.items, ...page.items] };
}

export function ideaErrorMessage(error: unknown, mutation = false) {
  if (error instanceof AccountRequestError) {
    if (error.status === 404) return "This idea is not available to this account.";
    if (error.status === 413) return "This idea is too large to save. Shorten its description or details. Your edits are still here.";
    if (error.status === 422) return "Review the idea title and field lengths. Your edits are still here.";
    if (error.status === 503) return mutation ? "The account change could not be confirmed. Account Ideas are unavailable. Your edits and pending retry remain in this tab." : "Account Ideas are unavailable. Your edits remain in this tab.";
    if (error.status === 502) return mutation ? "The account response could not be verified. Your edits are still here; the write may have completed." : "The account response could not be verified. Your edits remain in this tab.";
  }
  return mutation ? "The account could not be reached. Your edits are still here; the write may have completed." : "The account could not be reached. Your edits remain in this tab.";
}

export const ideaStateLabels = { to_explore: "To explore", developing: "Developing", used: "Used" } as const;
