import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureNamingRunIntentSchema, type NamingFeed } from "@/domain/naming-brain";
import { account, cursor, entries, entry, feed, fixture, id, projectId, run, when } from "./naming-progressive-fixture";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("prefetches at100 unseen saved names using the visible cursor, before the loaded300 tail", async () => {
  const f = fixture(); await f.controller.load();
  f.controller.interact(true); await f.controller.demand(cursor(199)); expect(f.posts()).toHaveLength(0);
  f.controller.interact(true); await Promise.all([f.controller.demand(cursor(200)), f.controller.demand(cursor(200))]);
  expect(f.posts()).toHaveLength(1);
  expect(f.posts()[0]!.body).toMatchObject({ reason: "scroll", consumedThrough: cursor(200), expectedDemandSequence: 2 });
  expect(f.memory.get(account, projectId)?.feed.entries).toHaveLength(300);
  expect(f.memory.get(account, projectId)?.feed.entries[99]!.entry.retention.favorite).toBe(true);
  f.controller.interact(true); await f.controller.demand(cursor(300)); expect(f.posts()).toHaveLength(1);
});

it.each(["load", "observer", "synthetic", "idle", "hidden", "view", "foreignCursor", "wrongPosition", "owner"] as const)("cannot authorize prefetch from %s", async action => {
  const f = fixture(); await f.controller.load();
  if (action !== "load" && action !== "synthetic") f.controller.interact(true);
  if (action === "synthetic") f.controller.interact(false);
  if (action === "idle") await vi.advanceTimersByTimeAsync(60_001);
  if (action === "hidden") f.visible(false);
  if (action === "view") f.eligible(false);
  if (action === "owner") f.memory.bind({ userId: id(99), generation: 2 });
  await f.controller.demand(action === "observer" ? undefined : action === "foreignCursor" ? { entryId: id(9999), position: 200 } : action === "wrongPosition" ? { ...cursor(200), position: 201 } : cursor(200));
  expect(f.posts()).toHaveLength(0);
});

it.each(["queued", "running", "cancel_requested", "cancelled", "needs_reconciliation", "failed", "partial"] as const)("cannot carry a %s gesture into a later completed prefetch head", async state => {
  const f = fixture({ ...feed(), activeRun: run(state) }); await f.controller.load(); f.controller.interact(true);
  f.setFeed(feed()); await f.controller.load(); await f.controller.demand(cursor(200)); expect(f.posts()).toHaveLength(0);
  f.controller.interact(true); await f.controller.demand(cursor(200)); expect(f.posts()).toHaveLength(1);
});

it("loads saved older pages before admitting a refill and consumes each read gesture", async () => {
  const first = { ...feed(entries(1, 100)), nextCursor: cursor(100) }, f = fixture(first, entries(1, 100));
  await f.controller.load(); f.setFeed({ ...feed(entries(101, 100)), nextCursor: cursor(200) });
  f.controller.interact(true); await f.controller.demand(cursor(90)); expect(f.requests.at(-1)!.path).toContain("cursorPosition=100");
  await f.controller.demand(cursor(90)); expect(f.posts()).toHaveLength(0);
  f.setFeed(feed(entries(201, 100))); f.controller.interact(true); await f.controller.demand(cursor(190));
  expect(f.memory.get(account, projectId)?.feed.entries).toHaveLength(300); expect(f.posts()).toHaveLength(0);
  f.controller.interact(true); await f.controller.demand(cursor(200)); expect(f.posts()).toHaveLength(1);
});

it("keeps explicit Stop stronger than a subsequently available prefetch capability", async () => {
  const f = fixture(); await f.controller.load(); await f.controller.stop(); f.setFeed(feed()); await f.controller.load();
  f.controller.interact(true); await f.controller.demand(cursor(300)); expect(f.posts()).toHaveLength(0);
});

function running(rows = entries(201, 100), count = 0): NamingFeed {
  const value = { ...feed(rows), activeRun: run("running"), progressive: { version: 1 as const, targetCount: 100 as const, publishedCount: count } };
  delete value.canPrefetchOnScroll; return value;
}

it("allows saved-page reads during progressive work without admitting or replacing its pending intent", async () => {
  const f = fixture({ ...running(entries(1, 100)), nextCursor: cursor(100) }, entries(1, 100)); await f.controller.load();
  const pending = { version: 1 as const, reason: "scroll" as const, expectedProjectRevision: 1, expectedPreferencesVersion: 1, expectedSteeringRevision: 0,
    expectedDemandSequence: 2, consumedThrough: cursor(90), idempotencyKey: id(999) };
  f.memory.setFeed(account, projectId, value => ({ ...value, pending, acknowledged: false }));
  f.setFeed({ ...running(entries(101, 100)), nextCursor: cursor(200) });
  f.controller.interact(true); await f.controller.demand(cursor(90));
  expect(f.requests.at(-1)!.path).toContain("cursorPosition=100"); expect(f.memory.get(account, projectId)?.feed.entries).toHaveLength(200);
  expect(f.memory.get(account, projectId)?.feed.pending).toEqual(pending); expect(f.posts()).toHaveLength(0);
});

