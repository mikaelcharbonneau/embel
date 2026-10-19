import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNamingFeedController } from "@/components/naming/naming-feed-controller";
import { createNamingBrainMemory } from "@/components/naming/naming-brain-memory";
import { type EnsureNamingRunIntent, type NamingBrainRunSummary, type NamingFeed, type NamingFeedEntry } from "@/domain/naming-brain";
import { initialNamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import { contextSnapshotSchema } from "@/domain/projects";
import { nameIdentityKey, namingStrategyBasis, namingStrategyKey } from "@/domain/project-naming";

const id = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const account = { userId: id(1), generation: 1 }, projectId = id(2), when = "2026-10-18T12:00:00Z";
const context = contextSnapshotSchema.parse({ description: "Synthetic scroll recovery fixture" });
function entry(n: number): NamingFeedEntry {
  const value = `Synthetic ${n}`, candidateId = id(n + 1000);
  return { entryId: id(n + 2000), position: n, runId: null, steeringRevision: 0, primaryApproach: null, additionalApproaches: [], publishedClaims: [], entry: {
    candidate: { id: candidateId, ownerId: account.userId, projectId, value, identityKey: nameIdentityKey(value), rationale: "Synthetic user-authored fixture", contextRevision: 1,
      strategyBasis: namingStrategyBasis(context), strategyKey: namingStrategyKey(context), createdAt: when,
      origin: { kind: "local_import", ownerId: account.userId, projectId, candidateId, contextRevision: 1, source: { id: id(n + 3000), value, createdAt: when, origin: "manual", history: [] }, capturedContext: context } },
    retention: { ownerId: account.userId, projectId, candidateId, revision: n === 100 ? 1 : 0, favorite: n === 100, saved: false, updatedAt: n === 100 ? when : null },
  } };
}
function run(state: NamingBrainRunSummary["state"] = "partial"): NamingBrainRunSummary {
  return { version: 1, ownerId: account.userId, projectId, runId: id(10), jobId: id(11), batchId: id(12), revision: 7, resumedFromRunId: null, canResume: true,
    state, projectRevision: 1, preferencesVersion: 1, feedbackRevision: 0, steeringRevision: 0, demandSequence: 2, snapshotHash: "b".repeat(64), acceptedPolicyIdentity: "a".repeat(64),
    progress: 60, preparedSetId: null, fulfillment: null, accounting: { status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null }, createdAt: when, updatedAt: when };
}
function feed(): NamingFeed {
  return { version: 1, ownerId: account.userId, projectId, projectRevision: 1, preferencesVersion: 1, feedbackRevision: 1, steeringRevision: 0, demandSequence: 2,
    canResumeOnScroll: true, entries: [entry(200)], nextCursor: null, consumedThrough: { entryId: entry(200).entryId, position: 200 }, activeRun: run(), preparedSetId: null,
    paused: false, state: "active", availability: { status: "available", handlerVersion: "naming-brain-v1", protocol: "openai_agents", acceptedPolicyIdentity: "a".repeat(64) } };
}
function fixture(initial = feed()) {
  let latest = initial, visible = true, eligible = true;
  const memory = createNamingBrainMemory({ storage: () => null }); memory.bind(account);
  memory.connectPreferences(account, projectId, { ownerId: account.userId, projectId, version: 1, createdAt: when,
    preferences: { ...initialNamingPreferencesV2(context), approaches: ["real_words"], directness: "open_ended" } }, context);
  const requests: { path: string; method: string; body: unknown }[] = [];
  let respond = async (path: string, options: { method?: string; body?: unknown }): Promise<unknown> => {
    if (path.endsWith("/feed/stop")) return { feed: { ...latest, paused: true, state: "paused", demandSequence: latest.demandSequence + 1 } };
    if (options.method !== "POST") return { feed: latest };
    const activeRun = { ...run("queued"), runId: id(20), resumedFromRunId: latest.activeRun!.runId, demandSequence: latest.demandSequence + 1, canResume: false };
    latest = { ...latest, activeRun, demandSequence: activeRun.demandSequence }; delete latest.canResumeOnScroll;
    return { status: "pending", feed: latest, run: activeRun, reused: false };
  };
  const request = vi.fn(async (path: string, _schema: unknown, options: { method?: string; body?: unknown }) => {
    requests.push({ path, method: options.method ?? "GET", body: options.body }); return respond(path, options);
  });
  const controller = createNamingFeedController({ account, projectId, memory, request: request as never, eligible: () => eligible, visible: () => visible });
  return { controller, memory, request, requests, setFeed: (next: NamingFeed) => { latest = next; }, respond: (next: typeof respond) => { respond = next; },
    visible: (value: boolean) => { visible = value; }, eligible: (value: boolean) => { eligible = value; }, posts: () => requests.filter(row => row.path.endsWith("/feed/ensure")) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each(["failed", "partial"] as const)("uses one fresh interaction to resume an owned %s run and retains200 rows and its favorite", async state => {
  const f = fixture({ ...feed(), activeRun: run(state) });
  f.memory.setFeed(account, projectId, value => ({ ...value, entries: Array.from({ length: 200 }, (_, i) => entry(i + 1)) }));
  await f.controller.load();
  await f.controller.demand(); expect(f.posts()).toHaveLength(0);
  f.controller.interact(true); await Promise.all([f.controller.demand(), f.controller.demand()]);
  expect(f.posts()).toHaveLength(1);
  expect(f.posts()[0]!.body).toMatchObject({ version: 1, reason: "resume", resumeOfRunId: id(10), expectedRunRevision: 7,
    expectedProjectRevision: 1, expectedPreferencesVersion: 1, expectedSteeringRevision: 0, expectedDemandSequence: 2,
    consumedThrough: { entryId: entry(200).entryId, position: 200 }, idempotencyKey: expect.any(String) });
  expect(f.memory.get(account, projectId)?.feed.entries).toHaveLength(200);
  expect(f.memory.get(account, projectId)?.feed.entries[99]!.entry.retention.favorite).toBe(true);
  await f.controller.demand(); expect(f.posts()).toHaveLength(1);
});

it("loads saved pages before Resume and requires another fresh interaction after list growth", async () => {
  const first = { ...feed(), entries: Array.from({ length: 100 }, (_, i) => entry(i + 1)), nextCursor: { entryId: entry(100).entryId, position: 100 } }, f = fixture(first);
  await f.controller.load(); f.setFeed({ ...feed(), entries: Array.from({ length: 100 }, (_, i) => entry(i + 101)) });
  f.controller.interact(true); await f.controller.demand();
  expect(f.requests.at(-1)!.path).toContain("cursorPosition=100"); expect(f.posts()).toHaveLength(0);
  expect(f.memory.get(account, projectId)?.feed.entries).toHaveLength(200);
  await f.controller.demand(); expect(f.posts()).toHaveLength(0);
  f.controller.interact(true); await f.controller.demand(); expect(f.posts()).toHaveLength(1);
});

it("never resumes on load, unchanged intersection, remount or an expired interaction", async () => {
  const f = fixture(); await f.controller.load(); await f.controller.demand(); await f.controller.load(); await f.controller.demand();
  f.controller.interact(true); await vi.advanceTimersByTimeAsync(60_001); await f.controller.demand();
  f.controller.interact(true); f.controller.deactivate(); await f.controller.demand();
  f.controller.dispose();
  const restored = createNamingFeedController({ account, projectId, memory: f.memory, request: f.request as never, eligible: () => true });
  await restored.load(); await restored.demand(); expect(f.posts()).toHaveLength(0);
});

it("requires an explicitly trusted gesture for the new Resume token", async () => {
  const f = fixture(); await f.controller.load();
  f.controller.interact(); await f.controller.demand();
  f.controller.interact(false); await f.controller.demand(); expect(f.posts()).toHaveLength(0);
  f.controller.interact(true); await f.controller.demand(); expect(f.posts()).toHaveLength(1);
});

it.each(["running", "queued", "cancel_requested", "cancelled", "needs_reconciliation", "superseded"] as const)("cannot turn a gesture during %s into a later Resume", async state => {
  const f = fixture({ ...feed(), activeRun: run(state) }); await f.controller.load(); f.controller.interact(true);
  f.setFeed(feed()); await f.controller.load(); await f.controller.demand(); expect(f.posts()).toHaveLength(0);
  f.controller.interact(true); await f.controller.demand(); expect(f.posts()).toHaveLength(1);
});

it.each(["revision", "project", "preferences", "direction", "sequence"] as const)("a gesture cannot authorize a changed %s basis", async field => {
  const f = fixture(); await f.controller.load(); f.controller.interact(true);
  const next = feed(), activeRun = next.activeRun!;
  if (field === "revision") activeRun.revision += 1;
  if (field === "project") { next.projectRevision += 1; activeRun.projectRevision += 1; }
  if (field === "preferences") { next.preferencesVersion += 1; activeRun.preferencesVersion += 1; }
  if (field === "direction") { next.steeringRevision += 1; activeRun.steeringRevision += 1; }
  if (field === "sequence") { next.demandSequence += 1; activeRun.demandSequence += 1; }
  f.setFeed(next); await f.controller.load(); await f.controller.demand(); expect(f.posts()).toHaveLength(0);
});

it.each(["capability", "canResume", "unavailable", "paused", "blocked", "staleProject", "stalePreferences", "staleDirection", "staleSequence"] as const)("refuses scroll Resume with %s", async condition => {
  const initial = feed();
  if (condition === "capability") delete initial.canResumeOnScroll;
  if (condition === "canResume") initial.activeRun!.canResume = false;
  if (condition === "unavailable") initial.availability = { status: "unavailable", code: "worker_unavailable" };
  if (condition === "paused") { initial.paused = true; initial.state = "paused"; }
  if (condition === "blocked") initial.state = "blocked";
  if (condition === "staleProject") initial.projectRevision += 1;
  if (condition === "stalePreferences") initial.preferencesVersion += 1;
  if (condition === "staleDirection") initial.steeringRevision += 1;
  if (condition === "staleSequence") initial.demandSequence += 1;
  const f = fixture(initial); await f.controller.load(); f.controller.interact(true); await f.controller.demand(); expect(f.posts()).toHaveLength(0);
});

it.each(["hidden", "ineligible", "owner", "dirty", "saving", "conflict", "unready", "missingPreferences"] as const)("refuses scroll Resume while %s", async condition => {
  const f = fixture(); await f.controller.load();
  if (condition === "hidden") f.visible(false);
  if (condition === "ineligible") f.eligible(false);
  if (condition === "owner") f.memory.bind({ userId: id(99), generation: 2 });
  const record = f.memory.get(account, projectId);
  if (record?.preferences) {
    if (condition === "dirty") record.preferences.dirty = true;
    if (condition === "saving") record.preferences.status = "saving";
    if (condition === "conflict") record.preferences.status = "conflict";
    if (condition === "unready") record.preferences.saved = { ...record.preferences.saved!, preferences: initialNamingPreferencesV2(context) };
    if (condition === "missingPreferences") record.preferences = null;
  }
  f.controller.interact(true); await f.controller.demand(); expect(f.posts()).toHaveLength(0);
});

it.each([false, true])("an explicit Stop remains a fence even if its acknowledgement is lost=%s", async lost => {
  const f = fixture(); await f.controller.load();
  if (lost) f.respond(async path => { if (path.endsWith("/feed/stop")) throw new Error("Synthetic lost Stop acknowledgement"); return { feed: feed() }; });
  await f.controller.stop(); f.setFeed(feed()); await f.controller.load();
  f.controller.interact(true); await f.controller.demand(); expect(f.posts()).toHaveLength(0);
  expect(f.memory.get(account, projectId)?.feed.stopRequested).toBe(true);
});

it("keeps a lost Resume acknowledgement pending and retries the exact existing intent", async () => {
  const f = fixture(); await f.controller.load();
  f.respond(async (_path, options) => { if (options.method === "POST") throw new Error("Synthetic lost Resume acknowledgement"); return { feed: feed() }; });
  f.controller.interact(true); await f.controller.demand(); const original = f.posts()[0]!.body as EnsureNamingRunIntent;
  f.controller.interact(true); await f.controller.demand(); await f.controller.load(); await f.controller.demand(); expect(f.posts()).toHaveLength(1);
  expect(f.memory.get(account, projectId)?.feed.pending).toEqual(original);
  await f.controller.retry(); expect(f.posts().map(row => row.body)).toEqual([original, original]);
});
