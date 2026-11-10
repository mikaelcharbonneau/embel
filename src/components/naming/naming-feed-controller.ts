import { z } from "zod";
import { AccountRequestError } from "@/components/workspace/account-api";
import { boundedAccountRequest } from "@/components/workspace/bounded-account-request";
import { creditsMessage } from "@/components/workspace/credits-message";
import { creditSummaryResponseSchema } from "@/domain/generations";
import {
  NAMING_RUN_TARGET, namingGenerationFeedSchema, namingRunActive, namingRunSchema, startNamingRunRequestSchema,
  type NamingFeedCursor, type NamingFeedEntry, type NamingGenerationFeed, type NamingRunErrorCode, type NamingRunKind, type StartNamingRunRequest,
} from "@/domain/naming-generation";
import type { NamingAccount, NamingBrainMemory, NamingFeedState } from "./naming-brain-memory";

/** Poll every second while a run is working (every 3 seconds on the generation engine),
 * otherwise every 15 seconds (visible tabs only). */
export const NAMING_ACTIVE_POLL_MS = 1_000;
export const NAMING_ENGINE_ACTIVE_POLL_MS = 3_000;
export const NAMING_IDLE_POLL_MS = 15_000;
/** One read follows at most this many 100-name pages; the next poll continues from there. */
export const NAMING_FEED_MAX_PAGES = 50;

export const namingFeedResponseSchema = z.strictObject({ feed: namingGenerationFeedSchema });
export const namingStartResponseSchema = z.strictObject({ feed: namingGenerationFeedSchema, run: namingRunSchema, reused: z.boolean() });

/** The saved versions a start request must name; SQL refuses a stale one. */
export type NamingBasis = { projectRevision: number; preferencesVersion: number };

export function namingPollInterval(state: NamingFeedState | null | undefined) {
  if (!state || !(state.pending || state.stopping || namingRunActive(state.feed?.run))) return NAMING_IDLE_POLL_MS;
  return state.feed?.engine ? NAMING_ENGINE_ACTIVE_POLL_MS : NAMING_ACTIVE_POLL_MS;
}

/** Keeps known names in place and appends new ones; a newer local heart or save is never undone by an older read. */
export function mergeNamingFeedEntries(previous: readonly NamingFeedEntry[], incoming: readonly NamingFeedEntry[], complete = false): NamingFeedEntry[] {
  const known = new Map(previous.map(row => [row.entry.candidate.id, row]));
  const rows = new Map(complete ? [] : previous.map(row => [row.entry.candidate.id, row]));
  for (const row of incoming) {
    const before = known.get(row.entry.candidate.id);
    rows.set(row.entry.candidate.id, before && before.entry.retention.revision > row.entry.retention.revision ? { ...row, entry: before.entry } : row);
  }
  return [...rows.values()];
}

const failureReasons: Record<NamingRunErrorCode, string> & Record<string, string> = {
  send_interrupted: "Name generation was interrupted before it started.",
  provider_rejected: "The AI service turned down this request.",
  response_failed: "The AI service couldn’t finish these names.",
  response_timeout: "The AI service took too long to reply.",
  invalid_output: "The AI reply couldn’t be read.",
  save_failed: "The new names couldn’t be saved.",
  no_names: "None of the new names passed the checks.",
  lease_expired: "Name generation stopped unexpectedly.",
  deadline: "Name generation took too long and was stopped.",
  // Generation engine runs (docs/generation-engine.md).
  provider_unavailable: "The AI service is busy right now.",
  run_timed_out: "Name generation took too long and was stopped.",
  start_failed: "Name generation couldn’t start.",
};
/** Out of credits: when they renew, and that nothing is lost. */
export function namingCreditsMessage(periodEnd: string | null) {
  return creditsMessage(periodEnd, "Your names are saved.");
}
const names = (count: number) => count === 1 ? "1 name" : `${count} names`;

/** Plain copy for a failed run; names it saved before failing stay saved. */
export function namingFailureMessage(code: string | null, savedCount: number) {
  const reason = code && Object.hasOwn(failureReasons, code) ? failureReasons[code]! : "Name generation couldn’t finish.";
  return [reason, savedCount > 0 ? `${names(savedCount)} saved.` : "", code === "no_names" ? "Try again, or adjust your naming choices." : "Try again."].filter(Boolean).join(" ");
}

