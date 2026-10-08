"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { LogoOperation } from "@/domain/logo-jobs";
import { useAccountSession } from "@/components/workspace/account-session";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "./account-logo-client";
import { createLogoCapabilitiesController, emptyLogoCapabilities, type LogoCapabilitiesController } from "./logo-capabilities-controller";

const noSubscription = () => () => undefined;
/** Readiness is never attached to an immutable workspace or written to draft memory. */
export function useLogoCapabilities(client: AccountLogoClient | null, projectId: string | null) {
  const { session, isCurrent } = useAccountSession(), account = session.status === "ready" ? session : null;
  const [entry, setEntry] = useState<{ ownerId: string; generation: number; projectId: string; client: AccountLogoClient; controller: LogoCapabilitiesController } | null>(null);
  useEffect(() => {
    if (!account || !projectId || !client || !isCurrent(account) || !isAccountLogoClientCurrent(client, account, projectId)) return;
    let disposed = false;
    const current = () => !disposed && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId);
    const controller = createLogoCapabilitiesController({ client, ownerId: account.userId, projectId, isCurrent: current });
    queueMicrotask(() => { if (current()) { setEntry({ ownerId: account.userId, generation: account.generation, projectId, client, controller }); void controller.refresh(); } });
    return () => { disposed = true; controller.dispose(); };
  }, [account, client, isCurrent, projectId]);
  const controller = account && projectId && client && entry?.ownerId === account.userId && entry.generation === account.generation
    && entry.projectId === projectId && entry.client === client && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId) ? entry.controller : null;
  const state = useSyncExternalStore(controller?.subscribe ?? noSubscription, controller?.getSnapshot ?? emptyLogoCapabilities, emptyLogoCapabilities);
  const isAvailable = useCallback((operation: LogoOperation) => controller?.isAvailable(operation) ?? false, [controller]);
  const refresh = useCallback(() => controller?.refresh() ?? Promise.resolve(), [controller]);
  return { ...state, isAvailable, refresh };
}
export type LogoCapabilitiesReadiness = ReturnType<typeof useLogoCapabilities>;
