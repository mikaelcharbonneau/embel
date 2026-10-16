"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { getNamingPreferencesReadiness } from "@/domain/naming-brain-preferences";
import type { NamingViewState } from "@/domain/project-naming";
import { createNamingFeedController, NAMING_EXPLORATION_IDLE_MS } from "./naming-feed-controller";
const hidden = () => null;
export type NamingFeedView = NamingViewState & { inspecting?: boolean; historyOpen?: boolean };
export function useNamingFeed({ account, projectId, enabled, view, projectRevision }: { account: VerifiedAccount; projectId: string; enabled: boolean; view: NamingFeedView; projectRevision?: number }) {
  const { namingBrainDrafts: memory, expire } = useAccountSession();
  const read = useCallback(() => memory.get(account, projectId), [memory, account, projectId]);
  const record = useSyncExternalStore(memory.subscribe, read, hidden);
  const eligibleView = view.pane === "results" && view.filter === "all" && !view.query && !view.visibleBatchId && !view.inspecting && !view.historyOpen;
  const controller = useMemo(() => createNamingFeedController({ account, projectId, memory, expire: value => expire({ ...value, status: "ready" }), eligible: () => false }), [account, projectId, memory, expire]);
  useLayoutEffect(() => controller.configure(() => {
    const p = memory.get(account, projectId)?.preferences;
    return enabled && eligibleView && Boolean(p?.saved?.preferences.version === 2 && !p.dirty && !p.pending && getNamingPreferencesReadiness(p.saved.preferences).ready);
  }), [controller, memory, account, projectId, enabled, eligibleView]);
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);
  const near = useRef(false), idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [interacting, setInteracting] = useState(false);
  const deactivate = useCallback(() => { controller.deactivate(); setInteracting(false); if (idleTimer.current) clearTimeout(idleTimer.current); }, [controller]);
  const interaction = useCallback(() => {
    controller.interact(); setInteracting(true);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => { controller.deactivate(); setInteracting(false); }, NAMING_EXPLORATION_IDLE_MS);
    if (near.current) void controller.demand();
  }, [controller]);
  useEffect(() => {
    controller.activate();
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (document.visibilityState === "visible") await controller.load();
      if (!disposed) timer = setTimeout(() => void poll(), memory.get(account, projectId)?.feed.pending ? 1500 : 15_000);
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); if (idleTimer.current) clearTimeout(idleTimer.current); controller.dispose(); };
  }, [controller, memory, account, projectId]);
  useEffect(() => { if (projectRevision !== undefined) void controller.load(); }, [projectRevision, controller]);
  useEffect(() => { if (!enabled || !eligibleView) controller.deactivate(); }, [enabled, eligibleView, controller]);
  useEffect(() => {
    if (!enabled || !eligibleView) return;
    const move = (event: Event) => { const target = event.target; if (target instanceof Element && target.closest("input,textarea,select,[contenteditable=true],.naming-approach-widgets")) return; interaction(); };
    const keyboard = (event: KeyboardEvent) => { if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "End", "Home", " "].includes(event.key)) move(event); };
    const visibility = () => { if (document.visibilityState !== "visible") deactivate(); };
    window.addEventListener("wheel", move, { passive: true }); window.addEventListener("touchmove", move, { passive: true }); window.addEventListener("keydown", keyboard); document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("wheel", move); window.removeEventListener("touchmove", move); window.removeEventListener("keydown", keyboard); document.removeEventListener("visibilitychange", visibility); };
  }, [enabled, eligibleView, interaction, deactivate]);
  useEffect(() => {
    near.current = false;
    if (!sentinel || !eligibleView || typeof IntersectionObserver === "undefined") return;
    const root = sentinel.closest<HTMLElement>(".project-workspace-content");
    const viewport = root?.clientHeight || window.innerHeight;
    const observer = new IntersectionObserver(entries => { near.current = entries.some(entry => entry.isIntersecting); if (near.current) void controller.demand(); }, { root, rootMargin: `${viewport * 2}px 0px` });
    observer.observe(sentinel); return () => { observer.disconnect(); near.current = false; };
  }, [sentinel, controller, eligibleView]);
  const start = useCallback(async () => { const started = await controller.start(); if (started) { setInteracting(true); if (idleTimer.current) clearTimeout(idleTimer.current); idleTimer.current = setTimeout(deactivate, NAMING_EXPLORATION_IDLE_MS); } return started; }, [controller, deactivate]);
  const stop = useCallback(async () => { deactivate(); return controller.stop(); }, [controller, deactivate]);
  const contextReady = enabled && eligibleView && record?.preferences?.saved?.preferences.version === 2 && !record.preferences.dirty && !record.preferences.pending && getNamingPreferencesReadiness(record.preferences.saved.preferences).ready && !record.feed.stop && !record.feed.steering;
  const canExplore = contextReady && record?.feed.feed?.availability.status === "available";
  const run = record?.feed.feed?.activeRun;
  const canResume = contextReady && run?.canResume && (canExplore || Boolean(run.preparedSetId && run.fulfillment?.status === "complete"));
  return { canExplore: Boolean(canExplore), canResume: Boolean(canResume), record, state: record?.feed ?? null, entries: record?.feed.entries ?? [], memory, eligibleView, interacting: interacting && enabled && eligibleView, attachSentinel: setSentinel,
    start, stop, stopCurrent: controller.stopCurrent, retry: controller.retry, resume: controller.resume, steer: controller.steer, refresh: controller.load };
}
