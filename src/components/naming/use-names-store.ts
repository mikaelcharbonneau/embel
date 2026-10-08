"use client";

import { useSyncExternalStore } from "react";
import { createNamesStore, NAMES_STORAGE_KEY } from "./local-names";

export const namesStore = createNamesStore({ storage: () => typeof window === "undefined" ? null : window.localStorage });
const serverSnapshot = namesStore.getSnapshot();
let listening = false;
const listeners = new Set<() => void>();
function onStorage(event: StorageEvent) {
  if (event.key === NAMES_STORAGE_KEY || event.key === null) namesStore.onStorageChange();
}
function subscribe(listener: () => void) {
  namesStore.hydrate();
  listeners.add(listener);
  const unsubscribe = namesStore.subscribe(listener);
  if (!listening) { window.addEventListener("storage", onStorage); listening = true; }
  // Navigation may have left this singleton unsubscribed while another tab changed storage.
  namesStore.onStorageChange();
  return () => {
    unsubscribe(); listeners.delete(listener);
    if (listeners.size === 0 && listening) { window.removeEventListener("storage", onStorage); listening = false; }
  };
}
export function useNamesStore() {
  return useSyncExternalStore(subscribe, namesStore.getSnapshot, () => serverSnapshot);
}
