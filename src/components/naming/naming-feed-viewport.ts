import type { NamingFeedCursor, NamingFeedEntry } from "@/domain/naming-brain";

/** Observe saved cards in the current viewport, never the last loaded page. */
export function visibleNamingFeedCursor(sentinel: HTMLElement | null, entries: readonly NamingFeedEntry[]): NamingFeedCursor | null {
  const root = sentinel?.closest<HTMLElement>("[data-naming-results-scroll]");
  if (!sentinel?.isConnected || !root?.isConnected || root.closest("[hidden]") || getComputedStyle(root).visibility !== "visible" || getComputedStyle(sentinel).visibility !== "visible") return null;
  const bounds = root.getBoundingClientRect();
  if (root.clientHeight <= 0 || bounds.width <= 0 || bounds.height <= 0 || bounds.bottom <= 0 || bounds.top >= window.innerHeight || bounds.right <= 0 || bounds.left >= window.innerWidth) return null;
  const panel = root.closest("[data-naming-layout]")?.querySelector<HTMLElement>("[data-floating-composer]");
  const cover = panel && getComputedStyle(panel).visibility === "visible" ? panel.getBoundingClientRect() : null;
  const rows = new Map(entries.map(row => [`project-name-${row.entry.candidate.id}`, row]));
  let visible: NamingFeedEntry | undefined;
  for (const card of root.querySelectorAll<HTMLElement>(".naming-feed-card article[id]")) {
    const row = rows.get(card.id), rect = card.getBoundingClientRect();
    if (!row || (visible && row.position <= visible.position) || getComputedStyle(card).visibility !== "visible") continue;
    const top = Math.max(0, rect.top, bounds.top), bottom = Math.min(window.innerHeight, rect.bottom, bounds.bottom);
    const left = Math.max(0, rect.left, bounds.left), right = Math.min(window.innerWidth, rect.right, bounds.right);
    if (right <= left || bottom <= top) continue;
    // The scrollport extends behind the composer. A fully covered name has not been seen.
    if (cover && cover.top <= top && cover.bottom >= bottom && cover.left <= left && cover.right >= right) continue;
    visible = row;
  }
  return visible ? { entryId: visible.entryId, position: visible.position } : null;
}
