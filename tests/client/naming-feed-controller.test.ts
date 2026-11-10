import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { z } from "zod";
import { AccountRequestError } from "@/components/workspace/account-api";
import { createNamingBrainMemory, type NamingFeedState } from "@/components/naming/naming-brain-memory";
import { createNamingFeedController, mergeNamingFeedEntries, NAMING_ACTIVE_POLL_MS, NAMING_ENGINE_ACTIVE_POLL_MS, NAMING_IDLE_POLL_MS, namingCreditsMessage, namingFailureMessage, namingPollInterval, namingStatus } from "@/components/naming/naming-feed-controller";
import { NAMING_GENERATION_CAUTION, namingRunErrorCodeSchema, type NamingFeedEntry, type NamingGenerationFeed, type NamingRun, type NamingRunState } from "@/domain/naming-generation";
import { nameIdentityKey, namingStrategyBasis, namingStrategyKey } from "@/domain/project-naming";
import { contextSnapshotSchema } from "@/domain/projects";

const id = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const account = { userId: id(1), generation: 1 }, projectId = id(2), runId = id(3), jobId = id(4);
const base = `/api/projects/${projectId}/naming`, context = contextSnapshotSchema.parse({ description: "Synthetic controller fixture" });
const at = (n: number) => new Date(Date.parse("2026-11-08T12:00:00Z") + n * 1000).toISOString();
function entry(n: number, run = runId): NamingFeedEntry {
  const candidateId = id(100 + n), value = `Name ${n}`;
  return { runId: run, primaryApproach: "real_words", entry: {
    candidate: { id: candidateId, ownerId: account.userId, projectId, value, identityKey: nameIdentityKey(value), rationale: "Synthetic.", caution: NAMING_GENERATION_CAUTION, contextRevision: 1,
      strategyBasis: namingStrategyBasis(context), strategyKey: namingStrategyKey(context), createdAt: at(n),
      origin: { kind: "brainstorm", version: 1, profile: "brainstorm_v1", ownerId: account.userId, projectId, candidateId, contextRevision: 1, value, batchId: run, jobId, runId: run, callId: id(5), responseId: "resp_synthetic", requestId: null, model: "synthetic", generatedAt: at(n) } },
    retention: { ownerId: account.userId, projectId, candidateId, revision: 0, favorite: false, saved: false, updatedAt: null } } };
}
const run = (state: NamingRunState, overrides: Partial<NamingRun> = {}): NamingRun => ({ runId, jobId, kind: "initial", state, target: 100, savedCount: 0, errorCode: null, usage: null, createdAt: at(0), finishedAt: null, ...overrides });
const feed = (overrides: Partial<NamingGenerationFeed> = {}): NamingGenerationFeed => ({ version: 2, projectId, availability: { status: "available" }, run: null, entries: [], nextCursor: null, ...overrides });

type Call = { path: string; method: string; body?: unknown; owner?: string };
let calls: Call[], server: NamingGenerationFeed, visible: boolean, reply: (call: Call) => Promise<unknown> | unknown;
let memory: ReturnType<typeof createNamingBrainMemory>, expire: Mock<(account: { userId: string; generation: number }) => void>, keys: number;
/** Serves the feed after a cursor exactly as SQL does: by (createdAt, id), 100 at a time. */
function page(path: string): NamingGenerationFeed {
  const query = new URL(path, "https://fixture.invalid").searchParams, after = query.get("cursorId");
  const start = after ? server.entries.findIndex(row => row.entry.candidate.id === after) + 1 : 0;
  const entries = server.entries.slice(start, start + 100), last = entries.at(-1);
  return { ...server, entries, nextCursor: last && start + 100 < server.entries.length ? { createdAt: last.entry.candidate.createdAt, id: last.entry.candidate.id } : null };
}
function controller(basis: { projectRevision: number; preferencesVersion: number } | null = { projectRevision: 3, preferencesVersion: 2 }) {
  const request = (async (path: string, schema: z.ZodType, options: { method?: string; body?: unknown; expectedOwnerId?: string; signal: AbortSignal }) => {
    const call = { path, method: options.method ?? "GET", body: options.body, owner: options.expectedOwnerId };
    calls.push(call);
    const value = await reply(call);
    return schema.parse(value);
  }) as never;
  const created = createNamingFeedController({ account, projectId, memory, request, expire, visible: () => visible, basis: () => basis, newKey: () => `synthetic-key-${String(++keys).padStart(4, "0")}` });
  created.activate();
  return created;
}
const state = () => memory.get(account, projectId)!.feed;
const reads = () => calls.filter(call => call.method === "GET");
const writes = (suffix: string) => calls.filter(call => call.method === "POST" && call.path.endsWith(suffix));
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers(); calls = []; visible = true; keys = 0; expire = vi.fn();
  memory = createNamingBrainMemory({ storage: () => null }); memory.bind(account);
  server = feed();
  reply = call => {
    if (call.method === "GET") return { feed: page(call.path) };
    if (call.path.endsWith("/feed/stop")) { server = { ...server, run: server.run && { ...server.run, state: "cancel_requested" } }; return { feed: page(base) }; }
    const body = call.body as { kind: "initial" | "more" | "steer" };
    server = { ...server, run: run("queued", { kind: body.kind }) };
    return { feed: page(base), run: server.run, reused: false };
  };
});
afterEach(() => { vi.useRealTimers(); });

