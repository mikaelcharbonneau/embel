"use client";
import { useSyncExternalStore } from "react";

/** Tells the Logo step, on the same page, that a project's Inspiration likes
 * (brands, parts or your own images) changed. Holds only saved revision
 * numbers, never choices; memory only, per tab. */
const revisions = new Map<string, string>(), listeners = new Set<() => void>();
const keyOf = (ownerId: string, projectId: string) => `${ownerId}:${projectId}`;
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

export function publishInspirationLikes(ownerId: string, projectId: string, revision: string) {
  const key = keyOf(ownerId, projectId);
  if (revisions.get(key) === revision) return;
  revisions.set(key, revision);
  for (const listener of [...listeners]) listener();
}
/** The latest saved likes revision for the project, or null before Inspiration loads. */
export function useInspirationLikes(ownerId: string, projectId: string | null) {
  return useSyncExternalStore(subscribe, () => projectId ? revisions.get(keyOf(ownerId, projectId)) ?? null : null, () => null);
}