export type NamingStatus =
  | { kind: "idle" }
  | { kind: "starting" | "stopping" | "stopped" | "unavailable"; message: string }
  | { kind: "active"; message: string; savedCount: number }
  | { kind: "failed" | "error"; message: string };

/** What the names message says about generation. A finished run, even short of 100, says nothing. */
export function namingStatus(state: NamingFeedState | null | undefined): NamingStatus {
  const run = state?.feed?.run;
  if (!state) return { kind: "idle" };
  if (state.error) return { kind: "error", message: state.error };
  if (state.stopping || run?.state === "cancel_requested") return { kind: "stopping", message: `Stopping… ${names(run?.savedCount ?? 0)} saved.` };
  if (run && namingRunActive(run)) return { kind: "active", message: `Generating names… ${run.savedCount} of ${NAMING_RUN_TARGET}`, savedCount: run.savedCount };
  if (state.pending) return { kind: "starting", message: "Generating names…" };
  if (state.feed?.availability.status === "unavailable") return { kind: "unavailable", message: "AI name generation is unavailable right now." };
  if (run?.state === "cancelled") return { kind: "stopped", message: `Stopped. ${names(run.savedCount)} saved.` };
  if (run?.state === "failed") return { kind: "failed", message: namingFailureMessage(run.errorCode, run.savedCount) };
  return { kind: "idle" };
}

function requestFailure(cause: unknown, action: "start" | "stop" | "load") {
  if (cause instanceof AccountRequestError) {
    if (cause.status === 401) return "Sign in again to continue. Your saved names are kept.";
    if (action === "start" && cause.status === 503) return "AI name generation is unavailable right now.";
    if (action === "start" && cause.status === 409) return "Your project or naming choices changed, or names are already being generated. Check the latest names, then try again.";
    if (action === "start" && cause.status === 422) return "Finish your naming choices before generating names.";
    if (action === "start" && cause.status === 402) return namingCreditsMessage(null);
    if (action === "start" && cause.status === 429) return "You’ve reached today’s limit for name generation. Try again tomorrow. Your names are saved.";
    if (cause.status === 429) return "Too many requests right now. Wait a moment, then try again.";
  }
  return action === "start" ? "Name generation couldn’t be confirmed. Try again." : action === "stop" ? "Stop couldn’t be confirmed. Try again." : "Names couldn’t be loaded. Try again.";
}
/** Answers that prove the request started nothing; anything else may have reached SQL. */
const definitive = (cause: unknown) => cause instanceof AccountRequestError && [400, 401, 402, 403, 404, 409, 413, 422, 429, 503].includes(cause.status);
const cursorOf = (row?: NamingFeedEntry): NamingFeedCursor | null => row ? { createdAt: row.entry.candidate.createdAt, id: row.entry.candidate.id } : null;

