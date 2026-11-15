"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { useCreditBalance } from "@/components/logo-creation/credits-in-place";
import { getNamingPreferencesReadiness } from "@/domain/naming-brain-preferences";
import { namingRunActive } from "@/domain/naming-generation";
import { createNamingFeedController, namingStatus, namingStepView } from "./naming-feed-controller";
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
    feed = state?.feed ?? null;
  const contextReady = enabled && savedChoicesReady(record);
  // One decision for Start and Stop, shared with Logo and Creative direction (docs/state-machines.md).
  const step = namingStepView(state);
  // Credits are read where Logo and Creative direction read them: at 0 the start actions are off before the
  // click, with the same note. Display only: the server admits or refuses every start, whatever this says.
  const { balance, periodEnd, refresh: refreshCredits } = useCreditBalance(account);
  const noCredits = balance !== null && balance <= 0;
  // A start, and a run ending, can change the balance: read it again.
  const runMark = feed?.run ? `${feed.run.runId}:${namingRunActive(feed.run)}` : "";
  const answered = `${runMark}:${state?.retry ?? ""}:${state?.failedStatus ?? ""}`;
  const lastAnswered = useRef(answered);
  useEffect(() => {
    if (lastAnswered.current === answered) return;
    lastAnswered.current = answered;
    refreshCredits();
  });
  // After today's limit `stepView` offers no start either, until a read shows a run or the page is reloaded.
  const canExplore = Boolean(contextReady && feed?.availability.status === "available" && step.canStart && !noCredits);
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
    /** The balance is known and is 0: the start actions are off and the note says why. */
    noCredits,
    /** A start pressed now would be refused at once: no credits, or today's limit was reached. */
    startRefused: noCredits || step.message === "daily_limit",
    creditsPeriodEnd: periodEnd,
    canStop: step.canStop,
    start: controller.start,
    more: controller.more,
    steer: controller.steer,
    stop: controller.stop,
    retry: controller.retry,
    refresh: controller.load,
  };
}
export type NamingFeed = ReturnType<typeof useNamingFeed>;
