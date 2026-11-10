import type { LogoConceptBatchPage } from "../../domain/logo-jobs";
import type { AccountLogoClient } from "../identity/account-logo-client";
import { AccountRequestError } from "../workspace/account-api";

export type LogoBatchHistoryState = {
  items: LogoConceptBatchPage["items"];
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
};
const empty: LogoBatchHistoryState = Object.freeze({
  items: [],
  nextCursor: null,
  loaded: false,
  loading: false,
  error: null,
});
const message = "Saved explorations could not be read. Any previews already loaded are kept.";
export function createLogoBatchHistory(input: {
  client: AccountLogoClient;
  ownerId: string;
  projectId: string;
  isCurrent(): boolean;
}) {
  let state = empty,
    disposed = false,
    active: AbortController | null = null;
  const listeners = new Set<() => void>();
  const current = () => !disposed && input.isCurrent();
  const emit = (next: LogoBatchHistoryState) => {
    if (!current()) return;
    state = next;
    for (const listener of listeners) listener();
  };
  async function load(append: boolean) {
    if (!current() || active || (append && (!state.loaded || !state.nextCursor))) return;
    const controller = new AbortController();
    active = controller;
    const valid = () => current() && active === controller && !controller.signal.aborted;
    const cursor = append ? state.nextCursor! : undefined;
    emit({ ...state, loading: true, error: null });
    try {
      const page = await input.client.listLogoConceptBatches(
        { limit: 20, ...(cursor ? { cursor } : {}) },
        controller.signal,
      );
      if (!valid()) return;
      if (
        !page ||
        page.ownerId !== input.ownerId ||
        page.projectId !== input.projectId ||
        (page.nextCursor !== null && page.nextCursor === cursor)
      )
        throw new AccountRequestError(502);
      const items = append ? [...state.items] : [];
      for (const item of page.items) {
        const existing = items.find((row) => row.id === item.id);
        if (existing && (existing.requestKey !== item.requestKey || existing.createdAt !== item.createdAt))
          throw new AccountRequestError(502);
        if (!existing) items.push(item);
      }
      emit({ items, nextCursor: page.nextCursor, loaded: true, loading: false, error: null });
    } catch {
      if (valid()) emit({ ...state, loading: false, error: message });
    } finally {
      if (active === controller) active = null;
    }
  }
  return {
    getSnapshot: () => (current() ? state : empty),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: () => load(false),
    loadMore: () => load(true),
    dispose() {
      disposed = true;
      active?.abort();
      active = null;
      state = empty;
      listeners.clear();
    },
  };
}
export type LogoBatchHistoryController = ReturnType<typeof createLogoBatchHistory>;
