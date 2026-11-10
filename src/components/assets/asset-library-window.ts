import type { AssetLibraryCursor, AssetLibraryPage, AssetLibraryQuery } from "@/domain/asset-library";
import { AccountRequestError } from "@/components/workspace/account-api";
import type { AccountAssetsClient } from "./account-assets-client";

type Position = Pick<AssetLibraryCursor, "createdAt" | "assetId">;

function comparePosition(left: Position, right: Position): number {
  const milliseconds = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (milliseconds) return milliseconds;
  // Postgres preserves microseconds. Date alone would lose the cursor's order
  // for assets created within the same millisecond, including offset timestamps.
  const fraction = (value: string) => value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1]?.slice(3) ?? "";
  const a = fraction(left.createdAt),
    b = fraction(right.createdAt),
    width = Math.max(a.length, b.length);
  const precise = a.padEnd(width, "0").localeCompare(b.padEnd(width, "0"));
  if (precise) return precise;
  return left.assetId.toLowerCase().localeCompare(right.assetId.toLowerCase());
}

function sameQuery(left: AssetLibraryQuery, right: AssetLibraryQuery): boolean {
  return (
    left.tab === right.tab &&
    left.projectId === right.projectId &&
    left.format === right.format &&
    left.limit === right.limit
  );
}

/** Only combine independently verified replies from the same private query. */
export function appendAssetLibraryPage(previous: AssetLibraryPage | null, reply: AssetLibraryPage): AssetLibraryPage {
  if (previous && (previous.ownerId !== reply.ownerId || !sameQuery(previous.query, reply.query)))
    throw new AccountRequestError(502);
  const cursor = reply.query.cursor;
  if (cursor && reply.nextCursor && comparePosition(reply.nextCursor, cursor) >= 0) throw new AccountRequestError(502);
  // Keep stable card positions while accepting the most recent observed metadata.
  const items = new Map(previous?.items.map((item) => [item.asset.id, item]));
  for (const item of reply.items) items.set(item.asset.id, item);
  return { ...reply, items: [...items.values()] };
}

export class AssetLibraryWindowChangedError extends Error {}

/**
 * Re-read from the head through the previously loaded oldest position, rather
 * than trusting stale page cursors or treating a first page as the whole view.
 * Publish only the complete window: failed/aborted reads leave existing cards.
 */
export async function readAssetLibraryWindow(
  client: Pick<AccountAssetsClient, "current" | "list">,
  query: AssetLibraryQuery,
  previous: AssetLibraryPage | null,
  signal: AbortSignal,
): Promise<AssetLibraryPage | null> {
  if (previous && !sameQuery(previous.query, query)) throw new AccountRequestError(502);
  const oldest = previous?.items.at(-1)?.asset;
  const boundary = oldest ? { createdAt: oldest.createdAt, assetId: oldest.id } : null;
  // Permit head insertions without allowing continuous churn or broken cursors
  // to turn a refresh into an unbounded traversal of the account library.
  const maxPages = Math.ceil((previous?.items.length ?? 0) / query.limit) + 10;
  let result: AssetLibraryPage | null = null,
    cursor: AssetLibraryCursor | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    if (signal.aborted || !client.current()) return null;
    const reply = await client.list({ ...query, cursor }, signal);
    if (!reply || signal.aborted || !client.current()) return null;
    if (previous && previous.ownerId !== reply.ownerId) throw new AccountRequestError(502);
    result = appendAssetLibraryPage(result, reply);
    if (!reply.nextCursor || !boundary || comparePosition(reply.nextCursor, boundary) <= 0) return result;
    cursor = reply.nextCursor;
  }
  throw new AssetLibraryWindowChangedError();
}
