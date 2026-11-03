// @vitest-environment jsdom
import { act, createElement, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNamingBrainMemory } from "@/components/naming/naming-brain-memory";
import { useNamingFeed, type NamingFeedView } from "@/components/naming/use-naming-feed";
import { initialNamingView } from "@/components/naming/use-project-naming";
import { nameIdentityKey, namingStrategyBasis, namingStrategyKey } from "@/domain/project-naming";
import { initialNamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import { contextSnapshotSchema } from "@/domain/projects";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { run as syntheticProgressiveRun } from "./naming-progressive-fixture";
const mock = vi.hoisted(() => ({ memory: null as ReturnType<typeof createNamingBrainMemory> | null, expire: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ namingBrainDrafts: mock.memory, expire: mock.expire }) }));
const account: VerifiedAccount = { status: "ready", userId: "a0000000-0000-4000-8000-000000000001", generation: 1 }, projectId = "b0000000-0000-4000-8000-000000000001";
const context = contextSnapshotSchema.parse({ description: "Synthetic feed observer" }), preferences = { ...initialNamingPreferencesV2(context), approaches: ["real_words" as const], directness: "all" as const };
const candidateId = "c0000000-0000-4000-8000-000000000001", createdAt = "2026-10-16T12:00:00Z";
const savedEntry = { entryId: candidateId, position: 1, runId: null, steeringRevision: 0, primaryApproach: null, additionalApproaches: [], publishedClaims: [], entry: { candidate: { id: candidateId, ownerId: account.userId, projectId, value: "Synthetic", identityKey: nameIdentityKey("Synthetic"), rationale: "Synthetic observer fixture.", contextRevision: 1, strategyBasis: namingStrategyBasis(context), strategyKey: namingStrategyKey(context), createdAt, origin: { kind: "local_import", ownerId: account.userId, projectId, candidateId, contextRevision: 1, source: { id: candidateId, value: "Synthetic", createdAt, origin: "manual", history: [] }, capturedContext: context } }, retention: { ownerId: account.userId, projectId, candidateId, revision: 0, favorite: false, saved: false, updatedAt: null } } };
const savedFeed = { version: 1, ownerId: account.userId, projectId, projectRevision: 1, preferencesVersion: 1, feedbackRevision: 0, steeringRevision: 0, demandSequence: 1, entries: [savedEntry], nextCursor: null, consumedThrough: null, activeRun: null, preparedSetId: null, state: "active", availability: { status: "available", handlerVersion: "naming-brain-v1", protocol: "openai_agents", acceptedPolicyIdentity: "a".repeat(64) } };
let root: Root, host: HTMLDivElement, latest: ReturnType<typeof useNamingFeed>, observe: IntersectionObserverCallback, resize: ResizeObserverCallback, options: IntersectionObserverInit | undefined, requests: string[], tailTop: number, tailLeft: number, viewportHeight: number;
function Probe({ view = initialNamingView }: { view?: NamingFeedView }) { const feed = useNamingFeed({ account, projectId, enabled: true, view }); useLayoutEffect(() => { latest = feed; }); return createElement("div", { ref: feed.attachSentinel, "data-test-naming-tail": true }); }
function intersection(callback = observe) { callback([{ target: host.querySelector("[data-test-naming-tail]")!, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver); }
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); requests = []; tailTop = 180; tailLeft = 0; viewportHeight = 200;
  mock.memory = createNamingBrainMemory({ storage: () => null }); mock.memory.bind(account); mock.memory.connectPreferences(account, projectId, { ownerId: account.userId, projectId, version: 1, preferences, createdAt: "2026-10-16T12:00:00Z" }, context);
  vi.stubGlobal("IntersectionObserver", class { constructor(callback: IntersectionObserverCallback, init?: IntersectionObserverInit) { observe = callback; options = init; } observe() {} disconnect() {} });
  vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { resize = callback; } observe() {} disconnect() {} });
  const rectangle = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.hasAttribute("data-test-naming-tail")) return new DOMRect(tailLeft, tailTop, 600, 20);
    if (this.matches("[data-naming-results-scroll],.project-workspace-content")) return new DOMRect(0, 0, 600, viewportHeight);
    return rectangle.call(this);
  });
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) { return this.matches("[data-naming-results-scroll],.project-workspace-content") ? viewportHeight : 0; });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => { if (init.method === "POST") requests.push(path); return Response.json({ feed: savedFeed }); }));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("survives StrictMode remount and observes two viewports ahead without admitting on mount", async () => {
  await act(async () => root.render(createElement(StrictMode, null, createElement(Probe))));
  expect(latest.state?.feed?.projectId).toBe(projectId); expect(options?.rootMargin).toBe(`${window.innerHeight * 2}px 0px`);
  await act(async () => observe([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(requests).toHaveLength(0);
  await act(async () => latest.start());
  await act(async () => observe([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(requests).toHaveLength(0);
});
it("preserves the results scroller while preview is open and ignores both user demand and queued observer callbacks until it closes", async () => {
  const draw = (inspecting: boolean) => root.render(createElement("div", { "data-naming-results-scroll": true }, createElement(Probe, { view: { ...initialNamingView, inspecting } })));
  await act(async () => draw(false));
  const scroller = host.querySelector("[data-naming-results-scroll]")!, tail = host.querySelector("[data-test-naming-tail]"), retired = observe;
  await act(async () => draw(true));
  expect(host.querySelector("[data-naming-results-scroll]")).toBe(scroller);
  expect(host.querySelector("[data-test-naming-tail]")).toBe(tail);
  await act(async () => { scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 300, bubbles: true })); intersection(retired); });
  expect(latest.eligibleView).toBe(false);
  expect(requests).toEqual([]);
  await act(async () => draw(false));
  await act(async () => intersection());
  expect(requests).toEqual([]);
  await act(async () => scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 300, bubbles: true })));
  expect(requests).toHaveLength(1);
});
it("uses the actual workspace scroller as the observer root", async () => {
  await act(async () => root.render(createElement("div", { className: "project-workspace-content" }, createElement(Probe))));
  expect(options?.root).toBe(host.querySelector(".project-workspace-content"));
});
it("uses the results pane root and ignores wheel or navigation inside the conversation", async () => {
  await act(async () => root.render(createElement("div", { className: "project-workspace-content" },
    createElement("aside", { "data-naming-chat-scroll": true, tabIndex: 0 }, "Synthetic conversation"),
    createElement("div", { "data-naming-results-scroll": true, tabIndex: 0 }, createElement(Probe)))));
  const chat = host.querySelector("aside")!, grid = host.querySelector("[data-naming-results-scroll]")!;
  expect(options?.root).toBe(grid);
  await act(async () => observe([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  await act(async () => chat.dispatchEvent(new WheelEvent("wheel", { deltaY: 300, bubbles: true })));
  await act(async () => chat.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(requests).toHaveLength(0);
  await act(async () => grid.dispatchEvent(new WheelEvent("wheel", { deltaY: 300, bubbles: true })));
  expect(requests).toHaveLength(1);
});
it("disables demand while mobile chat covers the results pane", async () => {
  await act(async () => root.render(createElement(Probe, { view: { ...initialNamingView, explorationHidden: true } })));
  expect(latest.interacting).toBe(false);
  await act(async () => window.dispatchEvent(new WheelEvent("wheel", { deltaY: 300 })));
  expect(requests).toHaveLength(0);
});
it.each(["Inspect name Synthetic", "Favorite Synthetic", "Saved names & history", "Pause exploration", "Stop exploration"])("does not treat Space activation of %s as exploration", async label => {
  await act(async () => root.render(createElement("div", { "data-naming-results-scroll": true }, createElement("button", { type: "button" }, label), createElement(Probe))));
  await act(async () => observe([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  const control = host.querySelector('button')!; control.focus();
  await act(async () => control.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
  expect(requests).toHaveLength(0);
});
it("retains genuine wheel exploration over compact card buttons", async () => {
  await act(async () => root.render(createElement("div", { "data-naming-results-scroll": true }, createElement("button", { type: "button" }, "Inspect name Synthetic"), createElement(Probe))));
  await act(async () => observe([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  await act(async () => host.querySelector('button')!.dispatchEvent(new WheelEvent("wheel", { deltaY: 300, bubbles: true })));
  expect(requests).toHaveLength(1);
});
it.each(["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "])("retains genuine %s exploration on the results scroller", async key => {
  await act(async () => root.render(createElement("div", { "data-naming-results-scroll": true, tabIndex: 0 }, createElement(Probe))));
  await act(async () => observe([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  const scroller = host.querySelector('[data-naming-results-scroll]')!;
  await act(async () => scroller.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
  expect(requests).toHaveLength(1);
});

it.each(["before", "after"])("does not admit from a stale positive observer sample delivered %s a far-tail wheel", async order => {
  await act(async () => root.render(createElement("div", { "data-naming-results-scroll": true }, createElement(Probe))));
  const scroller = host.querySelector("[data-naming-results-scroll]")!;
  tailTop = 601; // One pixel beyond the root's bottom plus two 200px viewports.
  if (order === "before") await act(async () => intersection());
  await act(async () => scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true })));
  if (order === "after") await act(async () => intersection());
  expect(requests).toHaveLength(0);
  // Rejecting stale geometry must leave the genuine interaction unconsumed.
  tailTop = 600;
  await act(async () => intersection());
  expect(requests).toHaveLength(1);
});

it("ignores a queued callback from an observer replaced after a resize", async () => {
  await act(async () => root.render(createElement("div", { "data-naming-results-scroll": true }, createElement(Probe))));
  tailTop = 601;
  await act(async () => host.querySelector("[data-naming-results-scroll]")!.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true })));
  const retired = observe;
  await act(async () => resize([], {} as ResizeObserver));
  tailTop = 180;
  await act(async () => intersection(retired));
  expect(requests).toHaveLength(0);
  await act(async () => intersection());
  expect(requests).toHaveLength(1);
});

it("ignores a disposed observer after the results pane is restored", async () => {
  const render = (explorationHidden: boolean) => root.render(createElement("div", { "data-naming-results-scroll": true }, createElement(Probe, { view: { ...initialNamingView, explorationHidden } })));
  await act(async () => render(false));
  const retired = observe;
  await act(async () => render(true));
  await act(async () => render(false));
  tailTop = 601;
  await act(async () => host.querySelector("[data-naming-results-scroll]")!.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true })));
  tailTop = 180;
  await act(async () => intersection(retired));
  expect(requests).toHaveLength(0);
  await act(async () => intersection());
  expect(requests).toHaveLength(1);
});

it.each(["zero-size root", "hidden root", "hidden tail"])("does not admit through stale intersection geometry with a %s", async layout => {
  await act(async () => root.render(createElement("div", { "data-naming-results-scroll": true }, createElement(Probe))));
  const scroller = host.querySelector<HTMLElement>("[data-naming-results-scroll]")!;
  if (layout === "zero-size root") viewportHeight = 0;
  else (layout === "hidden root" ? scroller : host.querySelector<HTMLElement>("[data-test-naming-tail]")!).style.visibility = "hidden";
  await act(async () => scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true })));
  await act(async () => intersection());
  expect(requests).toHaveLength(0);
});

it("requires horizontal overlap with the results viewport", async () => {
  await act(async () => root.render(createElement("div", { "data-naming-results-scroll": true }, createElement(Probe))));
  tailLeft = 600;
  await act(async () => host.querySelector("[data-naming-results-scroll]")!.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true })));
  await act(async () => intersection());
  expect(requests).toHaveLength(0);
  tailLeft = 599;
  await act(async () => intersection());
  expect(requests).toHaveLength(1);
});

