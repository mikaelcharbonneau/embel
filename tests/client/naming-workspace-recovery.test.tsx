// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNamingBrainMemory } from "@/components/naming/naming-brain-memory";
import { ProjectNamingWorkspace } from "@/components/naming/project-naming-workspace";
import { accountProjectSchema } from "@/domain/project-api";
import { getNamingReadiness, nameIdentityKey, namingBrainBatchSchema, namingStrategyBasis, namingStrategyKey, type NamingViewState, type ProjectNameEntry } from "@/domain/project-naming";
import { initialNamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import { projectNamingOverviewSchema, type ProjectNamingOverview } from "@/domain/naming-jobs";
import type { NamingFeed, NamingBrainRunSummary } from "@/domain/naming-brain";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { initialNamingView } from "@/components/naming/use-project-naming";

const mock = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return { session: null as VerifiedAccount | { status: "checking" | "signed_out"; generation: number } | null, memory: null as ReturnType<typeof createNamingBrainMemory> | null, model: null as unknown,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, snapshot: () => mock.model,
    notify: () => listeners.forEach(listener => listener()), current: vi.fn(), expire: vi.fn(), navigate: vi.fn() };
});
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: mock.session, namingBrainDrafts: mock.memory, isCurrent: mock.current, expire: mock.expire }), AccountStatus: () => createElement("p", {}, "Verify account") }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.navigate }) }));
vi.mock("@/components/naming/use-names-store", () => ({ useNamesStore: () => ({ loaded: true, data: { candidates: [] }, storage: "available" }) }));
vi.mock("@/components/naming/use-project-naming", async importOriginal => {
  const actual = await importOriginal<typeof import("@/components/naming/use-project-naming")>();
  const { useSyncExternalStore } = await import("react");
  return { ...actual, useProjectNaming: () => useSyncExternalStore(mock.subscribe, mock.snapshot, mock.snapshot) as ReturnType<typeof actual.useProjectNaming> };
});

const ownerId = "a0000000-0000-4000-8000-000000000001", projectId = "b0000000-0000-4000-8000-000000000001", candidateId = "c0000000-0000-4000-8000-000000000001", when = "2026-10-16T12:00:00Z";
const project = accountProjectSchema.parse({ id: projectId, owner_id: ownerId, title: "Synthetic workspace", scope: "naming_only", current_revision: 1, created_at: when, context: { description: "A synthetic Naming workspace" } });
const preferences = { ...initialNamingPreferencesV2(project.context), approaches: ["real_words" as const], directness: "all" as const };
const entry: ProjectNameEntry = { candidate: { id: candidateId, ownerId, projectId, value: "Juniper", identityKey: nameIdentityKey("Juniper"), rationale: "Synthetic workspace candidate.", contextRevision: 1, strategyBasis: namingStrategyBasis(project.context), strategyKey: namingStrategyKey(project.context), createdAt: when,
  origin: { kind: "local_import", ownerId, projectId, candidateId, contextRevision: 1, source: { id: candidateId, value: "Juniper", createdAt: when, origin: "manual", history: [] }, capturedContext: project.context } }, retention: { ownerId, projectId, candidateId, revision: 0, favorite: false, saved: false, updatedAt: null } };