type Timers = { setTimeout: (callback: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void };

export function createNamingFeedController(options: {
  account: NamingAccount; projectId: string; memory: NamingBrainMemory; basis?: () => NamingBasis | null; visible?: () => boolean;
  request?: typeof boundedAccountRequest; expire?: (account: NamingAccount) => void; timers?: Timers; newKey?: () => string;
}) {
  const { account, projectId, memory } = options;
  const request = options.request ?? boundedAccountRequest, newKey = options.newKey ?? (() => crypto.randomUUID());
  const timers: Timers = options.timers ?? { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  const visible = options.visible ?? (() => typeof document === "undefined" || document.visibilityState === "visible");
  const base = `/api/projects/${projectId}/naming`, controllers = new Map<AbortController, string>();
  let basis = options.basis ?? (() => null);
  let closed = false, polling = false, timer: unknown = null, lastRequest: StartNamingRunRequest | null = null;
  const current = () => !closed && memory.isCurrent(account);
  const state = () => memory.get(account, projectId)?.feed;
  const update = (change: (value: NamingFeedState) => NamingFeedState) => { if (current()) memory.setFeed(account, projectId, change); };
  function begin(name: string) { const key = `naming-${name}:${projectId}`, controller = memory.acquire(account, key); if (controller) controllers.set(controller, key); return { key, controller }; }
  function finish(key: string, controller: AbortController) { memory.release(key, controller); controllers.delete(controller); }
  const live = (key: string, controller: AbortController) => current() && memory.operationCurrent(account, key, controller);

  function own(feed: NamingGenerationFeed) {
    if (feed.projectId !== projectId || feed.entries.some(row => row.entry.candidate.ownerId !== account.userId || row.entry.candidate.projectId !== projectId)) {
      options.expire?.(account); throw new AccountRequestError(502);
    }
  }
  function receive(feed: NamingGenerationFeed, rows: readonly NamingFeedEntry[], complete: boolean) {
    own(feed);
    update(value => {
      const active = namingRunActive(feed.run);
      // A newly visible run settles an unconfirmed start; a finished run settles a failed Stop.
      const settled = value.retry === "load" || value.retry === "start" && active || value.retry === "stop" && !active;
      return { ...value, feed, entries: mergeNamingFeedEntries(value.entries, rows, complete), status: "ready",
        pending: value.pending && active ? null : value.pending, ...(settled ? { error: null, retry: null } : {}) };
    });
  }
  function fail(cause: unknown, retry: "start" | "stop" | "load") {
    if (cause instanceof AccountRequestError && cause.status === 401) options.expire?.(account);
    update(value => ({ ...value, error: requestFailure(cause, retry), retry }));
  }

  /** Polls continue after the newest known name; a full read (mount, refresh) replaces the list. */
  async function read(full = false): Promise<boolean> {
    if (!current()) return false;
    if (!state()) memory.setFeed(account, projectId, value => value);
    const { key, controller } = begin("read"); if (!controller) return false;
    try {
      let cursor = full || !state()?.feed ? null : cursorOf(state()?.entries.at(-1));
      const complete = cursor === null, rows: NamingFeedEntry[] = [];
      let feed: NamingGenerationFeed | null = null;
      for (let page = 0; page < NAMING_FEED_MAX_PAGES; page++) {
        const query = new URLSearchParams({ limit: "100" });
        if (cursor) { query.set("cursorCreatedAt", cursor.createdAt); query.set("cursorId", cursor.id); }
        const reply = await request(`${base}/feed?${query}`, namingFeedResponseSchema, { signal: controller.signal });
        if (!live(key, controller)) return false;
        own(reply.feed); feed = reply.feed; rows.push(...reply.feed.entries);
        if (!reply.feed.nextCursor) break;
        cursor = reply.feed.nextCursor;
      }
      receive(feed!, rows, complete);
      return true;
    } catch (cause) { if (live(key, controller)) fail(cause, "load"); return false; }
    finally { finish(key, controller); }
  }

  const load = () => read(true);

  function build(kind: NamingRunKind, seedIds: string[] = [], instruction: string | null = null) {
    const saved = basis(); if (!saved) return null;
    const parsed = startNamingRunRequestSchema.safeParse({ version: 2, kind, expectedProjectRevision: saved.projectRevision, expectedPreferencesVersion: saved.preferencesVersion, seedIds, instruction, idempotencyKey: newKey() });
    return parsed.success ? parsed.data : null;
  }

  async function send(body: StartNamingRunRequest): Promise<boolean> {
    if (!current()) return false;
    const { key, controller } = begin("start"); if (!controller) return false;
    lastRequest = body;
    update(value => ({ ...value, pending: body, error: null, retry: null, ...(body.kind === "steer" ? { lastSteer: { seedIds: body.seedIds, instruction: body.instruction } } : {}) }));
    let conflict = false;
    try {
      const reply = await request(body.kind === "steer" ? `${base}/steering` : `${base}/feed/ensure`, namingStartResponseSchema,
        { method: "POST", body, expectedOwnerId: account.userId, signal: controller.signal });
      if (!live(key, controller)) return false;
      own(reply.feed);
      if (reply.run.kind !== body.kind) throw new AccountRequestError(502);
      update(value => ({ ...value, pending: null }));
      receive(reply.feed, reply.feed.entries, false);
      if (body.kind === "steer") memory.acknowledgeSteeringDraft(account, projectId, body);
      wake();
      return true;
    } catch (cause) {
      if (live(key, controller)) {
        // An uncertain answer keeps the request: Try again repeats its key, so SQL returns the run it may have started.
        update(value => ({ ...value, pending: definitive(cause) ? null : body }));
        fail(cause, "start");
        conflict = cause instanceof AccountRequestError && cause.status === 409;
        // Out of credits: add when they renew. A failed lookup leaves the message without a date.
        if (cause instanceof AccountRequestError && cause.status === 402) {
          const periodEnd = await request("/api/credits", creditSummaryResponseSchema, { signal: controller.signal }).then(reply => reply.credits.periodEnd, () => null);
          if (periodEnd && live(key, controller)) update(value => ({ ...value, error: namingCreditsMessage(periodEnd) }));
        }
      }
      return false;
    } finally {
      finish(key, controller);
      if (conflict) void read();
    }
  }

  async function start(kind?: "initial" | "more"): Promise<boolean> {
    if (current() && !state()?.feed) await read();
    const value = state();
    if (!current() || !value?.feed) return false;
    if (namingRunActive(value.feed.run)) return true;
    if (value.pending || value.stopping) return false;
    const body = build(kind ?? (value.entries.length || value.feed.run ? "more" : "initial"));
    return body ? send(body) : false;
  }

  async function steer(seedIds: string[], instruction: string | null): Promise<boolean> {
    const value = state();
    if (!current() || !value?.feed || value.pending || value.stopping || namingRunActive(value.feed.run)) return false;
    if (seedIds.some(id => !value.entries.some(row => row.entry.candidate.id === id))) return false;
    const body = build("steer", seedIds, instruction?.trim() || null);
    return body ? send(body) : false;
  }

  async function stop(): Promise<boolean> {
    if (!current() || !state()?.feed) return false;
    const { key, controller } = begin("stop"); if (!controller) return false;
    update(value => ({ ...value, stopping: true, error: null, retry: null }));
    try {
      const reply = await request(`${base}/feed/stop`, namingFeedResponseSchema, { method: "POST", body: {}, expectedOwnerId: account.userId, signal: controller.signal });
      if (!live(key, controller)) return false;
      receive(reply.feed, reply.feed.entries, false);
      update(value => ({ ...value, stopping: false }));
      wake();
      return true;
    } catch (cause) {
      if (live(key, controller)) { update(value => ({ ...value, stopping: false })); fail(cause, "stop"); }
      return false;
    } finally { finish(key, controller); }
  }

  /** Try again repeats what failed: the same unconfirmed request, a Stop, a read, or a failed run's kind with a new key. */
  async function retry(): Promise<boolean> {
    const value = state();
    if (!current() || !value) return false;
    if (value.retry === "stop") return stop();
    if (value.retry === "load") return load();
    if (value.pending) return send(value.pending);
    const run = value.feed?.run;
    const kind = value.retry === "start" && lastRequest ? lastRequest.kind : run?.state === "failed" ? run.kind : null;
    if (kind === "steer") return value.lastSteer ? steer(value.lastSteer.seedIds, value.lastSteer.instruction) : start();
    if (kind) return start(kind);
    return load();
  }

  async function tick() {
    timer = null;
    if (!polling || !current()) return;
    if (visible()) await read();
    if (polling && current() && timer === null) timer = timers.setTimeout(() => void tick(), namingPollInterval(state()));
  }
  /** Poll now instead of waiting, unless a read is already running. */
  function wake() {
    if (!polling || timer === null) return;
    timers.clearTimeout(timer); timer = null; void tick();
  }

  function stopPolling() { polling = false; if (timer !== null) timers.clearTimeout(timer); timer = null; }
  return {
    /** More names asks for the next set; with no generated names yet it is the first set. */
    load, start, more: () => start(), steer, stop, retry, wake,
    configure(next: () => NamingBasis | null) { basis = next; },
    activate() { closed = false; },
    /** Starts the visible-tab polling loop with an immediate read; the returned function ends it. */
    startPolling() {
      if (!polling) { polling = true; void tick(); }
      return stopPolling;
    },
    dispose() {
      closed = true; stopPolling();
      for (const [controller, key] of controllers) { controller.abort(); memory.release(key, controller); }
      controllers.clear();
    },
  };
}
export type NamingFeedController = ReturnType<typeof createNamingFeedController>;