it.each(["wheel", "touchmove", "keydown"])("does not authorize local safe Resume from a synthetic %s event", async type => {
  const activeRun = { version: 1, ownerId: account.userId, projectId, runId: "d0000000-0000-4000-8000-000000000001", jobId: "d0000000-0000-4000-8000-000000000002", batchId: "d0000000-0000-4000-8000-000000000003",
    revision: 3, resumedFromRunId: null, canResume: true, state: "failed", projectRevision: 1, preferencesVersion: 1, feedbackRevision: 0, steeringRevision: 0, demandSequence: 1,
    snapshotHash: "b".repeat(64), acceptedPolicyIdentity: "a".repeat(64), progress: 60, preparedSetId: null, fulfillment: null,
    accounting: { status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null }, createdAt, updatedAt: createdAt };
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => { if (init.method === "POST") requests.push(path); return Response.json({ feed: { ...savedFeed, canResumeOnScroll: true, activeRun } }); }));
  await act(async () => root.render(createElement("div", { "data-naming-results-scroll": true, tabIndex: 0 }, createElement(Probe))));
  expect(latest.canResume).toBe(true);
  const event = type === "keydown" ? new KeyboardEvent(type, { key: "End", bubbles: true }) : type === "wheel" ? new WheelEvent(type, { deltaY: 300, bubbles: true }) : new Event(type, { bubbles: true });
  expect(event.isTrusted).toBe(false);
  await act(async () => host.querySelector("[data-naming-results-scroll]")!.dispatchEvent(event));
  await act(async () => intersection()); expect(requests).toHaveLength(0);
});

