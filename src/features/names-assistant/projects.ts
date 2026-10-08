import { accountRequest, AccountRequestError } from "@/components/workspace/account-api";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { mergeProjectPage, type ProjectListing } from "@/components/workspace/account-project-page-state";
import { accountProjectSummarySchema, type AccountProjectSummary } from "@/domain/project-api";
import { accountProjectPageSchema } from "@/domain/project-pages";

/** A route bridge, never a generation request or a browser-library import. */
export function namesAssistantProjectHref(project: AccountProjectSummary, account: VerifiedAccount) {
  const parsed = accountProjectSummarySchema.safeParse(project);
  if (!parsed.success || parsed.data.owner_id !== account.userId || parsed.data.scope === "visual_identity_only") return null;
  return `/brands/account/${parsed.data.id}/naming`;
}

export function namesAssistantProjects(listing: ProjectListing | null, account: VerifiedAccount, query: string) {
  if (!listing || listing.ownerId !== account.userId) return [];
  const search = query.trim().toLocaleLowerCase("en");
  return listing.items.filter(project => namesAssistantProjectHref(project, account) && project.title.toLocaleLowerCase("en").includes(search));
}

/** Read only. Identity and abort fences apply to errors as well as successful replies. */
export async function readNamesAssistantProjects({ account, isCurrent, expire, previous, signal }: {
  account: VerifiedAccount;
  isCurrent: (account: VerifiedAccount) => boolean;
  expire: (account: VerifiedAccount) => void;
  previous: ProjectListing | null;
  signal: AbortSignal;
}): Promise<ProjectListing | null> {
  const current = () => !signal.aborted && isCurrent(account);
  if (!current()) return null;
  if (previous && previous.ownerId !== account.userId) throw new AccountRequestError(502);
  if (previous && !previous.nextCursor) return previous;
  const params = new URLSearchParams({ limit: "50" });
  const cursor = previous?.nextCursor ?? null;
  if (cursor) { params.set("cursorCreatedAt", cursor.createdAt); params.set("cursorId", cursor.id); }
  try {
    const page = await accountRequest(`/api/projects/page?${params}`, accountProjectPageSchema, { signal });
    if (!current()) return null;
    if (page.ownerId !== account.userId) { expire(account); return null; }
    return mergeProjectPage(previous, page, cursor);
  } catch (error) {
    if (!current()) return null;
    if (error instanceof AccountRequestError && error.status === 401) { expire(account); return null; }
    throw error;
  }
}