it("merges successive saved microbatches while the run is still active, without replaying or admitting work", async () => {
  const f = fixture(running()); await f.controller.load();
  f.setFeed(running(entries(301, 4), 4)); await f.controller.poll();
  expect(f.requests.at(-1)!.path).toContain("cursorPosition=300");
  expect(f.memory.get(account, projectId)?.feed.entries).toHaveLength(304);
  expect(f.memory.get(account, projectId)?.feed.feed?.activeRun?.state).toBe("running");
  expect(f.memory.get(account, projectId)?.feed.status).toBe("pending");
  f.setFeed(running(entries(305, 6), 10)); await f.controller.poll();
  expect(f.requests.at(-1)!.path).toContain("cursorPosition=304");
  expect(f.memory.get(account, projectId)?.feed.entries).toHaveLength(310);
  expect(f.memory.get(account, projectId)?.feed.feed?.progressive?.publishedCount).toBe(10);
  expect(f.memory.get(account, projectId)?.feed.entries[99]!.entry.retention.favorite).toBe(true);
  expect(f.posts()).toHaveLength(0);
});

it("advances the acknowledged cursor past an existing duplicate display identity and retains it through empty polls", async () => {
  const f = fixture(running()); await f.controller.load();
  const duplicate = entry(301), previous = entry(299).entry.candidate;
  const origin = duplicate.entry.candidate.origin;
  if (origin.kind !== "local_import") throw new Error("Synthetic imported source missing");
  duplicate.entry.candidate = { ...duplicate.entry.candidate, value: previous.value, identityKey: previous.identityKey,
    origin: { ...origin, source: { ...origin.source, value: previous.value } } };
  f.setFeed(running([duplicate], 1)); await f.controller.poll();
  expect(f.memory.get(account, projectId)?.feed.entries).toHaveLength(300);
  f.setFeed(running([], 1)); await f.controller.poll(); await f.controller.poll();
  expect(f.requests.slice(-2).every(request => request.path.includes("cursorPosition=301"))).toBe(true);
  expect(f.posts()).toHaveLength(0);
});

it("shows new saved rows before refreshing a changed Saved-only retention on an older page", async () => {
  const f = fixture(running()); await f.controller.load(); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.respond(async path => {
    const position = Number(new URL(path, "https://synthetic.test").searchParams.get("cursorPosition") ?? 0);
    if (!position) await held;
    const rows = position === 300 ? entries(301, 4) : entries(position + 1, 100);
    if (!position) rows[99] = { ...entry(100), entry: { ...entry(100).entry, retention: { ...entry(100).entry.retention, revision: 2, saved: true, updatedAt: when } } };
    return { feed: { ...running(rows, 4), retentionRevision: 2, nextCursor: position < 300 ? cursor(position + 100) : null } };
  });
  const refresh = f.controller.poll();
  for (let turn = 0; turn < 30 && f.memory.get(account, projectId)?.feed.entries.length !== 304; turn++) await Promise.resolve();
  expect(f.memory.get(account, projectId)?.feed.entries).toHaveLength(304);
  expect(f.memory.get(account, projectId)?.feed.entries[99]!.entry.retention.saved).toBe(false);
  release(); await refresh;
  expect(f.memory.get(account, projectId)?.feed.entries[99]!.entry.retention).toMatchObject({ revision: 2, favorite: true, saved: true });
  expect(f.posts()).toHaveLength(0);
});

it("retries an older-page retention refresh after failure instead of accepting only the new head version", async () => {
  const f = fixture(running()); await f.controller.load();
  f.respond(async path => {
    if (!path.includes("cursorPosition=")) throw new Error("Synthetic retained-page read failed");
    return { feed: { ...running(entries(301, 4), 4), retentionRevision: 2 } };
  });
  expect(await f.controller.poll()).toBe(false);
  expect(f.memory.get(account, projectId)?.feed.entries).toHaveLength(304);
  expect(f.memory.get(account, projectId)?.feed.entries[99]!.entry.retention.saved).toBe(false);
  let fullReads = 0;
  f.respond(async path => {
    const position = Number(new URL(path, "https://synthetic.test").searchParams.get("cursorPosition") ?? 0);
    if (!position) fullReads++;
    const rows = position === 304 ? [] : position === 300 ? entries(301, 4) : entries(position + 1, 100);
    if (!position) rows[99] = { ...entry(100), entry: { ...entry(100).entry, retention: { ...entry(100).entry.retention, revision: 2, saved: true, updatedAt: when } } };
    return { feed: { ...running(rows, 4), retentionRevision: 2, nextCursor: position < 300 ? cursor(position + 100) : null } };
  });
  expect(await f.controller.poll()).toBe(true); expect(fullReads).toBe(1);
  expect(f.memory.get(account, projectId)?.feed.entries[99]!.entry.retention).toMatchObject({ revision: 2, favorite: true, saved: true });
  expect(f.posts()).toHaveLength(0);
});

