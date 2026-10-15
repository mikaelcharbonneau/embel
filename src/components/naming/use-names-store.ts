"use client";

import { useSyncExternalStore } from "react";
import { useAccountSession } from "@/components/workspace/account-session";

/** Every reader shares only the verified account provider's Names state. */
export function useNamesStore() {
  const { namesDrafts } = useAccountSession();
  return useSyncExternalStore(namesDrafts.subscribe, namesDrafts.getSnapshot, namesDrafts.getServerSnapshot);
}

export function useNamesActions() {
  const { namesDrafts, session } = useAccountSession();
  return namesDrafts.actions(session.status === "ready" ? session : null);
}
