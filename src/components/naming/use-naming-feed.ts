"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { getNamingPreferencesReadiness } from "@/domain/naming-brain-preferences";
import type { NamingViewState } from "@/domain/project-naming";
import { createNamingFeedController, NAMING_EXPLORATION_IDLE_MS } from "./naming-feed-controller";
import { visibleNamingFeedCursor } from "./naming-feed-viewport";
const hidden = () => null;
const emptySteeringDraft = { candidateIds: [] as string[], instruction: "" };
function nearResultsTail(sentinel: HTMLElement | null) {
  const root = sentinel?.closest<HTMLElement>("[data-naming-results-scroll]") ?? sentinel?.closest<HTMLElement>(".project-workspace-content");
  if (!sentinel?.isConnected || !root?.isConnected || root.closest("[hidden]") || getComputedStyle(root).visibility !== "visible" || getComputedStyle(sentinel).visibility !== "visible") return false;
  const viewport = root.clientHeight, bounds = root.getBoundingClientRect(), tail = sentinel.getBoundingClientRect();
  return viewport > 0 && bounds.width > 0 && bounds.height > 0 && tail.width > 0 && tail.height > 0 &&
    bounds.bottom > 0 && bounds.top < window.innerHeight && bounds.right > 0 && bounds.left < window.innerWidth &&
    tail.top <= bounds.bottom + viewport * 2 && tail.bottom >= bounds.top - viewport * 2 && tail.right > bounds.left && tail.left < bounds.right;
}
export type NamingFeedView = NamingViewState & { inspecting?: boolean; historyOpen?: boolean; explorationHidden?: boolean };
export function useNamingFeed({ account, projectId, enabled, view, projectRevision }: { account: VerifiedAccount; projectId: string; enabled: boolean; view: NamingFeedView; projectRevision?: number }) {
  const { namingBrainDrafts: memory, expire } = useAccountSession();
  const read = useCallback(() => memory.get(account, projectId), [memory, account, projectId]);
  const record = useSyncExternalStore(memory.subscribe, read, hidden);
  const showingFeed = view.pane === "results" && view.filter === "all" && !view.query && !view.visibleBatchId && !view.historyOpen;
  const eligibleView = showingFeed && !view.inspecting;
  const resultsVisible = !view.explorationHidden;
  const controller = useMemo(() => createNamingFeedController({ account, projectId, memory, expire: value => expire({ ...value, status: "ready" }), eligible: () => false }), [account, projectId, memory, expire]);
  useLayoutEffect(() => controller.configure(() => {
    const p = memory.get(account, projectId)?.preferences;
    return enabled && eligibleView && Boolean(p?.saved?.preferences.version === 2 && !p.dirty && !p.pending && getNamingPreferencesReadiness(p.saved.preferences).ready);
  }), [controller, memory, account, projectId, enabled, eligibleView]);
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interactionFrame = useRef<number | null>(null);
  const loadedController = useRef<typeof controller | null>(null);
  const progressiveActive = Boolean(record?.feed.feed?.progressive && (record.feed.pending || ["queued", "running", "cancel_requested"].includes(record.feed.feed.activeRun?.state ?? "")));
  // Observer entries describe an earlier layout. Admission needs the current tail.
  const demandNearTail = useCallback(() => { if (nearResultsTail(sentinel)) void controller.demand(); }, [controller, sentinel]);
  const [interacting, setInteracting] = useState(false);
  const deactivate = useCallback(() => { controller.deactivate(); setInteracting(false); if (idleTimer.current) clearTimeout(idleTimer.current); if (interactionFrame.current !== null) cancelAnimationFrame(interactionFrame.current); interactionFrame.current = null; }, [controller]);
  const interaction = useCallback((trustedResume: boolean) => {
    controller.interact(trustedResume); setInteracting(true);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => { controller.deactivate(); setInteracting(false); }, NAMING_EXPLORATION_IDLE_MS);
    demandNearTail();
    if (trustedResume) {
      if (interactionFrame.current !== null) cancelAnimationFrame(interactionFrame.current);
      interactionFrame.current = requestAnimationFrame(() => {
        interactionFrame.current = null;
        const feed = memory.get(account, projectId)?.feed;
        if (feed?.feed?.canPrefetchOnScroll || feed?.feed?.progressive) {
          const cursor = visibleNamingFeedCursor(sentinel, feed.entries);
          if (cursor) void controller.demand(cursor);
        }
      });
    }
  }, [controller, demandNearTail, memory, account, projectId, sentinel]);
  useEffect(() => {
    controller.activate();
    loadedController.current = null;
    return () => { if (idleTimer.current) clearTimeout(idleTimer.current); if (interactionFrame.current !== null) cancelAnimationFrame(interactionFrame.current); interactionFrame.current = null; loadedController.current = null; controller.dispose(); };
  }, [controller]);
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const interval = () => {
      const state = memory.get(account, projectId)?.feed;
      return state?.feed?.progressive && (state.pending || ["queued", "running", "cancel_requested"].includes(state.feed.activeRun?.state ?? "")) ? 1000 : state?.pending ? 1500 : 15_000;
    };
    async function poll() {
      if (document.visibilityState === "visible") {
        const initial = loadedController.current !== controller;
        if (initial) loadedController.current = controller;
        const received = await (initial ? controller.load() : controller.poll());
        if (initial && !received && !disposed) loadedController.current = null;
      }
      if (!disposed) timer = setTimeout(() => void poll(), interval());
    }
    if (loadedController.current === controller) timer = setTimeout(() => void poll(), interval()); else void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [controller, memory, account, projectId, progressiveActive]);
  useEffect(() => { if (projectRevision !== undefined) void controller.load(); }, [projectRevision, controller]);
  useEffect(() => { if (!enabled || !eligibleView || !resultsVisible) controller.deactivate(); }, [enabled, eligibleView, resultsVisible, controller]);
  useEffect(() => {
    if (!enabled || !eligibleView || !resultsVisible) return;
    const move = (event: Event) => { const target = event.target; if (target instanceof Element && target.closest("input,textarea,select,[contenteditable=true],.naming-approach-widgets")) return; const root = sentinel?.closest<HTMLElement>("[data-naming-results-scroll]"); if (root && (!(target instanceof Node) || !root.contains(target))) return; interaction(event.isTrusted); };
    const keyboard = (event: KeyboardEvent) => {
      // Activation/navigation inside a control is not a request to scroll names.
      // Wheel/touch still use move(): compact cards themselves are buttons.
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.target instanceof Element && event.target.closest("button,a[href],input,textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[contenteditable=true]")) return;
      if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "End", "Home", " "].includes(event.key)) move(event);
    };
    const visibility = () => { if (document.visibilityState !== "visible") deactivate(); };
    window.addEventListener("wheel", move, { passive: true }); window.addEventListener("touchmove", move, { passive: true }); window.addEventListener("keydown", keyboard); document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("wheel", move); window.removeEventListener("touchmove", move); window.removeEventListener("keydown", keyboard); document.removeEventListener("visibilitychange", visibility); };
  }, [enabled, eligibleView, resultsVisible, interaction, deactivate, sentinel]);
  useEffect(() => {
    if (!sentinel || !eligibleView || !resultsVisible || typeof IntersectionObserver === "undefined") return;
    const root = sentinel.closest<HTMLElement>("[data-naming-results-scroll]") ?? sentinel.closest<HTMLElement>(".project-workspace-content");
    let observer: IntersectionObserver | null = null;
    let disposed = false;
    const observe = () => {
      if (disposed) return;
      observer?.disconnect();
      const viewport = root?.clientHeight || window.innerHeight;
      const current = new IntersectionObserver(entries => {
        if (disposed || observer !== current) return;
        if (entries.some(entry => entry.target === sentinel && entry.isIntersecting)) demandNearTail();
      }, { root, rootMargin: `${viewport * 2}px 0px` });
      observer = current;
      observer.observe(sentinel);
    };
    observe();
    // The same canvas changes from hidden to a real panel after explicit start.
    // Recompute prefetch distance when its actual viewport changes.
    const resize = root && typeof ResizeObserver !== "undefined" ? new ResizeObserver(observe) : null;
    if (root) resize?.observe(root);
    return () => { disposed = true; observer?.disconnect(); resize?.disconnect(); };
  }, [sentinel, demandNearTail, eligibleView, resultsVisible]);
  const start = useCallback(async () => { const started = await controller.start(); if (started) { setInteracting(true); if (idleTimer.current) clearTimeout(idleTimer.current); idleTimer.current = setTimeout(deactivate, NAMING_EXPLORATION_IDLE_MS); } return started; }, [controller, deactivate]);
  const stop = useCallback(async () => { deactivate(); return controller.stop(); }, [controller, deactivate]);
  const contextReady = enabled && eligibleView && record?.preferences?.saved?.preferences.version === 2 && !record.preferences.dirty && !record.preferences.pending && getNamingPreferencesReadiness(record.preferences.saved.preferences).ready && !record.feed.stop && !record.feed.steering;
  const canExplore = contextReady && record?.feed.feed?.availability.status === "available";
  const run = record?.feed.feed?.activeRun;
  const canResume = contextReady && !record?.feed.pending && run?.canResume && (canExplore || run.canResumeSaved === true);
  const updateSteeringDraft = useCallback((patch: Partial<typeof emptySteeringDraft>) => memory.setSteeringDraft(account, projectId, draft => ({ ...draft, ...patch })), [memory, account, projectId]);
  return { steeringDraft: record?.steeringDraft ?? emptySteeringDraft, updateSteeringDraft, canExplore: Boolean(canExplore), canResume: Boolean(canResume), record, state: record?.feed ?? null, entries: record?.feed.entries ?? [], memory, showingFeed, eligibleView, interacting: interacting && enabled && eligibleView && resultsVisible, attachSentinel: setSentinel,
    start, stop, locateSavedSet: controller.locateSavedSet, stopCurrent: controller.stopCurrent, retry: controller.retry, resume: controller.resume, steer: controller.steer, refresh: controller.load };
}
