import type { NamingFeedCursor, NamingFeedEntry } from "@/domain/naming-brain";

/** Observe saved cards in the current viewport, never the last loaded page. */
export function visibleNamingFeedCursor(sentinel: HTMLElement | null, entries: readonly NamingFeedEntry[]): NamingFeedCursor | null {
  const root = sentinel?.closest<HTMLElement>("[data-naming-results-scroll]");
  if (!sentinel?.isConnected || !root?.isConnected || root.closest("[hidden]") || getComputedStyle(root).visibility !== "visible" || getComputedStyle(sentinel).visibility !== "visible") return null;
  const bounds = root.getBoundingClientRect();
  if (root.clientHeight <= 0 || bounds.width <= 0 || bounds.height <= 0 || bounds.bottom <= 0 || bounds.top >= window.innerHeight || bounds.right <= 0 || bounds.left >= window.innerWidth) return null;
  const rows = new Map(entries.map(row => [`project-name-${row.entry.candidate.id}`, row]));
  let visible: NamingFeedEntry | undefined;
  for (const card of root.querySelectorAll<HTMLElement>(".naming-feed-card article[id]")) {
    const row = rows.get(card.id), rect = card.getBoundingClientRect();
    if (row && (!visible || row.position > visible.position) && rect.width > 0 && rect.height > 0 && getComputedStyle(card).visibility === "visible"
      && rect.bottom > Math.max(bounds.top, 0) && rect.top < Math.min(bounds.bottom, window.innerHeight)
      && rect.right > Math.max(bounds.left, 0) && rect.left < Math.min(bounds.right, window.innerWidth)) visible = row;
  }
  return visible ? { entryId: visible.entryId, position: visible.position } : null;
}
