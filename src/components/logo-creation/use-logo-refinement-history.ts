"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "../identity/account-logo-client";
import { useAccountSession, type VerifiedAccount } from "../workspace/account-session";
import {
  createLogoRefinementHistory,
  type LogoRefinementHistoryController,
  type LogoRefinementHistoryState,
} from "./refinement-history";
const empty: LogoRefinementHistoryState = Object.freeze({
  items: [],
  nextCursor: null,
  loaded: false,
  loading: false,
  error: null,
});
const getEmpty = () => empty,
  noSubscription = () => () => undefined;
/** Read cache only; shared draft memory retains edits and original request identities. */
export function useLogoRefinementHistory(
  client: AccountLogoClient | null,
  account: VerifiedAccount,
  projectId?: string,
) {
  const { isCurrent } = useAccountSession();
  const [entry, setEntry] = useState<{
    client: AccountLogoClient;
    ownerId: string;
    projectId: string;
    generation: number;
    controller: LogoRefinementHistoryController;
  } | null>(null);
  useEffect(() => {
    if (!client || !projectId || !isCurrent(account) || !isAccountLogoClientCurrent(client, account, projectId)) return;
    let closed = false;
    const current = () => !closed && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId);
    const controller = createLogoRefinementHistory({ client, ownerId: account.userId, projectId, isCurrent: current });
    queueMicrotask(() => {
      if (current()) {
        setEntry({ client, ownerId: account.userId, projectId, generation: account.generation, controller });
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
    entry.ownerId === account.userId &&
    entry.projectId === projectId &&
    entry.generation === account.generation &&
    isCurrent(account) &&
    client &&
    isAccountLogoClientCurrent(client, account, projectId ?? null)
      ? entry.controller
      : null;
  const state = useSyncExternalStore(
    controller?.subscribe ?? noSubscription,
    controller?.getSnapshot ?? getEmpty,
    getEmpty,
  );
  return { controller, state };
}
