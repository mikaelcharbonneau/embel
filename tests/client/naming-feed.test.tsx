import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNamingFeedController, mergeNamingFeedEntries } from "@/components/naming/naming-feed-controller";
import { AccountRequestError } from "@/components/workspace/account-api";
import { createNamingBrainMemory } from "@/components/naming/naming-brain-memory";
import { type NamingFeed, type NamingFeedEntry, type NamingBrainRunSummary } from "@/domain/naming-brain";
import { contextSnapshotSchema } from "@/domain/projects";
import { nameIdentityKey, namingStrategyBasis, namingStrategyKey } from "@/domain/project-naming";
const id = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const account = { userId: id(1), generation: 1 }, projectId = id(2), when = "2026-10-16T12:00:00Z";
const context = contextSnapshotSchema.parse({ description: "Synthetic Naming feed" });
function entry(n: number, value = `Synthetic ${n}`): NamingFeedEntry { return { entryId: id(n + 1000), position: n, runId: null, steeringRevision: 0, primaryApproach: null, additionalApproaches: [], publishedClaims: [], entry: { candidate: { id: id(n + 100), ownerId: account.userId, projectId, value, identityKey: nameIdentityKey(value), rationale: "Synthetic user-authored test name", contextRevision: 1, strategyBasis: namingStrategyBasis(context), strategyKey: namingStrategyKey(context), createdAt: when, origin: { kind: "local_import", ownerId: account.userId, projectId, candidateId: id(n + 100), contextRevision: 1, source: { id: id(n + 500), value, createdAt: when, origin: "manual", history: [] }, capturedContext: context } }, retention: { ownerId: account.userId, projectId, candidateId: id(n + 100), revision: 0, favorite: false, saved: false, updatedAt: null } } }; }
function feed(entries: NamingFeedEntry[] = []): NamingFeed { return { version: 1, ownerId: account.userId, projectId, projectRevision: 1, preferencesVersion: 1, feedbackRevision: 0, steeringRevision: 0, demandSequence: 0, entries, nextCursor: null, consumedThrough: null, activeRun: null, preparedSetId: null, paused: false, state: "active", availability: { status: "available", handlerVersion: "naming-brain-v1", protocol: "openai_agents", acceptedPolicyIdentity: "a".repeat(64) } }; }
function run(state: NamingBrainRunSummary["state"] = "running"): NamingBrainRunSummary { return { version: 1, ownerId: account.userId, projectId, runId: id(10), jobId: id(11), batchId: id(12), revision: 1, resumedFromRunId: null, canResume: false, state, projectRevision: 1, preferencesVersion: 1, feedbackRevision: 0, steeringRevision: 0, demandSequence: 0, snapshotHash: "b".repeat(64), acceptedPolicyIdentity: "a".repeat(64), progress: 20, preparedSetId: null, fulfillment: null, accounting: { status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null }, createdAt: when, updatedAt: when }; }
function fixture(initial = feed()) {
  let latest = initial, visible = true, eligible = true;
  const memory = createNamingBrainMemory({ storage: () => null }); memory.bind(account);
  const requests: { path: string; body: unknown; method: string }[] = [];
  let respond: (path: string, options: { method?: string; body?: unknown }) => Promise<unknown> = async (path, options) => {
    if (path.endsWith("/feed/stop")) { latest = { ...latest, paused: true, state: "paused", demandSequence: latest.demandSequence + 1 }; return { feed: latest }; }
    if (options.method === "POST") { const activeRun = { ...run(), demandSequence: latest.demandSequence }; latest = { ...latest, activeRun }; return { status: "pending", feed: latest, run: activeRun, reused: false }; }
    return { feed: latest };
  };
  const request = vi.fn(async (path: string, _schema: unknown, options: { method?: string; body?: unknown }) => { requests.push({ path, body: options.body, method: options.method ?? "GET" }); return respond(path, options); });
  const controller = createNamingFeedController({ account, projectId, memory, request: request as never, eligible: () => eligible, visible: () => visible });
  return { memory, controller, request, requests, setFeed: (value: NamingFeed) => { latest = value; }, respond: (value: typeof respond) => { respond = value; }, visible: (value: boolean) => { visible = value; }, eligible: (value: boolean) => { eligible = value; } };
}
beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
it("mount/restored position and repeated observer callbacks cannot admit work", async () => {
  const f = fixture(); await f.controller.load(); await f.controller.demand();
  expect(f.requests.filter(value => value.method === "POST")).toHaveLength(0);
  await Promise.all([f.controller.start(), f.controller.start()]);
  expect(f.requests.filter(value => value.method === "POST")).toHaveLength(1);
  await Promise.all([f.controller.demand(), f.controller.demand()]);
  expect(f.requests.filter(value => value.method === "POST")).toHaveLength(1);
});
it("loads saved pages before new work, and list growth requires fresh interaction", async () => {
  const first = feed([entry(1)]); first.demandSequence = 1; first.nextCursor = { entryId: id(1001), position: 1 };
  const f = fixture(first); await f.controller.load(); await f.controller.start();
  f.setFeed({ ...feed([entry(2)]), demandSequence: 1 }); f.controller.interact(); await f.controller.demand();
  expect(f.requests.at(-1)!.path).toContain("cursorPosition=1"); expect(f.memory.get(account, projectId)?.feed.entries).toHaveLength(2);
  await f.controller.demand(); expect(f.requests.filter(value => value.method === "POST")).toHaveLength(0);
  f.controller.interact(); await f.controller.demand(); expect(f.requests.filter(value => value.method === "POST")).toHaveLength(1);
});
it("restored exploration resumes only after fresh user interaction", async () => {
  const f = fixture({ ...feed([entry(1)]), demandSequence: 1 }); await f.controller.load();
  await f.controller.demand(); expect(f.requests.filter(value => value.method === "POST")).toHaveLength(0);
  f.controller.interact(); await f.controller.demand(); expect(f.requests.filter(value => value.method === "POST")).toHaveLength(1);
});
it("hidden, idle, stopped and non-exploration views never admit scroll demand", async () => {
  const f = fixture({ ...feed([entry(1)]), demandSequence: 1 }); await f.controller.load(); await f.controller.start();
  f.visible(false); f.controller.interact(); await f.controller.demand(); f.visible(true);
  f.eligible(false); f.controller.interact(); await f.controller.demand(); f.eligible(true);
  f.controller.interact(); await vi.advanceTimersByTimeAsync(60_001); await f.controller.demand();
  await f.controller.stop(); f.controller.interact(); await f.controller.demand();
  expect(f.requests.filter(value => value.path.endsWith("/feed/ensure"))).toHaveLength(0);
});
it("an uncertain admission retries the original body after remount", async () => {
  const f = fixture(); f.respond(async (_path, options) => { if (options.method === "POST") throw new Error("Lost acknowledgement"); return { feed: feed() }; });
  await f.controller.load(); await f.controller.start(); const first = f.requests.find(value => value.method === "POST")!.body;
  f.controller.dispose(); const again = createNamingFeedController({ account, projectId, memory: f.memory, eligible: () => true, request: (async (_path: string, _schema: unknown, options: { body?: unknown }) => { expect(options.body).toEqual(first); return { status: "pending", feed: { ...feed(), demandSequence: 0, activeRun: run() }, run: run(), reused: true }; }) as never });
  await again.retry(); expect(f.memory.get(account, projectId)?.feed.acknowledged).toBe(true);
});
it("a saved matching run resolves a lost admission acknowledgement without a second admission", async () => {
  const f = fixture(); let accepted = false;
  f.respond(async (_path, options) => {
    if (options.method === "POST") { accepted = true; throw new Error("Lost acknowledgement"); }
    return { feed: accepted ? { ...feed(), demandSequence: 0, activeRun: run() } : feed() };
  });
  await f.controller.load(); await f.controller.start(); expect(f.memory.get(account, projectId)?.feed.acknowledged).toBe(false);
  await f.controller.load(); expect(f.memory.get(account, projectId)?.feed.acknowledged).toBe(true);
  expect(f.requests.filter(value => value.method === "POST")).toHaveLength(1);
});
it("late old-direction and old-owner replies cannot enter the visible feed", async () => {
  const f = fixture({ ...feed([entry(1)]), demandSequence: 1 }); await f.controller.load(); await f.controller.start();
  let finish!: (value: unknown) => void;
  f.respond(async path => path.endsWith("/steering") ? { feed: { ...feed([entry(1)]), steeringRevision: 1, demandSequence: 1 }, supersededRunIds: [], cancellationRequestedRunIds: [] } as never : new Promise(resolve => { finish = resolve; }));
  f.controller.interact(); const pending = f.controller.demand(); await f.controller.steer([entry(1).entry.candidate.id], null);
  finish({ status: "pending", feed: { ...feed([entry(1), entry(2)]), demandSequence: 1, activeRun: run() }, run: run(), reused: false }); await pending;
  expect(f.memory.get(account, projectId)?.feed.entries.map(row => row.position)).toEqual([1]);
  f.memory.bind({ userId: id(99), generation: 2 }); expect(f.memory.get(account, projectId)).toBeNull();
});
it("counts distinct names independently of 30 synthetic display records and preserves accents", () => {
  const rows = Array.from({ length: 30 }, (_, index) => entry(index + 1, index === 28 ? "SYNTHETIC-1" : index === 29 ? "Synthetic 2" : `Synthetic ${index + 1}`));
  expect(mergeNamingFeedEntries([], rows)).toHaveLength(28);
  expect(mergeNamingFeedEntries([], [entry(1, "Cafe"), entry(2, "Café")])).toHaveLength(2);
  expect(() => mergeNamingFeedEntries([entry(1)], [{ ...entry(2), position: 1 }])).toThrow();
});
it("preserves visible names when selection advances project revision and uses the refreshed head", async () => {
  const f = fixture({ ...feed([entry(1)]), demandSequence: 1 }); await f.controller.load(); await f.controller.start();
  f.setFeed({ ...feed([entry(1)]), projectRevision: 2, demandSequence: 1 }); await f.controller.load();
  f.controller.interact(); await f.controller.demand();
  expect(f.requests.find(value => value.method === "POST")!.body).toMatchObject({ expectedProjectRevision: 2, expectedDemandSequence: 1, consumedThrough: { entryId: id(1001), position: 1 } });
  expect(f.memory.get(account, projectId)?.feed.entries[0]?.entry.candidate.value).toBe("Synthetic 1");
});
it("terminal partial work never restarts from scrolling; explicit Resume links a new run", async () => {
  const partial = { ...run("partial"), canResume: true, fulfillment: { status: "partial" as const, targetCount: 100 as const, acceptedCount: 20, missingCount: 80, coverageSatisfied: false, message: "A synthetic partial set was retained." } };
  const f = fixture(); const bodies: unknown[] = [];
  f.respond(async (_path, options) => {
    if (options.method !== "POST") return { feed: feed() };
    bodies.push(options.body);
    if (bodies.length === 1) return { status: "incomplete", feed: { ...feed(), demandSequence: 0, activeRun: partial }, run: partial, fulfillment: partial.fulfillment, message: "A synthetic partial set was retained.", canResume: true };
    const resumed = { ...run(), runId: id(20), resumedFromRunId: partial.runId, demandSequence: 1 };
    return { status: "pending", feed: { ...feed(), demandSequence: 1, activeRun: resumed }, run: resumed, reused: false };
  });
  await f.controller.load(); await f.controller.start(); f.controller.interact(); await f.controller.demand(); expect(bodies).toHaveLength(1);
  await f.controller.resume(); expect(bodies).toHaveLength(2); expect(bodies[1]).toMatchObject({ reason: "resume", resumeOfRunId: partial.runId, expectedRunRevision: 1, expectedDemandSequence: 0 });
});
it("uses GET's server-qualified Resume witness after reload without an admission probe", async () => {
  const previous = { ...run("cancelled"), canResume: false }, initial = { ...feed(), activeRun: previous }, f = fixture(initial);
  await f.controller.load(); expect(await f.controller.resume()).toBe(false); expect(f.requests.every(value => value.method === "GET")).toBe(true);
  const qualified = { ...previous, revision: 2, canResume: true }; f.setFeed({ ...initial, activeRun: qualified }); await f.controller.load();
  f.respond(async (_path, options) => {
    expect(options.body).toMatchObject({ reason: "resume", resumeOfRunId: previous.runId, expectedRunRevision: 2, expectedDemandSequence: 0 });
    const resumed = { ...run(), runId: id(30), resumedFromRunId: previous.runId, demandSequence: 1 };
    return { status: "pending", feed: { ...feed(), demandSequence: 1, activeRun: resumed }, run: resumed, reused: false };
  });
  expect(await f.controller.resume()).toBe(true); expect(f.requests.filter(value => value.method === "POST")).toHaveLength(1);
});
it("durable Stop fences a late admission before its run identity is acknowledged", async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.respond(async (path, options) => {
    if (path.endsWith("/feed/stop")) return { feed: { ...feed(), paused: true, state: "paused", demandSequence: 1 } };
    if (options.method === "POST") return new Promise(resolve => { finish = resolve; });
    return { feed: feed() };
  });
  await f.controller.load(); const initial = f.controller.start();
  for (let turn = 0; turn < 20 && !f.memory.get(account, projectId)?.feed.pending; turn++) await Promise.resolve();
  expect(f.memory.get(account, projectId)?.feed.pending).not.toBeNull();
  await f.controller.stop(); finish({ status: "pending", feed: { ...feed(), demandSequence: 1, activeRun: run() }, run: run(), reused: false }); await initial;
  expect(f.requests.find(value => value.path.endsWith("/feed/stop"))?.body).toMatchObject({ version: 1, expectedDemandSequence: 0, pendingEnsureIdempotencyKey: expect.any(String), idempotencyKey: expect.any(String) });
  expect(f.memory.get(account, projectId)?.feed.feed).toMatchObject({ state: "paused", demandSequence: 1, activeRun: null });
  f.controller.interact(); await f.controller.demand(); expect(f.requests.filter(value => value.path.endsWith("/feed/ensure"))).toHaveLength(1);
});
it("two mounted consumers share one admission and do not lock feedback for the durable run", async () => {
  const f = fixture(feed([entry(1)])); await f.controller.load();
  const other = createNamingFeedController({ account, projectId, memory: f.memory, request: f.request as never, eligible: () => true });
  await Promise.all([f.controller.start(), other.start()]);
  expect(f.requests.filter(value => value.method === "POST")).toHaveLength(1);
  f.memory.applyRetention(account, projectId, { ...entry(1).entry, retention: { ...entry(1).entry.retention, revision: 1, favorite: true, updatedAt: when } });
  expect(f.memory.get(account, projectId)?.feed.entries[0]?.entry.retention.favorite).toBe(true);
  expect(f.memory.get(account, projectId)?.feed.feed?.activeRun).toMatchObject({ state: "running", feedbackRevision: 0 });
});
it("rejects foreign or oversized strong steering before any request", async () => {
  const f = fixture(feed(Array.from({ length: 6 }, (_, i) => entry(i + 1)))); await f.controller.load();
  expect(await f.controller.steer([id(9999)], null)).toBe(false);
  expect(await f.controller.steer(Array.from({ length: 6 }, (_, i) => entry(i + 1).entry.candidate.id), null)).toBe(false);
  expect(f.requests.filter(value => value.method === "POST")).toHaveLength(0);
});
it("retains two saved pages and current retention through a long-history refresh", async () => {
  const first = Array.from({ length: 100 }, (_, i) => entry(i + 1)), second = Array.from({ length: 100 }, (_, i) => entry(i + 101));
  const f = fixture();
  f.respond(async path => ({ feed: path.includes("cursorPosition=100") ? { ...feed(second), demandSequence: 2 } : { ...feed(first), demandSequence: 2, nextCursor: { entryId: id(1100), position: 100 } } }));
  await f.controller.load(); f.controller.interact(); await f.controller.demand();
  expect(f.memory.get(account, projectId)?.feed.entries).toHaveLength(200);
  f.memory.applyRetention(account, projectId, { ...second[99]!.entry, retention: { ...second[99]!.entry.retention, revision: 1, favorite: true, updatedAt: when } });
  await f.controller.load();
  expect(f.memory.get(account, projectId)?.feed.entries).toHaveLength(200);
  expect(f.memory.get(account, projectId)?.feed.entries[199]?.entry.retention.favorite).toBe(true);
  expect(f.requests.every(value => value.method === "GET")).toBe(true);
});
it("an older read cannot erase an acknowledged run when ordinary demand keeps the sequence stable", async () => {
  const initial = { ...feed([entry(1)]), demandSequence: 1 }, f = fixture(initial); await f.controller.load();
  let finish!: (value: unknown) => void;
  const active = { ...run(), demandSequence: 1 };
  f.respond(async (_path, options) => options.method === "POST" ? { status: "pending", feed: { ...initial, activeRun: active }, run: active, reused: false } : new Promise(resolve => { finish = resolve; }));
  const oldRead = f.controller.load(); f.controller.interact(); await f.controller.demand();
  finish({ feed: initial }); await oldRead;
  expect(f.memory.get(account, projectId)?.feed.feed?.activeRun?.runId).toBe(active.runId);
  expect(f.requests.filter(value => value.method === "POST")).toHaveLength(1);
});
it("a late admission receipt cannot roll back a newer saved run revision", async () => {
  const f = fixture(); let finish!: (value: unknown) => void, published = false;
  f.respond(async (_path, options) => {
    if (options.method === "POST") { published = true; return new Promise(resolve => { finish = resolve; }); }
    return { feed: published ? { ...feed(), activeRun: { ...run(), revision: 2, progress: 45 } } : feed() };
  });
  await f.controller.load(); const admission = f.controller.start();
  for (let turn = 0; turn < 20 && !published; turn++) await Promise.resolve();
  await f.controller.load(); finish({ status: "pending", feed: { ...feed(), activeRun: run() }, run: run(), reused: false }); await admission;
  expect(f.memory.get(account, projectId)?.feed.feed?.activeRun).toMatchObject({ revision: 2, progress: 45 });
});
it("retries an uncertain Stop with the exact sequence and pending ensure key across remount", async () => {
  const f = fixture(), bodies: unknown[] = []; await f.controller.load();
  f.respond(async (path, options) => {
    if (path.endsWith("/feed/stop")) { bodies.push(options.body); if (bodies.length === 1) throw new Error("Lost Stop acknowledgement"); return { feed: { ...feed(), paused: true, state: "paused", demandSequence: 1 } }; }
    return { feed: feed() };
  });
  await f.controller.stop(); const original = f.memory.get(account, projectId)?.feed.stop;
  expect(original).toMatchObject({ version: 1, expectedDemandSequence: 0, pendingEnsureIdempotencyKey: null });
  f.controller.dispose(); const again = createNamingFeedController({ account, projectId, memory: f.memory, request: f.request as never, eligible: () => true });
  await again.retry(); expect(bodies).toEqual([original, original]); expect(f.memory.get(account, projectId)?.feed.stop).toBeNull();
});
it("does not rebase a rejected Stop until an explicit new action follows a saved-state read", async () => {
  const f = fixture(), bodies: { expectedDemandSequence: number; idempotencyKey: string }[] = []; await f.controller.load();
  f.respond(async (path, options) => {
    if (path.endsWith("/feed/stop")) { const body = options.body as typeof bodies[number]; bodies.push(body); if (body.expectedDemandSequence === 0) throw new AccountRequestError(409); return { feed: { ...feed(), paused: true, state: "paused", demandSequence: 3 } }; }
    return { feed: { ...feed(), demandSequence: 2 } };
  });
  await f.controller.stop(); await f.controller.retry(); expect(bodies[1]).toEqual(bodies[0]);
  expect(await f.controller.stopCurrent()).toBe(false); expect(bodies).toHaveLength(2);
  await f.controller.load(); expect(await f.controller.stopCurrent()).toBe(true);
  expect(bodies[2]?.expectedDemandSequence).toBe(2); expect(bodies[2]?.idempotencyKey).not.toBe(bodies[0]?.idempotencyKey);
});
it("a paused no-run head requires explicit initial Continue; scroll cannot unpause it", async () => {
  const f = fixture({ ...feed(), paused: true, state: "paused", demandSequence: 1 }); await f.controller.load(); f.controller.interact(); await f.controller.demand();
  expect(f.requests.filter(value => value.method === "POST")).toHaveLength(0);
  f.respond(async (_path, options) => {
    if (options.method !== "POST") return { feed: { ...feed(), paused: true, state: "paused", demandSequence: 1 } };
    expect(options.body).toMatchObject({ reason: "initial", expectedDemandSequence: 1 });
    const activeRun = { ...run(), demandSequence: 1 }; return { status: "pending", feed: { ...feed(), demandSequence: 1, activeRun }, run: activeRun, reused: false };
  });
  expect(await f.controller.start()).toBe(true); expect(f.memory.get(account, projectId)?.feed.feed?.paused).toBe(false);
});
it("qualified complete saved output resumes without requiring a new runtime or a replacement run", async () => {
  const complete = { ...run("succeeded"), canResume: true, preparedSetId: id(50), fulfillment: { status: "complete" as const, targetCount: 100 as const, acceptedCount: 100, missingCount: 0, coverageSatisfied: true, message: null } };
  const initial = { ...feed([entry(1)]), paused: true, state: "paused" as const, demandSequence: 1, activeRun: complete, availability: { status: "unavailable" as const, code: "worker_unavailable" } }, f = fixture(initial);
  await f.controller.load();
  f.respond(async (_path, options) => { expect(options.body).toMatchObject({ reason: "resume", resumeOfRunId: complete.runId, expectedDemandSequence: 1 }); return { status: "appended", feed: { ...initial, paused: false, state: "active" }, runId: complete.runId, appendedEntryIds: [] }; });
  expect(await f.controller.resume()).toBe(true); expect(f.memory.get(account, projectId)?.feed.feed?.activeRun?.runId).toBe(complete.runId);
  expect(f.memory.get(account, projectId)?.feed.entries).toHaveLength(1); expect(f.requests.filter(value => value.method === "POST")).toHaveLength(1);
});
it("a delayed direction save cannot clear an acknowledged pause and retains its exact retry", async () => {
  const f = fixture(feed([entry(1)])); await f.controller.load(); let finish!: (value: unknown) => void;
  const steeringBodies: unknown[] = [];
  const paused = { ...feed([entry(1)]), paused: true, state: "paused" as const, demandSequence: 1 };
  f.respond(async (path, options) => {
    if (path.endsWith("/feed/stop")) return { feed: paused };
    if (path.endsWith("/steering")) { steeringBodies.push(options.body); if (steeringBodies.length === 1) return new Promise(resolve => { finish = resolve; }); return { feed: { ...paused, steeringRevision: 1 }, supersededRunIds: [], cancellationRequestedRunIds: [] }; }
    return { feed: paused };
  });
  const direction = f.controller.steer([entry(1).entry.candidate.id], null); await f.controller.stop();
  finish({ feed: { ...paused, steeringRevision: 1 }, supersededRunIds: [], cancellationRequestedRunIds: [] }); await direction;
  expect(f.memory.get(account, projectId)?.feed.feed?.paused).toBe(true); expect(f.memory.get(account, projectId)?.feed.steering).not.toBeNull();
  await f.controller.retry(); expect(steeringBodies[1]).toEqual(steeringBodies[0]);
  f.controller.interact(); await f.controller.demand(); expect(f.requests.some(value => value.path.endsWith("/feed/ensure"))).toBe(false);
  expect(f.memory.get(account, projectId)?.feed.feed?.paused).toBe(true);
});
it("Stop binds an unacknowledged Resume by its exact key without rebasing its sequence", async () => {
  const original = { ...run("partial"), canResume: true }, f = fixture({ ...feed(), activeRun: original });
  await f.controller.load(); let finish!: (value: unknown) => void;
  const resumed = { ...run(), runId: id(40), demandSequence: 1, resumedFromRunId: original.runId };
  f.respond(async path => {
    if (path.endsWith("/feed/ensure")) return new Promise(resolve => { finish = resolve; });
    if (path.endsWith("/feed/stop")) return { feed: { ...feed(), paused: true, state: "paused", demandSequence: 2, activeRun: { ...resumed, state: "cancel_requested" } } };
    return { feed: { ...feed(), activeRun: original } };
  });
  const resume = f.controller.resume();
  const exact = f.memory.get(account, projectId)?.feed.pending;
  expect(exact?.reason).toBe("resume");
  await f.controller.stop();
  expect(f.requests.find(value => value.path.endsWith("/feed/stop"))?.body).toMatchObject({ expectedDemandSequence: 0, pendingEnsureIdempotencyKey: exact?.idempotencyKey });
  finish({ status: "pending", feed: { ...feed(), demandSequence: 1, activeRun: resumed }, run: resumed, reused: false }); await resume;
  expect(f.memory.get(account, projectId)?.feed.feed).toMatchObject({ paused: true, demandSequence: 2, activeRun: { state: "cancel_requested" } });
  expect(f.requests.filter(value => value.path.endsWith("/feed/ensure"))).toHaveLength(1);
});
