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
const mock = vi.hoisted(() => ({ memory: null as ReturnType<typeof createNamingBrainMemory> | null, expire: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ namingBrainDrafts: mock.memory, expire: mock.expire }) }));
const account: VerifiedAccount = { status: "ready", userId: "a0000000-0000-4000-8000-000000000001", generation: 1 }, projectId = "b0000000-0000-4000-8000-000000000001";
const context = contextSnapshotSchema.parse({ description: "Synthetic feed observer" }), preferences = { ...initialNamingPreferencesV2(context), approaches: ["real_words" as const], directness: "all" as const };
const candidateId = "c0000000-0000-4000-8000-000000000001", createdAt = "2026-10-16T12:00:00Z";
const savedEntry = { entryId: candidateId, position: 1, runId: null, steeringRevision: 0, primaryApproach: null, additionalApproaches: [], publishedClaims: [], entry: { candidate: { id: candidateId, ownerId: account.userId, projectId, value: "Synthetic", identityKey: nameIdentityKey("Synthetic"), rationale: "Synthetic observer fixture.", contextRevision: 1, strategyBasis: namingStrategyBasis(context), strategyKey: namingStrategyKey(context), createdAt, origin: { kind: "local_import", ownerId: account.userId, projectId, candidateId, contextRevision: 1, source: { id: candidateId, value: "Synthetic", createdAt, origin: "manual", history: [] }, capturedContext: context } }, retention: { ownerId: account.userId, projectId, candidateId, revision: 0, favorite: false, saved: false, updatedAt: null } } };
const savedFeed = { version: 1, ownerId: account.userId, projectId, projectRevision: 1, preferencesVersion: 1, feedbackRevision: 0, steeringRevision: 0, demandSequence: 1, entries: [savedEntry], nextCursor: null, consumedThrough: null, activeRun: null, preparedSetId: null, state: "active", availability: { status: "available", handlerVersion: "naming-brain-v1", protocol: "openai_agents", acceptedPolicyIdentity: "a".repeat(64) } };
let root: Root, host: HTMLDivElement, latest: ReturnType<typeof useNamingFeed>, observe: IntersectionObserverCallback, options: IntersectionObserverInit | undefined, requests: string[];
function Probe({ view = initialNamingView }: { view?: NamingFeedView }) { const feed = useNamingFeed({ account, projectId, enabled: true, view }); useLayoutEffect(() => { latest = feed; }); return createElement("div", { ref: feed.attachSentinel }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); requests = [];
  mock.memory = createNamingBrainMemory({ storage: () => null }); mock.memory.bind(account); mock.memory.connectPreferences(account, projectId, { ownerId: account.userId, projectId, version: 1, preferences, createdAt: "2026-10-16T12:00:00Z" }, context);
  vi.stubGlobal("IntersectionObserver", class { constructor(callback: IntersectionObserverCallback, init?: IntersectionObserverInit) { observe = callback; options = init; } observe() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => { if (init.method === "POST") requests.push(path); return Response.json({ feed: savedFeed }); }));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("survives StrictMode remount and observes two viewports ahead without admitting on mount", async () => {
  await act(async () => root.render(createElement(StrictMode, null, createElement(Probe))));
  expect(latest.state?.feed?.projectId).toBe(projectId); expect(options?.rootMargin).toBe(`${window.innerHeight * 2}px 0px`);
  await act(async () => observe([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(requests).toHaveLength(0);
  await act(async () => latest.start());
  await act(async () => observe([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(requests).toHaveLength(0);
});
it("removes active demand when detail or saved views replace exploration", async () => {
  await act(async () => root.render(createElement(Probe))); await act(async () => latest.start());
  await act(async () => root.render(createElement(Probe, { view: { ...initialNamingView, inspecting: true } })));
  await act(async () => window.dispatchEvent(new WheelEvent("wheel", { deltaY: 300 })));
  expect(latest.eligibleView).toBe(false); expect(requests).toHaveLength(0);
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
