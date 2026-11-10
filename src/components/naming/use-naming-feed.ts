"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { getNamingPreferencesReadiness } from "@/domain/naming-brain-preferences";
import { namingRunActive } from "@/domain/naming-generation";
import { createNamingFeedController, namingStatus } from "./naming-feed-controller";
import type { NamingBrainRecord } from "./naming-brain-memory";
const hidden = () => null;
const emptySteeringDraft = { candidateIds: [] as string[], instruction: "" };

/** Saved, complete choices are the only basis a start request can name. */
function savedChoicesReady(record: NamingBrainRecord | null | undefined) {
  const p = record?.preferences;
  return Boolean(
    p?.saved?.preferences.version === 2 &&
    !p.dirty &&
    !p.pending &&
    getNamingPreferencesReadiness(p.saved.preferences).ready,
  );
}

export function useNamingFeed({
  account,
  projectId,
  enabled,
  projectRevision,
}: {
  account: VerifiedAccount;
  projectId: string;
  enabled: boolean;
  projectRevision?: number;
}) {
  const { namingBrainDrafts: memory, expire } = useAccountSession();
  const read = useCallback(() => memory.get(account, projectId), [memory, account, projectId]);
  const record = useSyncExternalStore(memory.subscribe, read, hidden);
  const controller = useMemo(
    () =>
      createNamingFeedController({
        account,
        projectId,
        memory,
        expire: (value) => expire({ ...value, status: "ready" }),
      }),
    [account, projectId, memory, expire],
  );
  const revision = useRef(projectRevision);
  useLayoutEffect(() => {
    revision.current = projectRevision;
    controller.configure(() => {
      const saved = memory.get(account, projectId);
      const version = saved?.preferences?.saved?.version;
      return enabled && revision.current !== undefined && version !== undefined && savedChoicesReady(saved)
        ? { projectRevision: revision.current, preferencesVersion: version }
        : null;
    });
  }, [controller, memory, account, projectId, enabled, projectRevision]);
  useEffect(() => {
    controller.activate();
    const stopPolling = controller.startPolling();
    const visibility = () => {
      if (document.visibilityState === "visible") controller.wake();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      stopPolling();
      controller.dispose();
    };
  }, [controller]);
  // Selecting a name or saving Strategy changes the project; read the names again.
  const loadedRevision = useRef(projectRevision);
  useEffect(() => {
    const previous = loadedRevision.current;
    loadedRevision.current = projectRevision;
    if (previous !== undefined && projectRevision !== undefined && previous !== projectRevision) void controller.load();
  }, [projectRevision, controller]);

  const state = record?.feed ?? null,
    feed = state?.feed ?? null,
    run = feed?.run ?? null;
  const contextReady = enabled && savedChoicesReady(record);
  const canExplore = Boolean(
    contextReady &&
    feed?.availability.status === "available" &&
    !state?.pending &&
    !state?.stopping &&
    !namingRunActive(run),
  );
  const entries = useMemo(() => state?.entries ?? [], [state?.entries]);
  const updateSteeringDraft = useCallback(
    (patch: Partial<typeof emptySteeringDraft>) =>
      memory.setSteeringDraft(account, projectId, (draft) => ({ ...draft, ...patch })),
    [memory, account, projectId],
  );
  return {
    record,
    state,
    entries,
    memory,
    status: namingStatus(state),
    steeringDraft: record?.steeringDraft ?? emptySteeringDraft,
    updateSteeringDraft,
    canExplore,
    canMore: canExplore,
    canStop: Boolean(run && ["queued", "running"].includes(run.state) && !state?.stopping),
    start: controller.start,
    more: controller.more,
    steer: controller.steer,
    stop: controller.stop,
    retry: controller.retry,
    refresh: controller.load,
  };
}
export type NamingFeed = ReturnType<typeof useNamingFeed>;