describe("polling", () => {
  it("polls every second while a run works, every 15 seconds otherwise, and continues after the newest name", async () => {
    server = feed({ run: run("running", { savedCount: 2 }), entries: [entry(1), entry(2)] });
    const feedController = controller(); const stop = feedController.startPolling(); await settle();
    expect(reads().map(call => call.path)).toEqual([`${base}/feed?limit=100`]);
    expect(namingPollInterval(state())).toBe(NAMING_ACTIVE_POLL_MS);
    server = { ...server, entries: [...server.entries, entry(3)], run: run("running", { savedCount: 3 }) };
    await vi.advanceTimersByTimeAsync(NAMING_ACTIVE_POLL_MS - 1); expect(reads()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(reads()).toHaveLength(2);
    expect(new URL(reads()[1]!.path, "https://fixture.invalid").searchParams.get("cursorId")).toBe(id(102));
    expect(state().entries.map(row => row.entry.candidate.value)).toEqual(["Name 1", "Name 2", "Name 3"]);
    server = { ...server, run: run("succeeded", { savedCount: 3, finishedAt: at(9) }) };
    await vi.advanceTimersByTimeAsync(NAMING_ACTIVE_POLL_MS); expect(reads()).toHaveLength(3);
    expect(namingPollInterval(state())).toBe(NAMING_IDLE_POLL_MS);
    await vi.advanceTimersByTimeAsync(NAMING_IDLE_POLL_MS - 1); expect(reads()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1); expect(reads()).toHaveLength(4);
    stop(); await vi.advanceTimersByTimeAsync(NAMING_IDLE_POLL_MS * 2); expect(reads()).toHaveLength(4);
  });
  it("reads only while the tab is visible and reads at once when it returns", async () => {
    server = feed({ run: run("running") });
    const feedController = controller(); feedController.startPolling(); await settle();
    visible = false; await vi.advanceTimersByTimeAsync(NAMING_ACTIVE_POLL_MS * 5); expect(reads()).toHaveLength(1);
    visible = true; feedController.wake(); await settle(); expect(reads()).toHaveLength(2);
  });
  it("loads every page on the first read", async () => {
    server = feed({ entries: Array.from({ length: 230 }, (_, n) => entry(n + 1)) });
    await controller().load();
    expect(reads()).toHaveLength(3); expect(state().entries).toHaveLength(230); expect(state().status).toBe("ready");
  });
  it("refuses another project's feed and ends the account session view", async () => {
    server = feed({ projectId: id(9) });
    expect(await controller().load()).toBe(false);
    expect(expire).toHaveBeenCalledWith(account); expect(state().error).toBe("Names couldn’t be loaded. Try again.");
  });
});

describe("start, More names, steer and Stop", () => {
  it("starts the first names once with the saved basis and shows progress", async () => {
    const feedController = controller(); await feedController.load();
    const first = feedController.start(), duplicate = feedController.start();
    expect(await duplicate).toBe(false); expect(await first).toBe(true);
    expect(writes("/feed/ensure")).toEqual([{ path: `${base}/feed/ensure`, method: "POST", owner: account.userId,
      body: { version: 2, kind: "initial", expectedProjectRevision: 3, expectedPreferencesVersion: 2, seedIds: [], instruction: null, idempotencyKey: "synthetic-key-0001" } }]);
    expect(state().pending).toBeNull();
    expect(namingStatus(state())).toEqual({ kind: "active", message: "Generating names… 0 of 100", savedCount: 0 });
    expect(await feedController.start()).toBe(true); expect(writes("/feed/ensure")).toHaveLength(1);
  });
  it("asks for More names once names exist, and never without saved choices", async () => {
    server = feed({ run: run("succeeded", { savedCount: 60 }), entries: [entry(1)] });
    expect(await controller(null).more()).toBe(false); expect(writes("/feed/ensure")).toHaveLength(0);
    const feedController = controller(); await feedController.load();
    expect(await feedController.start()).toBe(true);
    expect(await feedController.more()).toBe(true);
    expect(writes("/feed/ensure").map(call => (call.body as { kind: string }).kind)).toEqual(["more"]);
  });
  it("steers with More like this names and trimmed guidance, then clears the sent draft", async () => {
    server = feed({ run: run("succeeded", { savedCount: 1 }), entries: [entry(1)] });
    const feedController = controller(); await feedController.load();
    memory.setSteeringDraft(account, projectId, () => ({ candidateIds: [id(101)], instruction: "  Softer vowels " }));
    expect(await feedController.steer([id(999)], "Unknown seed")).toBe(false);
    expect(await feedController.steer([id(101)], "  Softer vowels ")).toBe(true);
    expect(writes("/steering")[0]!.body).toMatchObject({ kind: "steer", seedIds: [id(101)], instruction: "Softer vowels" });
    expect(memory.get(account, projectId)!.steeringDraft).toEqual({ candidateIds: [], instruction: "" });
    expect(await feedController.steer([], "Another direction")).toBe(false);
  });
  it("stops a running run, keeps its names and reports Stopped once it ends", async () => {
    server = feed({ run: run("running", { savedCount: 40 }), entries: [entry(1)] });
    const feedController = controller(); await feedController.load();
    const stopping = feedController.stop();
    expect(namingStatus(state())).toEqual({ kind: "stopping", message: "Stopping… 40 names saved." });
    expect(await stopping).toBe(true);
    expect(writes("/feed/stop")).toEqual([{ path: `${base}/feed/stop`, method: "POST", body: {}, owner: account.userId }]);
    expect(namingStatus(state())).toEqual({ kind: "stopping", message: "Stopping… 40 names saved." });
    server = { ...server, run: run("cancelled", { savedCount: 40, finishedAt: at(5) }) };
    await feedController.load();
    expect(namingStatus(state())).toEqual({ kind: "stopped", message: "Stopped. 40 names saved." });
    expect(state().entries).toHaveLength(1);
  });
});

describe("Try again", () => {
  it("repeats an unconfirmed start with the same key, so SQL returns the run it may have started", async () => {
    const feedController = controller(); await feedController.load();
    reply = call => { if (call.method === "POST") throw new AccountRequestError(408); return { feed: page(call.path) }; };
    expect(await feedController.start()).toBe(false);
    expect(namingStatus(state())).toEqual({ kind: "error", message: "Name generation couldn’t be confirmed. Try again." });
    expect(state().pending?.idempotencyKey).toBe("synthetic-key-0001");
    reply = () => { server = { ...server, run: run("queued") }; return { feed: page(base), run: server.run, reused: true }; };
    expect(await feedController.retry()).toBe(true);
    expect(writes("/feed/ensure").map(call => (call.body as { idempotencyKey: string }).idempotencyKey)).toEqual(["synthetic-key-0001", "synthetic-key-0001"]);
    expect(namingStatus(state()).kind).toBe("active");
  });
  it("clears an unconfirmed start once a poll shows the run working", async () => {
    const feedController = controller(); await feedController.load();
    reply = call => { if (call.method === "POST") throw new AccountRequestError(502); return { feed: page(call.path) }; };
    await feedController.start();
    server = { ...server, run: run("running", { savedCount: 5 }) };
    await feedController.load();
    expect(state()).toMatchObject({ pending: null, error: null });
    expect(namingStatus(state())).toMatchObject({ message: "Generating names… 5 of 100" });
  });
  it("starts a failed run's kind again with a new key", async () => {
    server = feed({ run: run("failed", { kind: "more", errorCode: "response_timeout", savedCount: 12 }), entries: [entry(1)] });
    const feedController = controller(); await feedController.load();
    expect(namingStatus(state())).toEqual({ kind: "failed", message: "The AI service took too long to reply. 12 names saved. Try again." });
    expect(await feedController.retry()).toBe(true);
    expect(writes("/feed/ensure")[0]!.body).toMatchObject({ kind: "more", idempotencyKey: "synthetic-key-0001" });
  });
  it("repeats a failed steered run's direction with a new key", async () => {
    server = feed({ run: run("succeeded"), entries: [entry(1)] });
    const feedController = controller(); await feedController.load();
    await feedController.steer([id(101)], "Quiet");
    server = { ...server, run: run("failed", { kind: "steer", errorCode: "send_interrupted" }) };
    await feedController.load();
    expect(namingStatus(state())).toMatchObject({ message: "Name generation was interrupted before it started. Try again." });
    await feedController.retry();
    expect(writes("/steering").map(call => call.body)).toMatchObject([{ seedIds: [id(101)], instruction: "Quiet", idempotencyKey: "synthetic-key-0001" }, { seedIds: [id(101)], instruction: "Quiet", idempotencyKey: "synthetic-key-0002" }]);
  });
  it("drops a refused start, shows why and reads the latest state", async () => {
    const feedController = controller(); await feedController.load();
    reply = call => { if (call.method === "POST") throw new AccountRequestError(409); return { feed: page(call.path) }; };
    expect(await feedController.start()).toBe(false); await settle();
    expect(state().pending).toBeNull();
    expect(state().error).toContain("Check the latest names, then try again.");
    expect(reads()).toHaveLength(2);
    reply = call => { if (call.method === "POST") throw new AccountRequestError(503); return { feed: page(call.path) }; };
    await feedController.retry();
    expect(namingStatus(state())).toEqual({ kind: "error", message: "AI name generation is unavailable right now." });
  });
  it("repeats a Stop whose answer was lost", async () => {
    server = feed({ run: run("running") });
    const feedController = controller(); await feedController.load();
    reply = call => { if (call.method === "POST") throw new AccountRequestError(408); return { feed: page(call.path) }; };
    expect(await feedController.stop()).toBe(false);
    expect(state()).toMatchObject({ stopping: false, retry: "stop", error: "Stop couldn’t be confirmed. Try again." });
    reply = call => { server = { ...server, run: run("cancel_requested") }; return { feed: page(call.path) }; };
    expect(await feedController.retry()).toBe(true); expect(writes("/feed/stop")).toHaveLength(2);
    expect(state().error).toBeNull();
  });
});

describe("status copy", () => {
  const view = (patch: Partial<NamingFeedState>) => namingStatus({ feed: null, entries: [], status: "ready", pending: null, stopping: false, error: null, retry: null, lastSteer: null, ...patch });
  it.each([
    [run("queued"), { kind: "active", message: "Generating names… 0 of 100", savedCount: 0 }],
    [run("running", { savedCount: 40 }), { kind: "active", message: "Generating names… 40 of 100", savedCount: 40 }],
    [run("cancel_requested", { savedCount: 1 }), { kind: "stopping", message: "Stopping… 1 name saved." }],
    [run("cancelled", { savedCount: 0 }), { kind: "stopped", message: "Stopped. 0 names saved." }],
    [run("succeeded", { savedCount: 64 }), { kind: "idle" }],
    [run("succeeded", { savedCount: 100 }), { kind: "idle" }],
  ] as const)("describes run %# plainly", (latest, expected) => {
    expect(view({ feed: feed({ run: latest }) })).toEqual(expected);
  });
  it("gives every failure reason a short message with Try again", () => {
    for (const code of namingRunErrorCodeSchema.options) {
      const message = namingFailureMessage(code, 0);
      expect(message, code).toMatch(/Try again/); expect(message.length, code).toBeLessThan(110);
      expect(message, code).not.toMatch(/reconcil|prepared|dispatch|unresolved|lease|\$/i);
    }
    expect(namingFailureMessage("send_interrupted", 0)).toBe("Name generation was interrupted before it started. Try again.");
    expect(namingFailureMessage("no_names", 0)).toBe("None of the new names passed the checks. Try again, or adjust your naming choices.");
    expect(namingFailureMessage("save_failed", 1)).toBe("The new names couldn’t be saved. 1 name saved. Try again.");
    expect(namingFailureMessage(null, 0)).toBe("Name generation couldn’t finish. Try again.");
  });
  it("shows unavailable generation, a pending start and request errors", () => {
    expect(view({ feed: feed({ availability: { status: "unavailable", code: "worker_unavailable" }, run: run("succeeded") }) })).toEqual({ kind: "unavailable", message: "AI name generation is unavailable right now." });
    expect(view({ feed: feed({ availability: { status: "unavailable", code: "worker_unavailable" }, run: run("running", { savedCount: 3 }) }) }).kind).toBe("active");
    expect(view({ feed: feed(), pending: { version: 2, kind: "initial", expectedProjectRevision: 1, expectedPreferencesVersion: 1, seedIds: [], instruction: null, idempotencyKey: "synthetic-key-0001" } })).toEqual({ kind: "starting", message: "Generating names…" });
    expect(view({ feed: feed({ run: run("running") }), error: "Stop couldn’t be confirmed. Try again." })).toEqual({ kind: "error", message: "Stop couldn’t be confirmed. Try again." });
  });
});

describe("on the generation engine", () => {
  /** An engine name: brainstorm origin version 2, run id instead of an old batch. */
  function engineEntry(n: number): NamingFeedEntry {
    const row = entry(n), { candidate } = row.entry;
    return { ...row, entry: { ...row.entry, candidate: { ...candidate, origin: { kind: "brainstorm", version: 2, profile: "brainstorm_v1", ownerId: account.userId, projectId,
      candidateId: candidate.id, contextRevision: 1, value: candidate.value, runId, outputKey: "round.1.1", responseId: "resp_synthetic", model: "gpt-6-luna", primaryApproach: "real_words", generatedAt: at(n) } } } };
  }
  it("shows engine names next to older ones and checks a working run every 3 seconds", async () => {
    server = feed({ engine: true, run: run("running", { savedCount: 1 }), entries: [entry(1), engineEntry(2)] });
    const feedController = controller(); const stop = feedController.startPolling(); await settle();
    expect(state().entries.map(row => row.entry.candidate.origin.kind === "brainstorm" && row.entry.candidate.origin.version)).toEqual([1, 2]);
    expect(namingPollInterval(state())).toBe(NAMING_ENGINE_ACTIVE_POLL_MS);
    await vi.advanceTimersByTimeAsync(NAMING_ACTIVE_POLL_MS); expect(reads()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(NAMING_ENGINE_ACTIVE_POLL_MS - NAMING_ACTIVE_POLL_MS); expect(reads()).toHaveLength(2);
    server = { ...server, run: run("succeeded", { savedCount: 1 }) };
    await vi.advanceTimersByTimeAsync(NAMING_ENGINE_ACTIVE_POLL_MS);
    expect(namingPollInterval(state())).toBe(NAMING_IDLE_POLL_MS);
    stop();
  });
  it("explains running out of credits with the renewal date, without a price, and drops the request", async () => {
    server = feed({ engine: true });
    const feedController = controller(); await feedController.load();
    reply = call => {
      if (call.path === "/api/credits") return { credits: { planId: "free", balance: 0, periodEnd: "2026-12-01T00:00:00Z" } };
      if (call.method === "POST") throw new AccountRequestError(402);
      return { feed: page(call.path) };
    };
    expect(await feedController.start()).toBe(false);
    expect(state()).toMatchObject({ pending: null, retry: "start", error: "You've used this month's credits. They renew on December 1. Your names are saved." });
    expect(state().error).not.toMatch(/\$|cost|price/iu);
    expect(namingCreditsMessage(null)).toBe("You've used this month's credits. Your names are saved.");
  });
  it("names today's limit, and keeps an admitted run that didn't start for Try again with the same key", async () => {
    server = feed({ engine: true });
    const feedController = controller(); await feedController.load();
    reply = call => { if (call.method === "POST") throw new AccountRequestError(429); return { feed: page(call.path) }; };
    expect(await feedController.start()).toBe(false);
    expect(state()).toMatchObject({ pending: null, error: "You’ve reached today’s limit for name generation. Try again tomorrow. Your names are saved." });
    reply = call => { if (call.method === "POST") throw new AccountRequestError(500); return { feed: page(call.path) }; };
    expect(await feedController.start()).toBe(false);
    expect(state().pending).toMatchObject({ idempotencyKey: "synthetic-key-0002" });
    reply = call => call.method === "POST" ? (server = { ...server, run: run("queued") }, { feed: page(base), run: server.run, reused: true }) : { feed: page(call.path) };
    expect(await feedController.retry()).toBe(true);
    expect(writes("/feed/ensure").map(call => (call.body as { idempotencyKey: string }).idempotencyKey)).toEqual(["synthetic-key-0001", "synthetic-key-0002", "synthetic-key-0002"]);
  });
  it("describes the engine's own failure reasons plainly", () => {
    expect(namingFailureMessage("provider_unavailable", 0)).toBe("The AI service is busy right now. Try again.");
    expect(namingFailureMessage("run_timed_out", 12)).toBe("Name generation took too long and was stopped. 12 names saved. Try again.");
    expect(namingFailureMessage("policy_mismatch", 0)).toBe("Name generation couldn’t finish. Try again.");
  });
});

it("keeps a newer local heart when an older read arrives", () => {
  const liked = { ...entry(1), entry: { ...entry(1).entry, retention: { ...entry(1).entry.retention, revision: 2, favorite: true } } };
  expect(mergeNamingFeedEntries([liked], [entry(1), entry(2)])).toEqual([liked, entry(2)]);
  expect(mergeNamingFeedEntries([liked, entry(3)], [entry(1)], true)).toEqual([liked]);
});