it("retains the same acknowledged demand while progressive publication is still running", async () => {
  const f = fixture(running()); await f.controller.load();
  const pending = { version: 1 as const, reason: "scroll" as const, expectedProjectRevision: 1, expectedPreferencesVersion: 1, expectedSteeringRevision: 0,
    expectedDemandSequence: 2, consumedThrough: cursor(200), idempotencyKey: id(999) };
  f.memory.setFeed(account, projectId, value => ({ ...value, pending, acknowledged: true, acknowledgedRunId: id(10) }));
  f.setFeed(running(entries(301, 4), 4)); await f.controller.poll();
  expect(f.memory.get(account, projectId)?.feed.pending).toEqual(pending);
  expect(f.memory.get(account, projectId)?.feed.entries).toHaveLength(304); expect(f.posts()).toHaveLength(0);
});

it.each(["needs_reconciliation", "failed"] as const)("keeps100 saved names readable without refilling when issued work is %s", async state => {
  const initial = feed(entries(1, 100)); delete initial.canPrefetchOnScroll;
  initial.consumedThrough = cursor(100);
  initial.progressive = { version: 1, targetCount: 100, publishedCount: 100 };
  initial.activeRun = { ...run(state), localPipelineVersion: 2, progress: 100, preparedSetId: null, canResume: false,
    fulfillment: { status: "complete", targetCount: 100, acceptedCount: 100, missingCount: 0, coverageSatisfied: true, message: null } };
  const f = fixture(initial, []);
  f.respond(async path => ({ feed: path.includes("cursorEntryId=") ? { ...initial, entries: [] } : initial }));
  await f.controller.load();
  f.controller.interact(true);
  expect(await f.controller.demand(cursor(90))).toBe(false);
  await f.controller.poll();
  expect(f.memory.get(account, projectId)?.feed.entries).toHaveLength(100);
  expect(f.memory.get(account, projectId)?.feed.status).toBe("incomplete");
  expect(f.posts()).toHaveLength(0);
});

it("requires an explicit Resume for terminal100 without a final completion witness", async () => {
  const initial = feed(entries(1, 100)); delete initial.canPrefetchOnScroll;
  initial.consumedThrough = cursor(100);
  initial.progressive = { version: 1, targetCount: 100, publishedCount: 100 };
  initial.activeRun = { ...run("failed"), localPipelineVersion: 2, progress: 100, preparedSetId: null, canResume: true,
    fulfillment: { status: "complete", targetCount: 100, acceptedCount: 100, missingCount: 0, coverageSatisfied: true, message: null } };
  const f = fixture(initial, []);
  f.respond(async (path, options) => {
    if (options.method !== "POST") return { feed: path.includes("cursorEntryId=") ? { ...initial, entries: [] } : initial };
    const intent = ensureNamingRunIntentSchema.parse(options.body);
    const next = { ...run("queued"), localPipelineVersion: 2 as const, runId: id(20), progress: 0, resumedFromRunId: id(10), demandSequence: 3 };
    return { status: "pending", feed: { ...initial, demandSequence: 3, consumedThrough: intent.consumedThrough, activeRun: next,
      progressive: { version: 1, targetCount: 100, publishedCount: 0 } }, run: next, reused: false };
  });
  await f.controller.load(); await f.controller.poll();
  f.controller.interact(true); expect(await f.controller.demand(cursor(90))).toBe(false);
  expect(f.posts()).toHaveLength(0);
  expect(await f.controller.resume()).toBe(true);
  expect(f.posts()).toHaveLength(1);
  expect(f.posts()[0]!.body).toMatchObject({ reason: "resume", resumeOfRunId: id(10), expectedRunRevision: 7, consumedThrough: cursor(100) });
  expect(f.memory.get(account, projectId)?.feed.entries).toHaveLength(100);
});

