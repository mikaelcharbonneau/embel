import { AccountRequestError } from "@/components/workspace/account-api";
import { boundedAccountRequest } from "@/components/workspace/bounded-account-request";
import { nameIdentityKey } from "@/domain/project-naming";
import { ensureNamingRunIntentSchema, stopNamingFeedIntentSchema, stopNamingFeedResponseSchema, namingFeedEnsureResultSchema, namingFeedResponseSchema, steerNamingFeedIntentSchema, steerNamingFeedResponseSchema,
  type EnsureNamingRunIntent, type NamingFeed, type NamingFeedCursor, type NamingFeedEntry, type StopNamingFeedIntent } from "@/domain/naming-brain";
import type { NamingAccount, NamingBrainMemory, NamingFeedState } from "./naming-brain-memory";
export const NAMING_EXPLORATION_IDLE_MS = 60_000;
const terminal = (state?: string) => Boolean(state && !["queued", "running", "cancel_requested"].includes(state));
const active = (state?: string) => Boolean(state && ["queued", "running", "cancel_requested"].includes(state));
const cursorOf = (entry?: NamingFeedEntry): NamingFeedCursor | null => entry ? { entryId: entry.entryId, position: entry.position } : null;

/** Identity affects display count; immutable feed positions remain the pagination authority. */
export function mergeNamingFeedEntries(previous: NamingFeedEntry[], incoming: NamingFeedEntry[]): NamingFeedEntry[] {
  const rows = new Map(previous.map(row => [row.entryId, row]));
  const positions = new Map(previous.map(row => [row.position, row.entryId]));
  const candidates = new Map(previous.map(row => [row.entry.candidate.id, row.entryId]));
  for (const row of incoming) {
    const old = rows.get(row.entryId);
    if (positions.has(row.position) && positions.get(row.position) !== row.entryId || candidates.has(row.entry.candidate.id) && candidates.get(row.entry.candidate.id) !== row.entryId) throw new AccountRequestError(502);
    positions.set(row.position, row.entryId); candidates.set(row.entry.candidate.id, row.entryId);
    if (old && (old.position !== row.position || old.entry.candidate.id !== row.entry.candidate.id || old.entry.candidate.value !== row.entry.candidate.value || old.runId !== row.runId)) throw new AccountRequestError(502);
    rows.set(row.entryId, old && old.entry.retention.revision > row.entry.retention.revision ? { ...row, entry: old.entry } : row);
  }
  const seen = new Set<string>();
  return [...rows.values()].sort((a, b) => a.position - b.position).filter(row => { const identity = nameIdentityKey(row.entry.candidate.value); if (seen.has(identity)) return false; seen.add(identity); return true; });
}
function failure(error: unknown) {
  if (error instanceof AccountRequestError) {
    if (error.status === 409) return "Naming changed in another session. Check the saved choices and direction before continuing.";
    if (error.status === 401) return "Verify the same account to recover this Naming request.";
    if (error.status === 429) return "New names are paused at the current limit. Your saved names remain available.";
    if (error.status === 503) return "New Naming exploration is unavailable. Your saved names and unfinished request are kept.";
  }
  return "The Naming response could not be confirmed. Your saved names are kept; check the saved state or retry the same request.";
}
export function createNamingFeedController(options: { account: NamingAccount; projectId: string; memory: NamingBrainMemory; eligible: () => boolean; visible?: () => boolean; now?: () => number; request?: typeof boundedAccountRequest; expire?: (account: NamingAccount) => void }) {
  const { account, projectId, memory } = options, request = options.request ?? boundedAccountRequest, now = options.now ?? Date.now;
  const base = `/api/projects/${projectId}/naming`, controllers = new Map<AbortController, string>();
  let eligible = options.eligible;
  let closed = false, lastInteraction: number | null = null, interaction = 0, consumedInteraction = 0, starting = false;
  const current = () => !closed && memory.isCurrent(account);
  const state = () => memory.get(account, projectId)?.feed;
  const visible = () => options.visible ? options.visible() : typeof document === "undefined" || document.visibilityState === "visible";
  const exploring = () => current() && eligible() && visible() && lastInteraction !== null && now() - lastInteraction < NAMING_EXPLORATION_IDLE_MS && !state()?.stopped;
  const update = (change: (value: NamingFeedState) => NamingFeedState) => { if (current()) memory.setFeed(account, projectId, change); };
  function own(feed: NamingFeed) { if (feed.ownerId !== account.userId || feed.projectId !== projectId) { options.expire?.(account); throw new AccountRequestError(502); } }
  function receive(feed: NamingFeed, direction: number, rows = feed.entries, stopReceipt = false) {
    own(feed);
    const before = state(); if (!before || before.directionEpoch !== direction) return false;
    const old = before.feed;
    if (before.stop && !before.stopConflict && !stopReceipt) return false;
    if (!stopReceipt && before.steering && feed.steeringRevision <= before.steering.expectedSteeringRevision) return false;
    if ((memory.get(account, projectId)?.preferences?.saved?.version ?? 0) > feed.preferencesVersion) return false;
    if (old?.activeRun && feed.activeRun?.runId === old.activeRun.runId && feed.activeRun.revision < old.activeRun.revision) return false;
    if (old && (feed.steeringRevision < old.steeringRevision || feed.projectRevision < old.projectRevision || feed.preferencesVersion < old.preferencesVersion || feed.demandSequence < old.demandSequence)) return false;
    update(value => {
      const stopped = feed.paused || value.stop !== null || value.stopRequested ? true : old === null && (feed.demandSequence > 0 || feed.activeRun !== null || rows.some(row => row.runId !== null)) && feed.state === "active" && !value.stopRequested ? false : value.stopped;
      const pending = value.pending, run = feed.activeRun;
      const acknowledged = value.acknowledged || Boolean(pending && run && run.projectRevision === pending.expectedProjectRevision && run.preferencesVersion === pending.expectedPreferencesVersion && run.steeringRevision === pending.expectedSteeringRevision && run.demandSequence === pending.expectedDemandSequence + (pending.reason === "resume" ? 1 : 0) && (pending.reason !== "resume" || run.resumedFromRunId === pending.resumeOfRunId) && JSON.stringify(feed.consumedThrough) === JSON.stringify(pending.consumedThrough));
      return { ...value, feed, stopped, acknowledged, entries: mergeNamingFeedEntries(value.entries, rows),
        status: value.pending && !acknowledged ? value.status : active(feed.activeRun?.state) ? "pending" : terminal(feed.activeRun?.state) && ["partial", "failed", "cancelled", "needs_reconciliation"].includes(feed.activeRun!.state) ? "incomplete" : feed.state === "blocked" ? "blocked" : stopped ? "paused" : "ready" };
    });
    return true;
  }
  function begin(name: string) { const key = `${name}:${projectId}`, controller = memory.acquire(account, key); if (controller) controllers.set(controller, key); return { key, controller }; }
  function finish(key: string, controller: AbortController) { memory.release(key, controller); controllers.delete(controller); }
  const live = (key: string, controller: AbortController) => current() && memory.operationCurrent(account, key, controller);
  function error(cause: unknown) { update(value => ({ ...value, status: "error", error: failure(cause) })); if (cause instanceof AccountRequestError && cause.status === 401) options.expire?.(account); }

  async function ensure(intent: EnsureNamingRunIntent) {
    if (!current()) return false;
    const { key, controller } = begin("ensure"); if (!controller) return false;
    const direction = (state()?.directionEpoch ?? 0) + 1;
    update(value => ({ ...value, pending: intent, directionEpoch: direction, status: "pending", error: null }));
    try {
      const result = namingFeedEnsureResultSchema.parse(await request(`${base}/feed/ensure`, namingFeedEnsureResultSchema, { method: "POST", body: intent, expectedOwnerId: account.userId, signal: controller.signal }));
      if (!live(key, controller)) return false;
      if (!receive(result.feed, direction)) return Boolean(state()?.acknowledged && state()?.pending?.idempotencyKey === intent.idempotencyKey && "run" in result && state()?.feed?.activeRun?.runId === result.run.runId);
      update(value => ({ ...value, outcome: result, pending: result.status === "pending" || (result.status === "blocked" || result.status === "paused") && result.action === "retry" ? intent : null,
        directionEpoch: value.directionEpoch + 1, acknowledged: result.status === "pending", status: result.status === "appended" ? value.stopped ? "paused" : "ready" : result.status, error: null }));
      return true;
    } catch (cause) { if (live(key, controller) && state()?.directionEpoch === direction) { if (cause instanceof AccountRequestError && [400, 403, 409, 413, 422, 429].includes(cause.status)) update(value => ({ ...value, pending: null, acknowledged: false })); error(cause); } return false; }
    finally { finish(key, controller); }
  }
  async function load(cursor?: NamingFeedCursor | null) {
    if (!current()) return false;
    if (!state()) memory.setFeed(account, projectId, value => value);
    const { key, controller } = begin("feed-read"); if (!controller) return false;
    const direction = state()!.directionEpoch, depth = state()!.entries.at(-1)?.position ?? 0;
    let received = false;
    try {
      let next = cursor ?? null, feed: NamingFeed, rows: NamingFeedEntry[] = [], pages = 0;
      do {
        const query = new URLSearchParams({ limit: "100" });
        if (next) { query.set("cursorEntryId", next.entryId); query.set("cursorPosition", String(next.position)); }
        const reply = namingFeedResponseSchema.parse(await request(`${base}/feed?${query}`, namingFeedResponseSchema, { signal: controller.signal }));
        if (!live(key, controller) || state()?.directionEpoch !== direction) return false;
        own(reply.feed); feed = reply.feed;
        if (next && feed.entries.some(row => row.position <= next!.position)) throw new AccountRequestError(502);
        rows = [...rows, ...feed.entries]; next = feed.nextCursor; pages += 1;
        if (pages > 200) throw new AccountRequestError(502);
      } while (!cursor && next && (rows.at(-1)?.position ?? 0) < depth);
      received = receive(feed!, direction, rows);
      if (received) update(value => ({ ...value, error: value.stop || value.pending && !value.acknowledged ? value.error : null }));
    } catch (cause) { if (live(key, controller) && state()?.directionEpoch === direction) error(cause); }
    finally { finish(key, controller); }
    const after = state();
    // This replays one acknowledged demand to expose its saved outcome; it cannot admit a new demand.
    if (received && after?.pending && after.acknowledged && !after.stop && !after.stopRequested && !after.feed?.paused && !active(after.feed?.activeRun?.state)) await ensure(after.pending);
    return received;
  }
  function intent(reason: "initial" | "scroll"): EnsureNamingRunIntent | null {
    const value = state(), feed = value?.feed;
    if (!feed || feed.preferencesVersion < 1 || feed.availability.status !== "available" || feed.state === "blocked" || reason === "scroll" && feed.paused) return null;
    const consumedThrough = reason === "initial" ? null : cursorOf(feed.entries.at(-1)) ?? cursorOf(value!.entries.at(-1));
    if (reason === "scroll" && !consumedThrough) return null;
    return ensureNamingRunIntentSchema.parse({ version: 1, reason, expectedProjectRevision: feed.projectRevision, expectedPreferencesVersion: feed.preferencesVersion, expectedSteeringRevision: feed.steeringRevision, expectedDemandSequence: feed.demandSequence, consumedThrough, idempotencyKey: crypto.randomUUID() });
  }
  return {
    load,
    activate() { closed = false; },
    configure(next: () => boolean) { eligible = next; if (!eligible()) { lastInteraction = null; consumedInteraction = interaction; } },
    interact() { if (current() && eligible() && visible()) { lastInteraction = now(); interaction += 1; } },
    deactivate() { lastInteraction = null; consumedInteraction = interaction; },
    async start() {
      if (!current() || !eligible() || !visible() || starting || state()?.pending || state()?.steering || state()?.stop) return false;
      starting = true;
      try {
        if (!await load()) return false;
        if (memory.getRecovery(account)) return false;
        const feed = state()?.feed, run = feed?.activeRun;
        if (!feed || run?.state === "needs_reconciliation") return false;
        if (run?.canResume && (feed.paused || feed.preparedSetId)) return resume();
        const changedBasis = Boolean(run && (run.preferencesVersion !== feed.preferencesVersion || run.steeringRevision !== feed.steeringRevision || run.projectRevision !== feed.projectRevision));
        if (run && ["partial", "failed", "cancelled"].includes(run.state) && !changedBasis) return false;
        update(value => ({ ...value, stopped: false, stopRequested: false, status: value.status === "paused" ? "ready" : value.status }));
        lastInteraction = now(); consumedInteraction = ++interaction;
        if (!feed.paused && !changedBasis && (run || feed.entries.length > 0 && feed.demandSequence > 0)) return true;
        const initial = intent("initial"); return initial ? ensure(initial) : false;
      } finally { starting = false; }
    },
    async demand() {
      const value = state();
      if (!exploring() || !value?.feed || memory.getRecovery(account) || interaction <= consumedInteraction || value.pending || value.steering || value.stop || value.feed.paused || value.status !== "ready") return false;
      if (active(value.feed.activeRun?.state) || terminal(value.feed.activeRun?.state) && ["partial", "failed", "cancelled", "needs_reconciliation"].includes(value.feed.activeRun!.state)) return false;
      consumedInteraction = interaction;
      if (value.feed.nextCursor) return load(value.feed.nextCursor);
      const next = intent("scroll"); return next ? ensure(next) : false;
    },
    async retry() {
      const value = state(); if (!current() || !value || memory.getRecovery(account)) return false;
      if (value.stop) return stopFeed(value.stop);
      if (value.steering) return steer(value.steering);
      return value.pending ? ensure(value.pending) : load();
    },
    resume,
    async steer(candidateIds: string[], instruction: string | null) {
      const value = state(), feed = value?.feed;
      if (!current() || !eligible() || !feed || value?.steering || value?.stop || candidateIds.some(id => !value.entries.some(row => row.entry.candidate.id === id))) return false;
      const parsed = steerNamingFeedIntentSchema.safeParse({ candidateIds, instruction, expectedProjectRevision: feed.projectRevision, expectedPreferencesVersion: feed.preferencesVersion, expectedSteeringRevision: feed.steeringRevision, idempotencyKey: crypto.randomUUID() });
      if (!parsed.success) return false;
      update(previous => ({ ...previous, directionEpoch: previous.directionEpoch + 1, steering: parsed.data, pending: null, acknowledged: false, outcome: null, error: null }));
      consumedInteraction = ++interaction; return steer(parsed.data);
    },
    async stop() { return requestStop(false); },
    async stopCurrent() { return requestStop(true); },
    dispose() { if (state()?.pending && !state()?.acknowledged) update(value => ({ ...value, status: "error", error: "This Naming request is not confirmed. Check saved names or retry the same request." })); closed = true; lastInteraction = null; for (const [controller, key] of controllers) { controller.abort(); memory.release(key, controller); } controllers.clear(); },
  };
  async function resume() {
      const value = state(), result = value?.outcome, feed = value?.feed;
      const run = feed?.activeRun ?? (result?.status === "incomplete" ? result.run : null);
      if (!current() || !eligible() || !visible() || !feed || !run?.canResume || (feed.availability.status !== "available" && !(run.preparedSetId && run.fulfillment?.status === "complete")) || value?.pending || value?.steering || value?.stop) return false;
      const next = ensureNamingRunIntentSchema.parse({ version: 1, reason: "resume", resumeOfRunId: run.runId, expectedRunRevision: run.revision, expectedProjectRevision: feed.projectRevision, expectedPreferencesVersion: feed.preferencesVersion, expectedSteeringRevision: feed.steeringRevision, expectedDemandSequence: feed.demandSequence, consumedThrough: cursorOf(feed.entries.at(-1)) ?? feed.consumedThrough, idempotencyKey: crypto.randomUUID() });
      update(previous => ({ ...previous, stopped: false, stopRequested: false })); consumedInteraction = ++interaction; lastInteraction = now();
      return ensure(next);
  }

  async function requestStop(replaceRejected: boolean) {
    const value = state(), feed = value?.feed;
    if (!current() || !feed || memory.getRecovery(account)) return false;
    if (replaceRejected && (!value.stopConflict || !value.stop || feed.demandSequence <= value.stop.expectedDemandSequence)) return false;
    const pending = !replaceRejected && value.stop ? value.stop : stopNamingFeedIntentSchema.parse({ version: 1, expectedDemandSequence: feed.demandSequence, pendingEnsureIdempotencyKey: value.pending?.idempotencyKey ?? null, idempotencyKey: crypto.randomUUID() });
    lastInteraction = null; consumedInteraction = interaction;
    return stopFeed(pending);
  }
  async function stopFeed(pending: StopNamingFeedIntent) {
    const { key, controller } = begin("stop"); if (!controller) return false;
    const direction = (state()?.directionEpoch ?? 0) + 1;
    update(value => ({ ...value, stop: pending, stopConflict: false, stopped: true, stopRequested: true, directionEpoch: direction, status: "paused", error: null }));
    try {
      const reply = stopNamingFeedResponseSchema.parse(await request(`${base}/feed/stop`, stopNamingFeedResponseSchema, { method: "POST", body: pending, expectedOwnerId: account.userId, signal: controller.signal }));
      if (!live(key, controller) || state()?.directionEpoch !== direction) return false;
      own(reply.feed);
      if (!reply.feed.paused) throw new AccountRequestError(reply.feed.demandSequence > pending.expectedDemandSequence ? 409 : 502);
      if (reply.feed.demandSequence <= pending.expectedDemandSequence) throw new AccountRequestError(502);
      if (!receive(reply.feed, direction, reply.feed.entries, true)) throw new AccountRequestError(409);
      update(value => ({ ...value, stop: null, stopConflict: false, pending: null, acknowledged: false, outcome: null, stopped: true, stopRequested: true, status: value.steering ? "error" : "paused", error: value.steering ? "Your pause is saved. Confirm the unfinished direction save before continuing." : null, directionEpoch: value.directionEpoch + 1 }));
      return true;
    } catch (cause) {
      if (live(key, controller) && state()?.directionEpoch === direction) {
        error(cause);
        update(value => ({ ...value, error: "Your pause could not be confirmed. This tab has stopped requesting names; existing work may still finish. Retry the same pause to confirm it." }));
        if (cause instanceof AccountRequestError && cause.status === 409) update(value => ({ ...value, stopConflict: true, error: "Newer exploration is saved. Check the saved state, then explicitly stop the current exploration. Your original Stop request is kept." }));
      }
      return false;
    } finally { finish(key, controller); }
  }
  async function steer(pending: NonNullable<NamingFeedState["steering"]>) {
    const { key, controller } = begin("steering"); if (!controller) return false;
    const direction = state()!.directionEpoch;
    try {
      const reply = steerNamingFeedResponseSchema.parse(await request(`${base}/steering`, steerNamingFeedResponseSchema, { method: "POST", body: pending, expectedOwnerId: account.userId, signal: controller.signal }));
      if (!live(key, controller) || state()?.directionEpoch !== direction) return false;
      if (reply.feed.steeringRevision !== pending.expectedSteeringRevision + 1 || !receive(reply.feed, direction)) throw new AccountRequestError(502);
      update(value => ({ ...value, steering: null, pending: null, acknowledged: false, outcome: null, stopped: reply.feed.paused, stopRequested: false, status: reply.feed.paused ? "paused" : "ready", directionEpoch: value.directionEpoch + 1, error: null })); return true;
    } catch (cause) { if (live(key, controller) && state()?.directionEpoch === direction) { if (cause instanceof AccountRequestError && [400, 403, 409, 413, 422, 429].includes(cause.status)) update(value => ({ ...value, steering: null })); error(cause); } return false; }
    finally { finish(key, controller); }
  }
}
