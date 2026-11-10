"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "../identity/account-logo-client";
import { useAccountSession, type VerifiedAccount } from "../workspace/account-session";
import { createLogoBatchHistory, type LogoBatchHistoryController, type LogoBatchHistoryState } from "./batch-history";
const empty: LogoBatchHistoryState = Object.freeze({
  items: [],
  nextCursor: null,
  loaded: false,
  loading: false,
  error: null,
});
const getEmpty = () => empty,
  noSubscription = () => () => undefined;
/** Disposable owned read cache. Drafts and request intents stay in shared memory. */
export function useLogoBatchHistory(client: AccountLogoClient | null, account: VerifiedAccount, projectId?: string) {
  const { isCurrent } = useAccountSession();
  const [entry, setEntry] = useState<{
    client: AccountLogoClient;
    projectId: string;
    generation: number;
    controller: LogoBatchHistoryController;
  } | null>(null);
  useEffect(() => {
    if (!client || !projectId || !isAccountLogoClientCurrent(client, account, projectId)) return;
    let closed = false;
    const current = () => !closed && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId);
    const controller = createLogoBatchHistory({ client, ownerId: account.userId, projectId, isCurrent: current });
    queueMicrotask(() => {
      if (current()) {
        setEntry({ client, projectId, generation: account.generation, controller });
        void controller.refresh();
      }
    });
    return () => {
      closed = true;
      controller.dispose();
    };
  }, [account, client, isCurrent, projectId]);
  const controller =
    entry &&
    entry.client === client &&
    entry.projectId === projectId &&
    entry.generation === account.generation &&
    isCurrent(account)
      ? entry.controller
      : null;
  const state = useSyncExternalStore(
    controller?.subscribe ?? noSubscription,
    controller?.getSnapshot ?? getEmpty,
    getEmpty,
  );
  return { controller, state };
}