it.each(["historical", "progressive"] as const)("continues the same finalized %s100 after Stop, then prefetches once from the resumed head", async profile => {
  const initial = feed(entries(1, 100)); delete initial.canPrefetchOnScroll;
  initial.consumedThrough = cursor(100); initial.paused = true; initial.state = "paused"; initial.demandSequence = 3;
  initial.availability = { status: "unavailable", code: "naming_runtime_unavailable" };
  initial.activeRun = { ...run(), canResume: true, canResumeSaved: true };
  if (profile === "progressive") {
    initial.progressive = { version: 1, targetCount: 100, publishedCount: 100 };
    initial.activeRun = { ...initial.activeRun, localPipelineVersion: 2, progressiveCompletionId: id(40), preparedSetId: null };
  }
  const f = fixture(initial, []);
  let latest = initial;
  f.respond(async (path, options) => {
    if (options.method !== "POST") return { feed: path.includes("cursorEntryId=") ? { ...latest, entries: [] } : latest };
    const intent = ensureNamingRunIntentSchema.parse(options.body);
    if (intent.reason === "resume") {
      latest = { ...initial, paused: false, state: "active", demandSequence: 4 };
      return { status: "appended", runId: id(10), appendedEntryIds: [], feed: latest };
    }
    const next = { ...run("queued"), localPipelineVersion: 2 as const, runId: id(20), demandSequence: 4, progress: 0 };
    latest = { ...latest, activeRun: next, progressive: { version: 1, targetCount: 100, publishedCount: 0 }, consumedThrough: intent.consumedThrough };
    delete latest.canPrefetchOnScroll;
    return { status: "pending", feed: latest, run: next, reused: false };
  });
  await f.controller.load();
  expect(await f.controller.start()).toBe(true);
  expect(f.posts()).toHaveLength(1);
  expect(f.posts()[0]!.body).toMatchObject({ reason: "resume", resumeOfRunId: id(10), expectedRunRevision: 7, consumedThrough: cursor(100) });
  const restored = f.memory.get(account, projectId)?.feed;
  expect(restored?.entries.map(row => row.entryId)).toEqual(initial.entries.map(row => row.entryId));
  expect(restored?.feed?.activeRun?.runId).toBe(id(10)); expect(restored?.feed?.activeRun?.demandSequence).toBe(2);
  if (profile === "progressive") expect(restored?.feed?.activeRun?.progressiveCompletionId).toBe(id(40));
  expect(restored?.status).toBe("ready"); expect(restored?.pending).toBeNull(); expect(restored?.stopRequested).toBe(false);
  latest = { ...latest, availability: feed().availability, canPrefetchOnScroll: true };
  await f.controller.poll(); expect(f.posts()).toHaveLength(1);
  f.controller.interact(true); await Promise.all([f.controller.demand(cursor(90)), f.controller.demand(cursor(90))]);
  expect(f.posts()).toHaveLength(2);
  expect(f.posts()[1]!.body).toMatchObject({ reason: "scroll", expectedDemandSequence: 4, consumedThrough: cursor(90) });
});

it.each(["historical", "progressive"] as const)("refuses a supplied prefetch capability without genuine %s completion membership", async profile => {
  const initial = feed(); initial.activeRun = { ...run(), preparedSetId: null, ...(profile === "progressive" ? { localPipelineVersion: 2 } : {}) };
  const f = fixture(initial); await f.controller.load();
  f.controller.interact(true); await f.controller.demand(cursor(200));
  expect(f.posts()).toHaveLength(0);
});

it("invalidates an earlier gesture when another session advances the completed head", async () => {
  const f = fixture(); await f.controller.load(); f.controller.interact(true);
  f.setFeed({ ...feed(), demandSequence: 3 }); await f.controller.load();
  await f.controller.demand(cursor(200)); expect(f.posts()).toHaveLength(0);
  f.controller.interact(true); await f.controller.demand(cursor(200));
  expect(f.posts()).toHaveLength(1); expect(f.posts()[0]!.body).toMatchObject({ reason: "scroll", expectedDemandSequence: 3 });
});

it.each(["native", "missingRetentionVersion"] as const)("retains full refresh for %s instead of hiding older-page edits", async mode => {
  const initial = running();
  if (mode === "native") delete initial.progressive;
  else delete initial.retentionRevision;
  const f = fixture(initial); await f.controller.load(); f.requests.length = 0; await f.controller.poll();
  expect(f.requests[0]!.path).not.toContain("cursorPosition"); expect(f.posts()).toHaveLength(0);
});

it("rejects a stale retention revision without erasing acknowledged saved state", async () => {
  const f = fixture(running()); await f.controller.load();
  f.setFeed({ ...running(entries(301, 4), 4), retentionRevision: 0 });
  expect(await f.controller.poll()).toBe(false); expect(f.memory.get(account, projectId)?.feed.entries).toHaveLength(300);
  expect(f.memory.get(account, projectId)?.feed.entries[99]!.entry.retention.favorite).toBe(true);
});