it("polls a reloaded progressive run every second from its saved cursor without a pending client intent", async () => {
  const reads: string[] = [], activeRun = { ...syntheticProgressiveRun("running"), ownerId: account.userId, projectId, demandSequence: 1, feedbackRevision: 0 };
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => {
    if (init.method === "POST") requests.push(path); else reads.push(path);
    return Response.json({ feed: { ...savedFeed, activeRun, progressive: { version: 1, targetCount: 100, publishedCount: 0 }, retentionRevision: 0,
      entries: path.includes("cursorPosition=") ? [] : [savedEntry] } });
  }));
  await act(async () => root.render(createElement("div", { "data-naming-results-scroll": true }, createElement(Probe))));
  expect(latest.state?.pending).toBeNull(); expect(latest.state?.status).toBe("pending"); expect(reads).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(999)); expect(reads).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(1)); expect(reads).toHaveLength(2);
  expect(reads[1]).toContain("cursorPosition=1"); expect(requests).toHaveLength(0);
});

it.each([30_000, 60_100])("preserves the %ims idle boundary for an interaction rejected while the tail was far", async elapsed => {
  await act(async () => root.render(createElement("div", { "data-naming-results-scroll": true }, createElement(Probe))));
  tailTop = 601;
  await act(async () => host.querySelector("[data-naming-results-scroll]")!.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true })));
  await act(async () => intersection());
  expect(requests).toHaveLength(0);
  await act(async () => vi.advanceTimersByTimeAsync(elapsed));
  tailTop = 180;
  await act(async () => intersection());
  expect(requests).toHaveLength(elapsed < 60_000 ? 1 : 0);
  if (elapsed >= 60_000) {
    await act(async () => host.querySelector("[data-naming-results-scroll]")!.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true })));
    expect(requests).toHaveLength(1);
  }
});