const activeRun: NamingBrainRunSummary = { version: 1, ownerId, projectId, runId: "d0000000-0000-4000-8000-000000000001", jobId: "d0000000-0000-4000-8000-000000000002", batchId: "d0000000-0000-4000-8000-000000000003", revision: 1, resumedFromRunId: null, canResume: false, state: "queued", projectRevision: 1, preferencesVersion: 1, feedbackRevision: 0, steeringRevision: 0, demandSequence: 0, snapshotHash: "b".repeat(64), acceptedPolicyIdentity: "a".repeat(64), progress: 0, preparedSetId: null, fulfillment: null, accounting: { status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null }, createdAt: when, updatedAt: when };
let root: Root, host: HTMLDivElement, overview: ProjectNamingOverview, server: NamingFeed, calls: { path: string; method: string; body: unknown }[], viewWrites: Partial<NamingViewState>[], holdView: Promise<boolean> | null, holdSteering: Promise<void> | null, holdFeed: Promise<void> | null, failSteering: boolean;
function model() { return mock.model as ReturnType<typeof import("@/components/naming/use-project-naming").useProjectNaming>; }
function publish(patch: Partial<ReturnType<typeof model>>) { mock.model = { ...model(), ...patch }; mock.notify(); }
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent?.trim() === name || element.getAttribute("aria-label") === name || element.title === name);
async function click(name: string) { const element = button(name); expect(element, name).toBeDefined(); await act(async () => element!.click()); }
async function input(element: HTMLInputElement | HTMLTextAreaElement, text: string) { await act(async () => { Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, text); element.dispatchEvent(new Event("input", { bubbles: true })); }); }
const message = () => host.querySelector<HTMLTextAreaElement>('form textarea')!;
async function selectSeed() { await click("Inspect name Juniper"); await act(async () => host.querySelector<HTMLInputElement>('.naming-steering-choice input')!.click()); await click("Back to results"); }
async function checkSeed() { await click("Inspect name Juniper"); expect(host.querySelector<HTMLInputElement>('.naming-steering-choice input')?.checked).toBe(true); await click("Back to results"); }
async function finishQuestions() { while (button("Continue")) await click("Continue"); }
async function render() { await act(async () => root.render(createElement(ProjectNamingWorkspace, { projectId }))); }
const ensures = () => calls.filter(call => call.path.endsWith("/feed/ensure"));
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  Element.prototype.scrollIntoView = vi.fn();
  mock.session = { status: "ready", userId: ownerId, generation: 1 }; mock.memory = createNamingBrainMemory({ storage: () => null }); mock.memory.bind(mock.session);
  mock.current.mockImplementation((account: VerifiedAccount) => mock.session?.status === "ready" && account.userId === mock.session.userId && account.generation === mock.session.generation);
  calls = []; viewWrites = []; holdView = null; holdSteering = null; holdFeed = null; failSteering = false;
  const owned = { ownerId, projectId };
  overview = projectNamingOverviewSchema.parse({ project, readiness: getNamingReadiness(project.context, project.scope), session: { ...owned, revision: 1, currentPreferencesVersion: 1, latestBatchSequence: 0, currentSelectionId: null, viewRevision: 1, viewState: initialNamingView, createdAt: when, updatedAt: when }, preferences: { ...owned, version: 1, preferences, createdAt: when }, currentSelection: null,
    batches: { ...owned, items: [], nextCursor: null }, candidates: { ...owned, items: [entry], nextCursor: null }, jobs: [], availability: { status: "unavailable", operation: "naming.generate", reason: "runtime_disabled" }, screening: { domains: { status: "not_checked", reason: "integration_unavailable" }, handles: { status: "not_checked", reason: "integration_unavailable" }, trademarks: { status: "not_checked", reason: "integration_unavailable" } } });
  server = { version: 1, ...owned, projectRevision: 1, preferencesVersion: 1, steeringRevision: 0, feedbackRevision: 0, demandSequence: 0, entries: [{ entryId: candidateId, position: 1, runId: null, steeringRevision: 0, entry, primaryApproach: null, additionalApproaches: [], publishedClaims: [] }], nextCursor: null, consumedThrough: null, activeRun: null, preparedSetId: null, paused: false, state: "active", availability: { status: "available", handlerVersion: "naming-brain-v1", protocol: "openai_agents", acceptedPolicyIdentity: "a".repeat(64) } };
  mock.model = { overview, pending: false, blocked: false, workspace: null, readError: null, actionError: null, listStatus: "ready", refresh: vi.fn(),
    saveView: vi.fn(async (patch: Partial<NamingViewState>) => {
      viewWrites.push(patch); publish({ pending: true });
      if (patch.filter === "all" && holdView && !await holdView) { publish({ pending: false, actionError: "The saved view could not be confirmed." }); return false; }
      overview = { ...overview, session: { ...overview.session!, viewRevision: overview.session!.viewRevision + 1, viewState: { ...overview.session!.viewState, ...patch } } };
      publish({ overview, pending: false }); return true;
    }), saveChatProgress: vi.fn(async () => true), retain: vi.fn(async () => true), select: vi.fn(async () => true), transform: vi.fn(async () => null), importLocal: vi.fn(async () => true), expand: vi.fn(async () => true), loadMore: vi.fn(), loadMoreBatches: vi.fn(), loadBatchDetail: vi.fn(), cancel: vi.fn(), enqueue: vi.fn() };
  vi.stubGlobal("fetch", vi.fn(async (path: string, options: RequestInit) => {
    const body = options.body ? JSON.parse(String(options.body)) : null; calls.push({ path, method: options.method ?? "GET", body });
    if (path.endsWith("/feed/ensure")) { server = { ...server, activeRun: { ...activeRun, preferencesVersion: server.preferencesVersion, steeringRevision: server.steeringRevision, demandSequence: server.demandSequence } }; return Response.json({ status: "pending", feed: server, run: server.activeRun, reused: false }); }
    if (path.endsWith("/steering")) { server = { ...server, steeringRevision: body.expectedSteeringRevision + 1, demandSequence: body.expectedSteeringRevision + 1 }; if (failSteering) { failSteering = false; throw new Error("Synthetic lost steering acknowledgement"); } if (holdSteering) await holdSteering; return Response.json({ feed: server, supersededRunIds: [], cancellationRequestedRunIds: [] }); }
    if (path.endsWith("/preferences")) { overview = { ...overview, preferences: { ...overview.preferences!, version: body.expectedPreferencesVersion + 1, preferences: body.preferences }, session: { ...overview.session!, currentPreferencesVersion: body.expectedPreferencesVersion + 1 } }; server = { ...server, preferencesVersion: body.expectedPreferencesVersion + 1 }; publish({ overview }); return Response.json({ session: overview.session, preferences: overview.preferences }); }
    if (holdFeed) await holdFeed; return Response.json({ feed: server });
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { if (root) await act(async () => root.unmount()); host?.remove(); mock.memory?.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each([true, false])("saved-partial continuation uses the server free witness=%s through the real workspace hook", async canResumeSaved => {
  const savedRow = server.entries[0]!, run: NamingBrainRunSummary = { ...activeRun, state: "partial", revision: 2, canResume: true, canResumeSaved, preparedSetId: "e0000000-0000-4000-8000-000000000001", fulfillment: { status: "partial", targetCount: 100, acceptedCount: 1, missingCount: 99, coverageSatisfied: false, message: "One saved synthetic name." } };
  const savedEntry: ProjectNameEntry = { ...savedRow.entry, candidate: { ...savedRow.entry.candidate, origin: { kind: "generated", version: 2, handlerVersion: "naming-brain-v1", ownerId, projectId, candidateId, contextRevision: 1, value: "Juniper", batchId: run.batchId, jobId: run.jobId, stepKey: "prepare", runId: run.runId, sourceArtifactId: "f0000000-0000-4000-8000-000000000001", sourceStageKey: "creation", provider: "openai", billingMode: "openai_api", model: "synthetic-fixture-model", requestId: null, providerItemId: "fixture-item", generatedAt: when, protocol: "openai_agents", sessionId: "fixture-session", turnId: "fixture-turn", agentId: null, responseId: null } } };
  server = { ...server, entries: [], activeRun: run, preparedSetId: run.preparedSetId, paused: true, state: "paused", demandSequence: 1, availability: { status: "unavailable", code: "worker_unavailable" } };
  const existingFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (path: string, options: RequestInit) => {
    if (!path.endsWith("/feed/ensure")) return existingFetch(path, options);
    const body = JSON.parse(String(options.body)); calls.push({ path, method: "POST", body });
    server = { ...server, entries: [{ ...savedRow, entry: savedEntry, runId: run.runId, primaryApproach: "real_words" }], paused: false, state: "active", demandSequence: 2, preparedSetId: null, activeRun: { ...run, canResume: false, canResumeSaved: false } };
    return Response.json({ status: "appended", feed: server, runId: run.runId, appendedEntryIds: [savedRow.entryId] });
  }));
  await render();
  const action = button(canResumeSaved ? "Continue with saved names" : "Resume unfinished exploration"); expect(action).toBeDefined(); expect(action!.disabled).toBe(!canResumeSaved);
  expect(ensures()).toHaveLength(0);
  if (canResumeSaved) {
    await click("Continue with saved names");
    expect(ensures()).toHaveLength(1); expect(ensures()[0]!.body).toMatchObject({ reason: "resume", resumeOfRunId: run.runId, expectedRunRevision: 2, expectedDemandSequence: 1 });
    expect(server.activeRun).toMatchObject({ runId: run.runId, canResume: false });
    expect(mock.memory!.get(mock.session as VerifiedAccount, projectId)!.feed.error).toBeNull();
    expect(mock.memory!.get(mock.session as VerifiedAccount, projectId)!.feed.entries).toHaveLength(1);
    expect(host.querySelectorAll(".naming-feed-card")).toHaveLength(1);
  }
});

it.each(["history", "filtered", "inspection"] as const)("I4 Continue explicitly enters exploration from %s in the actual workspace", async view => {
  if (view === "filtered") { overview = { ...overview, session: { ...overview.session!, viewState: { ...initialNamingView, filter: "saved", query: "Juniper" } } }; publish({ overview }); }
  await render();
  if (view === "history") await click("Saved names & history");
  if (view === "inspection") await click("Inspect name Juniper");
  if (view !== "inspection") await click("Modify filters");
  expect(ensures()).toHaveLength(0);
  let acknowledge!: (ok: boolean) => void;
  if (view === "filtered") holdView = new Promise(resolve => { acknowledge = resolve; });
  await finishQuestions();
  await click("Apply updated choices");
  if (view === "filtered") { expect(ensures()).toHaveLength(0); expect(viewWrites.at(-1)).toMatchObject({ pane: "results", filter: "all", query: "", visibleBatchId: null }); await act(async () => acknowledge(true)); }
  expect(host.querySelector('.naming-continuous-results')).not.toBeNull(); expect(host.querySelector('[aria-label="Inspect name"]')).toBeNull();
  expect(ensures()).toHaveLength(1);
});
it("I4 keeps a failed saved-view transition actionable without admitting work", async () => {
  overview = { ...overview, session: { ...overview.session!, viewState: { ...initialNamingView, filter: "saved", query: "Juniper" } } }; publish({ overview });
  await render(); await click("Modify filters"); holdView = Promise.resolve(false);
  await finishQuestions();
  await click("Apply updated choices");
  expect(viewWrites.at(-1)).toMatchObject({ pane: "results", filter: "all", query: "", visibleBatchId: null });
  expect(host.textContent).toContain("The saved view could not be confirmed.");
  expect(host.querySelector('.naming-continuous-results')).toBeNull(); expect(ensures()).toHaveLength(0);
  await act(async () => { window.dispatchEvent(new Event("wheel")); await vi.advanceTimersByTimeAsync(15_000); });
  expect(ensures()).toHaveLength(0);
  holdView = null; await finishQuestions(); await click("Apply updated choices"); expect(ensures()).toHaveLength(1);
});
it("I4 does not admit work after leaving exploration while Continue awaits its saved-head read", async () => {
  await render(); await click("Saved names & history"); await click("Modify filters");
  let release!: () => void; holdFeed = new Promise(resolve => { release = resolve; });
  await finishQuestions();
  await click("Apply updated choices"); expect(host.querySelector('.naming-continuous-results')).not.toBeNull();
  await click("Saved names & history"); await act(async () => release());
  expect(ensures()).toHaveLength(0); expect(host.querySelector('.naming-continuous-results')).toBeNull();
});
it("I1 retains the visible exact steering retry after an ordinary GET observes its saved revision", async () => {
  await render(); await selectSeed(); await input(message(), "Keep a quiet rhythm");
  failSteering = true; await click("Send naming direction"); const first = calls.find(call => call.path.endsWith('/steering'))!.body;
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(button("Retry the same request")).toBeDefined(); await click("Retry the same request");
  expect(calls.filter(call => call.path.endsWith('/steering')).map(call => call.body)).toEqual([first, first]); expect(ensures()).toHaveLength(0);
  expect(button("Clear selection")).toBeUndefined(); expect(message().value).toBe(""); expect(mock.memory!.hasUnsaved()).toBe(false);
});
it.each(["logout", "different owner"])("I5 retains seeds and typed emphasis through inspect/history/verification, clears on %s, and never submits", async end => {
  await render(); await selectSeed();
  await input(message(), "Keep the quiet rhythm and softer vowels");
  expect(mock.memory!.hasUnsaved()).toBe(true);
  await click("Inspect name Juniper"); await click("Back to results");
  expect(message().value).toBe("Keep the quiet rhythm and softer vowels");
  await click("Saved names & history"); await click("Back to exploration");
  await checkSeed();
  await act(async () => { mock.memory!.bind(null); mock.session = { status: "checking", generation: 2 }; }); await render();
  expect(host.textContent).not.toContain("Keep the quiet rhythm");
  mock.session = { status: "ready", userId: ownerId, generation: 2 }; mock.memory!.bind(mock.session); await render();
  expect(message().value).toBe("Keep the quiet rhythm and softer vowels");
  await checkSeed();
  expect(calls.filter(call => call.path.endsWith('/steering'))).toHaveLength(0); expect(ensures()).toHaveLength(0);
  if (end === "logout") { await act(async () => { mock.memory!.clear(); mock.session = { status: "signed_out", generation: 3 }; }); }
  else {
    const other = { userId: "a0000000-0000-4000-8000-000000000002", generation: 3 };
    await act(async () => { mock.memory!.bind(other); mock.session = { status: "checking", generation: 3 }; });
    expect(mock.memory!.get(other, projectId)).toBeNull();
  }
  await render();
  expect(mock.memory!.hasUnsaved()).toBe(false);
});
it("I5 preserves edits typed during a steering save and clears only the acknowledged draft", async () => {
  await render(); await selectSeed();
  await input(message(), "Quiet rhythm");
  let acknowledge!: () => void; holdSteering = new Promise(resolve => { acknowledge = resolve; });
  await click("Send naming direction");
  await input(message(), "Quiet rhythm and softer vowels");
  await act(async () => acknowledge()); holdSteering = null;
  expect(message().value).toBe("Quiet rhythm and softer vowels");
  expect(mock.memory!.hasUnsaved()).toBe(true); expect(calls.filter(call => call.path.endsWith('/steering'))).toHaveLength(1);
  await click("Clear selection");
  expect(mock.memory!.hasUnsaved()).toBe(true); expect(button("Send naming direction")).toBeUndefined();
  expect(message().value).toBe("Quiet rhythm and softer vowels");
  await selectSeed(); await click("Send naming direction");
  expect(button("Clear selection")).toBeUndefined(); expect(message().value).toBe(""); expect(mock.memory!.hasUnsaved()).toBe(false);
  expect(calls.filter(call => call.path.endsWith('/steering')).map(call => (call.body as { instruction: string }).instruction)).toEqual(["Quiet rhythm", "Quiet rhythm and softer vowels"]);
  expect(ensures()).toHaveLength(0);
});
it("allows explicit seed-only steering without an optional message or an automatic run", async () => {
  await render(); await selectSeed();
  expect(message().value).toBe(""); expect(button("Send naming direction")?.disabled).toBe(false);
  await click("Send naming direction");
  expect(calls.filter(call => call.path.endsWith('/steering')).map(call => call.body)).toMatchObject([{ candidateIds: [candidateId], instruction: null }]);
  expect(mock.memory!.hasUnsaved()).toBe(false); expect(ensures()).toHaveLength(0);
});

it("keeps search controls, focus and newer text when a submitted listing is acknowledged", async () => {
  await render(); await click("Saved names & history");
  const field = host.querySelector<HTMLInputElement>('.project-naming-toolbar input[type="search"]')!;
  const toolbar = field.closest("form")!, filter = toolbar.querySelector("select")!;
  let acknowledge!: () => void;
  const held = new Promise<void>(resolve => { acknowledge = resolve; });
  vi.mocked(model().saveView).mockImplementationOnce(async patch => {
    publish({ pending: true }); await held;
    overview = { ...overview, session: { ...overview.session!, viewRevision: overview.session!.viewRevision + 1, viewState: { ...overview.session!.viewState, ...patch } }, candidates: { ...overview.candidates, items: [], nextCursor: null } };
    publish({ overview, pending: false, listStatus: "loading" }); return true;
  });
  await input(field, "Juniper");
  await act(async () => { toolbar.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await input(field, "Juniper with softer vowels"); field.focus();
  await act(async () => acknowledge());
  expect(host.querySelector('.project-naming-toolbar')).toBe(toolbar);
  expect(toolbar.querySelector("input")).toBe(field); expect(toolbar.querySelector("select")).toBe(filter);
  expect(document.activeElement).toBe(field); expect(field.value).toBe("Juniper with softer vowels");
  expect(host.querySelectorAll(".project-naming-card")).toHaveLength(0);
  expect(host.textContent).toContain("Loading names in this view"); expect(ensures()).toHaveLength(0);
});

it("synchronizes only clean search drafts across saved-view updates without replacing controls", async () => {
  await render(); await click("Saved names & history");
  const field = host.querySelector<HTMLInputElement>('.project-naming-toolbar input[type="search"]')!;
  async function savedQuery(query: string) {
    overview = { ...overview, session: { ...overview.session!, viewState: { ...overview.session!.viewState, query } } };
    await act(async () => publish({ overview }));
    expect(host.querySelector('.project-naming-toolbar input')).toBe(field);
  }
  await savedQuery("Juniper"); expect(field.value).toBe("Juniper");
  await input(field, "Unsubmitted direction"); await savedQuery("Fir"); expect(field.value).toBe("Unsubmitted direction");
  await input(field, "Fir"); await savedQuery(""); expect(field.value).toBe("");
  expect(ensures()).toHaveLength(0);
});

it("keeps imported-only history controls mounted through a loading, empty and failed listing", async () => {
  overview = { ...overview, preferences: null }; publish({ overview });
  await render(); await click("Saved names & history");
  const toolbar = host.querySelector('.project-naming-toolbar')!, field = toolbar.querySelector("input")!, filter = toolbar.querySelector("select")!;
  await input(field, "Unsubmitted search");
  overview = { ...overview, session: { ...overview.session!, viewState: { ...overview.session!.viewState, filter: "favorite" } }, candidates: { ...overview.candidates, items: [], nextCursor: null } };
  for (const listStatus of ["loading", "ready", "failed"] as const) {
    await act(async () => publish({ overview, listStatus, readError: listStatus === "failed" ? "Synthetic read failed" : null }));
    expect(host.querySelector('.project-naming-toolbar')).toBe(toolbar);
    expect(toolbar.querySelector("input")).toBe(field); expect(toolbar.querySelector("select")).toBe(filter);
    expect(field.value).toBe("Unsubmitted search"); expect(host.querySelectorAll(".project-naming-card")).toHaveLength(0);
    expect(button("Load more saved names")).toBeUndefined();
  }
  expect(host.textContent).toContain("This list could not be loaded"); expect(ensures()).toHaveLength(0);
  overview = { ...overview, session: { ...overview.session!, viewState: { ...overview.session!.viewState, filter: "all", query: "" } } };
  await act(async () => publish({ overview, listStatus: "ready", readError: null }));
  expect(host.querySelector('.project-naming-toolbar')).toBe(toolbar);
  expect(host.textContent).toContain("Review your Naming choices in the conversation");
  expect(host.textContent).not.toContain("Your preferences are saved");
});

it("preserves an open batch history and its controls when filtering and choosing a batch", async () => {
  const batch = namingBrainBatchSchema.parse({ version: 2, handlerVersion: "naming-brain-v1", billingMode: "openai_api", runId: activeRun.runId,
    id: activeRun.batchId, ownerId, projectId, contextRevision: 1, strategyBasis: namingStrategyBasis(project.context), strategyKey: namingStrategyKey(project.context),
    preferencesVersion: 1, preferences, favoritesSnapshot: [], acceptedPolicyIdentity: "a".repeat(64), targetCount: 100, sequence: 1, jobId: activeRun.jobId, createdAt: when });
  overview = { ...overview, session: { ...overview.session!, latestBatchSequence: 1 }, batches: { ...overview.batches, items: [{ batch, result: null }] } }; publish({ overview });
  await render(); await click("Saved names & history");
  const history = host.querySelector<HTMLDetailsElement>(".project-naming-batch-history")!, filter = host.querySelector<HTMLSelectElement>('[aria-label="Filter project names"]')!, shown = host.querySelector<HTMLSelectElement>('[aria-label="Shown batch"]')!;
  history.open = true;
  await act(async () => { filter.value = "favorite"; filter.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { shown.value = batch.id; shown.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(host.querySelector(".project-naming-batch-history")).toBe(history); expect(history.open).toBe(true);
  expect(host.querySelector('[aria-label="Filter project names"]')).toBe(filter); expect(host.querySelector('[aria-label="Shown batch"]')).toBe(shown);
  expect(shown.value).toBe(batch.id); expect(ensures()).toHaveLength(0);
});

it("keeps one results body and count slot through changed-query loading, failure and actual zero", async () => {
  overview = { ...overview, candidates: { ...overview.candidates, nextCursor: { id: candidateId, createdAt: when } } }; publish({ overview });
  await render(); await click("Saved names & history");
  const body = host.querySelector('.project-naming-results-body')!, count = host.querySelector('.project-naming-results-count')!;
  const toolbar = host.querySelector('.project-naming-toolbar')!, field = toolbar.querySelector('input')!;
  expect(body).not.toBeNull(); expect(count.textContent).toBe("1 names loaded · more available");
  await input(field, "Juniper"); field.focus();
  overview = { ...overview, session: { ...overview.session!, viewState: { ...overview.session!.viewState, query: "Juniper", filter: "favorite" } }, candidates: { ...overview.candidates, items: [], nextCursor: null } };
  for (const listStatus of ["loading", "failed", "ready"] as const) {
    await act(async () => publish({ overview, listStatus, readError: listStatus === "failed" ? "Synthetic changed-list read failed" : null }));
    expect(host.querySelector('.project-naming-results-body')).toBe(body);
    expect(host.querySelector('.project-naming-results-count')).toBe(count);
    expect(host.querySelector('.project-naming-toolbar')).toBe(toolbar);
    expect(toolbar.querySelector('input')).toBe(field); expect(document.activeElement).toBe(field);
    expect(body.getAttribute("aria-busy")).toBe(String(listStatus === "loading"));
    expect(count.textContent).toBe(listStatus === "loading" ? "Updating names…" : listStatus === "failed" ? "Count unavailable" : "0 names in this view");
    expect(body.textContent).not.toContain("Juniper"); expect(body.querySelectorAll('button, article, [id^="project-name-"]')).toHaveLength(listStatus === "ready" ? 1 : 0);
    expect(host.querySelectorAll('.project-naming-card')).toHaveLength(0); expect(button("Load more saved names")).toBeUndefined();
    expect(host.textContent).not.toContain("0 names loaded");
    if (listStatus !== "ready") expect(host.textContent).not.toContain("No names in this view");
  }
  expect(body.textContent).toContain("No names in this view"); expect(ensures()).toHaveLength(0);
});

it.each(["checking", "signed_out"] as const)("hides every private results node and draft during owner invalidation: %s", async status => {
  await render(); await click("Saved names & history");
  await input(host.querySelector<HTMLInputElement>('.project-naming-toolbar input')!, "Private unsubmitted query");
  expect(host.querySelectorAll('.project-naming-card')).toHaveLength(1);
  expect(host.textContent).toContain(project.title);
  await act(async () => { mock.memory!.bind(null); mock.session = { status, generation: 2 }; }); await render();
  expect(host.querySelector('.project-naming-results-body')).toBeNull(); expect(host.querySelector('.project-naming-toolbar')).toBeNull();
  expect(host.querySelector('.project-naming-results-count')).toBeNull(); expect(host.querySelectorAll('.project-naming-card')).toHaveLength(0);
  expect(host.innerHTML).not.toContain("Private unsubmitted query"); expect(host.textContent).not.toContain(project.title);
  expect(host.textContent).not.toContain(entry.candidate.value); expect(host.textContent).not.toContain(entry.candidate.rationale);
  expect(host.textContent).toContain("Verify account");
  mock.session = { status: "ready", userId: "a0000000-0000-4000-8000-000000000002", generation: 3 }; mock.memory!.bind(mock.session);
  publish({ overview: null }); await render();
  expect(host.textContent).toContain("Loading your account naming workspace");
  expect(host.innerHTML).not.toContain("Private unsubmitted query"); expect(host.textContent).not.toContain(project.title);
  expect(host.querySelector('.project-naming-results-body')).toBeNull(); expect(ensures()).toHaveLength(0);
});

it("keeps bounded results geometry for loading, failure and empty without page-specific project-bar rules", () => {
  const sheet = readFileSync('src/styles/project-naming.css', 'utf8');
  const chatSheet = readFileSync('src/components/naming/naming-chat.module.css', 'utf8');
  expect(sheet).not.toContain(".project-stage-navigation");
  expect(chatSheet).not.toContain(':has(.workspace)');
  const body = sheet.match(/\.project-naming-results-body\s*\{([^}]+)\}/)?.[1];
  expect(body).toContain('min-height: clamp(216px, 40vh, 480px)');
  expect(body).not.toContain('animation');
  expect(sheet).toMatch(/\.project-naming-results-body\s*>\s*\.project-naming-(?:notice|empty)[^{]*\{[^}]*min-height:\s*inherit/s);
  expect(sheet).toMatch(/\.project-naming-toolbar\s*>\s*\.project-naming-results-count\s*\{[^}]*width:\s*18rem/s);
});
