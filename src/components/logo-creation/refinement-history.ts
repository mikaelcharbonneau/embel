import type { LogoRasterRefinement } from "../../domain/logo-jobs";
import type { AccountLogoClient } from "../identity/account-logo-client";
import { AccountRequestError } from "../workspace/account-api";

export type LogoRefinementHistoryItem = { record: LogoRasterRefinement; verified: boolean; error: string | null };
export type LogoRefinementHistoryState = { items: LogoRefinementHistoryItem[]; nextCursor: string | null; loaded: boolean; loading: boolean; error: string | null };
const empty: LogoRefinementHistoryState = Object.freeze({ items: [], nextCursor: null, loaded: false, loading: false, error: null });
const readError = "Saved image refinements could not be read. Any results already loaded are kept.";
const detailError = "Saved details could not be verified. Previously verified results are kept; refresh to check again.";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Observation state can advance, but source lineage and committed output cannot change. */
function compatible(previous: LogoRasterRefinement, next: LogoRasterRefinement) {
  const identity = (record: LogoRasterRefinement) => [record.version, record.id, record.ownerId, record.projectId, record.requestKey, record.jobId, record.source, record.logoType, record.inputRevisions, record.createdAt];
  return same(identity(previous), identity(next))
    && (!previous.preview || same(previous.preview, next.preview))
    && (!previous.providerResponseReceiptId || previous.providerResponseReceiptId === next.providerResponseReceiptId)
    && (previous.billing.status !== "recorded" || !previous.providerResponseReceiptId && ["queued", "running"].includes(previous.state) || same(previous.billing, next.billing))
    && (previous.state !== "succeeded" || next.state === "succeeded");
}

/** Read-only disposable history. Each explicit page loads at most 20 exact details;
 * a failed detail cannot erase another saved result or dispatch replacement work. */
export function createLogoRefinementHistory(input: { client: AccountLogoClient; ownerId: string; projectId: string; isCurrent(): boolean }) {
  let state = empty, disposed = false, active: AbortController | null = null;
  let cursors = new Set<string>();
  const listeners = new Set<() => void>();
  const current = () => !disposed && input.isCurrent();
  const emit = (next: LogoRefinementHistoryState) => { if (current()) { state = next; for (const listener of listeners) listener(); } };
  const owned = (record: { ownerId: string; projectId: string }) => record.ownerId === input.ownerId && record.projectId === input.projectId;
  async function load(append: boolean) {
    if (!current() || active || append && (!state.loaded || !state.nextCursor)) return;
    const controller = new AbortController(); active = controller;
    const valid = () => current() && active === controller && !controller.signal.aborted;
    const cursor = append ? state.nextCursor! : undefined;
    const previous = state.items;
    const visited = append ? new Set(cursors) : new Set<string>();
    if (cursor) visited.add(cursor);
    emit({ ...state, loading: true, error: null });
    try {
      const page = await input.client.listLogoRasterRefinements({ limit: 20, ...(cursor ? { cursor } : {}) }, controller.signal);
      if (!valid()) return;
      if (!page || !owned(page) || page.items.length > 20 || new Set(page.items.map(row => row.id)).size !== page.items.length
        || page.nextCursor !== null && visited.has(page.nextCursor)) throw new AccountRequestError(502);
      for (const record of page.items) {
        const prior = previous.find(row => row.record.id === record.id);
        if (!owned(record) || prior && !compatible(prior.record, record)) throw new AccountRequestError(502);
      }
      const listed = page.items.map(record => previous.find(row => row.record.id === record.id) ?? { record, verified: false, error: null });
      // Refresh prepends recent work without discarding older pages already inspected.
      const items = append ? [...previous, ...listed.filter(row => !previous.some(prior => prior.record.id === row.record.id))]
        : [...listed, ...previous.filter(row => !listed.some(recent => recent.record.id === row.record.id))];
      cursors = visited;
      emit({ items, nextCursor: page.nextCursor, loaded: true, loading: true, error: null });
      for (const listedRecord of page.items) {
        if (!valid()) return;
        try {
          const detail = await input.client.readLogoRasterRefinement(listedRecord.id, controller.signal);
          if (!valid()) return;
          if (!detail || !owned(detail) || !compatible(listedRecord, detail)) throw new AccountRequestError(502);
          emit({ ...state, items: state.items.map(row => row.record.id === detail.id ? { record: detail, verified: true, error: null } : row) });
        } catch {
          if (!valid()) return;
          emit({ ...state, items: state.items.map(row => row.record.id === listedRecord.id ? { ...row, error: detailError } : row) });
        }
      }
      if (valid()) emit({ ...state, loading: false });
    } catch { if (valid()) emit({ ...state, loading: false, error: readError }); }
    finally { if (active === controller) active = null; }
  }
  return {
    getSnapshot: () => current() ? state : empty,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh: () => load(false), loadMore: () => load(true),
    dispose() { disposed = true; active?.abort(); active = null; state = empty; cursors.clear(); listeners.clear(); },
  };
}
export type LogoRefinementHistoryController = ReturnType<typeof createLogoRefinementHistory>;
