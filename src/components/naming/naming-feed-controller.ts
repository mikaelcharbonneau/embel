import { AccountRequestError } from "@/components/workspace/account-api";
import { boundedAccountRequest } from "@/components/workspace/bounded-account-request";
import { nameIdentityKey } from "@/domain/project-naming";
import { getNamingPreferencesReadiness } from "@/domain/naming-brain-preferences";
import { ensureNamingRunIntentSchema, stopNamingFeedIntentSchema, stopNamingFeedResponseSchema, namingFeedEnsureResultSchema, namingFeedResponseSchema, steerNamingFeedIntentSchema, steerNamingFeedResponseSchema,
  type EnsureNamingRunIntent, type NamingFeed, type NamingFeedCursor, type NamingFeedEntry, type StopNamingFeedIntent } from "@/domain/naming-brain";
import type { NamingAccount, NamingBrainMemory, NamingFeedState } from "./naming-brain-memory";
export const NAMING_EXPLORATION_IDLE_MS = 60_000;
export const NAMING_PREFETCH_LOW_WATER = 100;
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
  let resumeInteraction: { sequence: number; basis: string } | null = null;
  let prefetchInteraction: { sequence: number; basis: string } | null = null;
  let refreshedRetention: number | undefined;
  let loadedThrough: NamingFeedCursor | null = null;
  let readInFlight: Promise<boolean> | null = null;
  const current = () => !closed && memory.isCurrent(account);
  const state = () => memory.get(account, projectId)?.feed;
  const visible = () => options.visible ? options.visible() : typeof document === "undefined" || document.visibilityState === "visible";
  const exploring = () => current() && eligible() && visible() && lastInteraction !== null && now() - lastInteraction < NAMING_EXPLORATION_IDLE_MS && !state()?.stopped;
  const scrollResumeBasis = () => {
    const record = memory.get(account, projectId), value = record?.feed, feed = value?.feed, run = feed?.activeRun, preferences = record?.preferences;
    if (starting || !current() || !eligible() || !visible() || memory.getRecovery(account) || !feed?.canResumeOnScroll || !run?.canResume
      || !["failed", "partial"].includes(run.state) || value?.status !== "incomplete" || value.stopped || value.stopRequested || value.pending || value.steering || value.stop
      || feed.ownerId !== account.userId || feed.projectId !== projectId || run.ownerId !== account.userId || run.projectId !== projectId
      || feed.paused || feed.state !== "active" || feed.availability.status !== "available" || run.projectRevision !== feed.projectRevision
      || run.preferencesVersion !== feed.preferencesVersion || run.steeringRevision !== feed.steeringRevision || run.demandSequence !== feed.demandSequence
      || !preferences?.saved || preferences.saved.preferences.version !== 2 || preferences.saved.version !== feed.preferencesVersion || preferences.status !== "saved"
      || preferences.dirty || preferences.pending || !getNamingPreferencesReadiness(preferences.saved.preferences).ready) return null;
    return JSON.stringify([run.runId, run.revision, feed.projectRevision, feed.preferencesVersion, feed.steeringRevision, feed.demandSequence]);
  };
  const prefetchBasis = () => {
    const record = memory.get(account, projectId), value = record?.feed, feed = value?.feed, run = feed?.activeRun, p = record?.preferences;
    // Saved Continue advances the head without rewriting the admitted run.
    // Its server capability and genuine membership qualify that older counter.
    if (starting || !current() || !eligible() || !visible() || memory.getRecovery(account) || !feed?.canPrefetchOnScroll || value?.status !== "ready"
      || value.stopped || value.stopRequested || value.pending || value.steering || value.stop || feed.paused || feed.state !== "active" || feed.availability.status !== "available"
      || feed.ownerId !== account.userId || feed.projectId !== projectId || !run || run.state !== "succeeded" || run.fulfillment?.status !== "complete"
      || run.ownerId !== account.userId || run.projectId !== projectId || run.projectRevision !== feed.projectRevision || run.preferencesVersion !== feed.preferencesVersion
      || run.steeringRevision !== feed.steeringRevision || run.demandSequence > feed.demandSequence
      || (run.localPipelineVersion === 2 ? !run.progressiveCompletionId : !run.preparedSetId) || p?.saved?.preferences.version !== 2
      || p.saved.version !== feed.preferencesVersion || p.status !== "saved" || p.dirty || p.pending || !getNamingPreferencesReadiness(p.saved.preferences).ready) return null;
    return JSON.stringify([run.runId, run.revision, feed.projectRevision, feed.preferencesVersion, feed.steeringRevision, feed.demandSequence]);
  };
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
    if (old?.retentionRevision !== undefined && feed.retentionRevision !== undefined && feed.retentionRevision < old.retentionRevision) return false;
    if (old && (feed.steeringRevision < old.steeringRevision || feed.projectRevision < old.projectRevision || feed.preferencesVersion < old.preferencesVersion || feed.demandSequence < old.demandSequence)) return false;
    update(value => {
      const stopped = feed.paused || value.stop !== null || value.stopRequested ? true : old === null && (feed.demandSequence > 0 || feed.activeRun !== null || rows.some(row => row.runId !== null)) && feed.state === "active" && !value.stopRequested ? false : value.stopped;
      const pending = value.pending, run = feed.activeRun;
      const matches = Boolean(pending && run && run.projectRevision === pending.expectedProjectRevision && run.preferencesVersion === pending.expectedPreferencesVersion && run.steeringRevision === pending.expectedSteeringRevision && run.demandSequence === pending.expectedDemandSequence + (pending.reason === "resume" ? 1 : 0) && (pending.reason !== "resume" || run.resumedFromRunId === pending.resumeOfRunId) && JSON.stringify(feed.consumedThrough) === JSON.stringify(pending.consumedThrough));
      const readAcknowledgement = !feed.paused && matches;
      const acknowledged = value.acknowledged || readAcknowledgement;
      const acknowledgedRunId = value.acknowledgedRunId ?? (acknowledged && matches ? run!.runId : null);
      // A cross-tab Stop can finish a request already acknowledged by this tab.
      // Retire only its bound terminal run; an unknown intent remains protected.
      const settledWhilePaused = Boolean(value.acknowledged && pending && run && feed.paused && terminal(run.state) && acknowledgedRunId === run.runId);
      return { ...value, feed, stopped, pending: settledWhilePaused ? null : pending,
        acknowledged: settledWhilePaused ? false : acknowledged, acknowledgedRunId: settledWhilePaused ? null : acknowledgedRunId, entries: mergeNamingFeedEntries(value.entries, rows),
        status: pending && !acknowledged ? value.status : active(run?.state) ? "pending" : terminal(run?.state) && ["partial", "failed", "cancelled", "needs_reconciliation"].includes(run!.state) ? "incomplete" : feed.state === "blocked" ? "blocked" : stopped ? "paused" : "ready" };
    });
    const receivedThrough = cursorOf(rows.at(-1));
    if (receivedThrough && receivedThrough.position > (loadedThrough?.position ?? 0)) loadedThrough = receivedThrough;
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
    update(value => ({ ...value, pending: intent, acknowledged: value.pending?.idempotencyKey === intent.idempotencyKey && value.acknowledged, acknowledgedRunId: value.pending?.idempotencyKey === intent.idempotencyKey ? value.acknowledgedRunId : null, directionEpoch: direction, status: "pending", error: null }));
    try {
      const result = namingFeedEnsureResultSchema.parse(await request(`${base}/feed/ensure`, namingFeedEnsureResultSchema, { method: "POST", body: intent, expectedOwnerId: account.userId, signal: controller.signal }));
      if (!live(key, controller)) return false;
      if (!receive(result.feed, direction)) return Boolean(state()?.acknowledged && state()?.pending?.idempotencyKey === intent.idempotencyKey && "run" in result && state()?.feed?.activeRun?.runId === result.run.runId);
      update(value => ({ ...value, outcome: result, pending: result.status === "pending" || (result.status === "blocked" || result.status === "paused") && result.action === "retry" ? intent : null,
        directionEpoch: value.directionEpoch + 1, acknowledged: result.status === "pending", acknowledgedRunId: result.status === "pending" ? result.run.runId : null, status: result.status === "appended" ? value.stopped ? "paused" : "ready" : result.status, error: null }));
      return true;
    } catch (cause) { if (live(key, controller) && state()?.directionEpoch === direction) { if (cause instanceof AccountRequestError && [400, 403, 409, 413, 422, 429].includes(cause.status)) update(value => ({ ...value, pending: null, acknowledged: false, acknowledgedRunId: null })); error(cause); } return false; }
    finally { finish(key, controller); }
  }
  function load(cursor?: NamingFeedCursor | null, delta = false): Promise<boolean> {
    const pending = readFeed(cursor, delta);
    if (!readInFlight) {
      readInFlight = pending;
      const clear = () => { if (readInFlight === pending) readInFlight = null; };
      void pending.then(clear, clear);
    }
    return pending;
  }
  async function readFeed(cursor?: NamingFeedCursor | null, delta = false): Promise<boolean> {
    if (!current()) return false;
    if (!state()) memory.setFeed(account, projectId, value => value);
    const { key, controller } = begin("feed-read"); if (!controller) return false;
    const direction = state()!.directionEpoch, depth = Math.max(loadedThrough?.position ?? 0, state()!.entries.at(-1)?.position ?? 0);
    let received = false, refreshRetained = false;
    const previous = state()?.feed;
    try {
      let next = cursor ?? null, feed: NamingFeed, rows: NamingFeedEntry[] = [], pages = 0, retentionVersion: number | undefined, consistentRetention = true;
      do {
        const query = new URLSearchParams({ limit: "100" });
        if (next) { query.set("cursorEntryId", next.entryId); query.set("cursorPosition", String(next.position)); }
        const reply = namingFeedResponseSchema.parse(await request(`${base}/feed?${query}`, namingFeedResponseSchema, { signal: controller.signal }));
        if (!live(key, controller) || state()?.directionEpoch !== direction) return false;
        own(reply.feed); feed = reply.feed;
        if (pages === 0) retentionVersion = feed.retentionRevision;
        else if (retentionVersion !== feed.retentionRevision) consistentRetention = false;
        if (next && feed.entries.some(row => row.position <= next!.position)) throw new AccountRequestError(502);
        rows = [...rows, ...feed.entries]; next = feed.nextCursor; pages += 1;
        if (pages > 200) throw new AccountRequestError(502);
      } while (!cursor && next && (rows.at(-1)?.position ?? 0) < depth);
      received = receive(feed!, direction, rows);
      if (received && !cursor && consistentRetention) refreshedRetention = feed!.retentionRevision;
      refreshRetained = received && delta && Boolean(previous && (refreshedRetention !== feed!.retentionRevision || previous.feedbackRevision !== feed!.feedbackRevision
        || previous.projectRevision !== feed!.projectRevision || previous.preferencesVersion !== feed!.preferencesVersion || previous.steeringRevision !== feed!.steeringRevision));
      if (received) update(value => ({ ...value, error: value.stop || value.steering || value.pending && !value.acknowledged ? value.error : null }));
    } catch (cause) { if (live(key, controller) && state()?.directionEpoch === direction) error(cause); }
    finally { finish(key, controller); }
    // Publish new committed rows before an older-page retention refresh finishes.
    if (refreshRetained) return load();
    const after = state();
    // This replays one acknowledged demand to expose its saved outcome; it cannot admit a new demand.
    if (received && after?.pending && after.acknowledged && !after.stop && !after.stopRequested && !after.feed?.paused && !active(after.feed?.activeRun?.state)) await ensure(after.pending);
    return received;
  }
  function intent(reason: "initial" | "scroll", consumedCursor?: NamingFeedCursor): EnsureNamingRunIntent | null {
    const value = state(), feed = value?.feed;
    if (!feed || feed.preferencesVersion < 1 || feed.availability.status !== "available" || feed.state === "blocked" || reason === "scroll" && feed.paused) return null;
    const consumedThrough = reason === "initial" ? null : consumedCursor ?? cursorOf(feed.entries.at(-1)) ?? cursorOf(value!.entries.at(-1));
    if (reason === "scroll" && !consumedThrough) return null;
    return ensureNamingRunIntentSchema.parse({ version: 1, reason, expectedProjectRevision: feed.projectRevision, expectedPreferencesVersion: feed.preferencesVersion, expectedSteeringRevision: feed.steeringRevision, expectedDemandSequence: feed.demandSequence, consumedThrough, idempotencyKey: crypto.randomUUID() });
  }
  return {
    load,
    poll() { const value = state(), cursor = loadedThrough ?? cursorOf(value?.entries.at(-1)); return value?.feed?.progressive && value.feed.retentionRevision !== undefined && cursor ? load(cursor, true) : load(); },
    activate() { closed = false; },
    configure(next: () => boolean) { eligible = next; if (!eligible()) { lastInteraction = null; consumedInteraction = interaction; } },
    interact(trustedResume = false) { if (current() && eligible() && visible()) { lastInteraction = now(); interaction += 1; const basis = trustedResume ? scrollResumeBasis() : null, prefetch = trustedResume ? prefetchBasis() : null; resumeInteraction = basis ? { sequence: interaction, basis } : null; prefetchInteraction = prefetch ? { sequence: interaction, basis: prefetch } : null; } },
    deactivate() { lastInteraction = null; consumedInteraction = interaction; resumeInteraction = null; prefetchInteraction = null; },
    async start() {
      if (!current() || !eligible() || !visible() || starting || state()?.pending || state()?.steering || state()?.stop) return false;
      starting = true;
      try {
        // A final answered preference can arrive while an ordinary poll owns the
        // read lock. Keep this explicit start alive, then verify a fresh head;
        // a reload or poll alone still cannot queue admission.
        if (readInFlight) await readInFlight;
        if (!current() || !eligible() || !visible()) return false;
        if (!await load() || !current() || !eligible() || !visible() || state()?.pending || state()?.steering || state()?.stop) return false;
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
    async demand(consumedCursor?: NamingFeedCursor | null) {
      const value = state();
      if (!exploring() || !value?.feed || memory.getRecovery(account) || interaction <= consumedInteraction || value.feed.paused) return false;
      const observed = consumedCursor && value.entries.find(row => row.entryId === consumedCursor.entryId && row.position === consumedCursor.position
        && row.entry.candidate.ownerId === account.userId && row.entry.candidate.projectId === projectId);
      if (value.feed.progressive && observed && value.feed.nextCursor && !value.steering && !value.stop && !value.stopRequested) {
        consumedInteraction = interaction;
        return load(value.feed.nextCursor);
      }
      if (value.pending || value.steering || value.stop) return false;
      const basis = scrollResumeBasis(), resumeOnScroll = Boolean(basis && resumeInteraction?.sequence === interaction && resumeInteraction.basis === basis);
      if (resumeOnScroll) {
        if (value.feed.progressive && !observed) return false;
        consumedInteraction = interaction; resumeInteraction = null;
        if (value.feed.nextCursor) return load(value.feed.nextCursor);
        return resume(value.feed.progressive && observed ? cursorOf(observed) : undefined);
      }
      if (value.status !== "ready") return false;
      if (value.feed.canPrefetchOnScroll || value.feed.progressive) {
        const prefetch = prefetchBasis();
        if (!observed || !prefetch || prefetchInteraction?.sequence !== interaction || prefetchInteraction.basis !== prefetch
          || value.entries.filter(row => row.position > observed.position).length > NAMING_PREFETCH_LOW_WATER) return false;
        consumedInteraction = interaction; prefetchInteraction = null;
        if (value.feed.nextCursor) return load(value.feed.nextCursor);
        const next = intent("scroll", cursorOf(observed)!); return next ? ensure(next) : false;
      }
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
      update(previous => ({ ...previous, directionEpoch: previous.directionEpoch + 1, steering: parsed.data, pending: null, acknowledged: false, acknowledgedRunId: null, outcome: null, error: null }));
      consumedInteraction = ++interaction; return steer(parsed.data);
    },
    async stop() { return requestStop(false); },
    async stopCurrent() { return requestStop(true); },
    dispose() { if (state()?.pending && !state()?.acknowledged) update(value => ({ ...value, status: "error", error: "This Naming request is not confirmed. Check saved names or retry the same request." })); closed = true; lastInteraction = null; resumeInteraction = null; prefetchInteraction = null; for (const [controller, key] of controllers) { controller.abort(); memory.release(key, controller); } controllers.clear(); },
  };
  async function resume(consumedCursor?: NamingFeedCursor | null) {
      const value = state(), result = value?.outcome, feed = value?.feed;
      const run = feed?.activeRun ?? (result?.status === "incomplete" ? result.run : null);
      if (!current() || !eligible() || !visible() || !feed || !run?.canResume || (feed.availability.status !== "available" && !run.canResumeSaved) || value?.pending || value?.steering || value?.stop) return false;
      const next = ensureNamingRunIntentSchema.parse({ version: 1, reason: "resume", resumeOfRunId: run.runId, expectedRunRevision: run.revision, expectedProjectRevision: feed.projectRevision, expectedPreferencesVersion: feed.preferencesVersion, expectedSteeringRevision: feed.steeringRevision, expectedDemandSequence: feed.demandSequence, consumedThrough: consumedCursor ?? cursorOf(feed.entries.at(-1)) ?? feed.consumedThrough, idempotencyKey: crypto.randomUUID() });
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
      update(value => ({ ...value, stop: null, stopConflict: false, pending: null, acknowledged: false, acknowledgedRunId: null, outcome: null, stopped: true, stopRequested: true, status: value.steering ? "error" : "paused", error: value.steering ? "Your pause is saved. Confirm the unfinished direction save before continuing." : null, directionEpoch: value.directionEpoch + 1 }));
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
      update(value => ({ ...value, steering: null, pending: null, acknowledged: false, acknowledgedRunId: null, outcome: null, stopped: reply.feed.paused, stopRequested: false, status: reply.feed.paused ? "paused" : "ready", directionEpoch: value.directionEpoch + 1, error: null }));
      memory.acknowledgeSteeringDraft(account, projectId, pending); return true;
    } catch (cause) { if (live(key, controller) && state()?.directionEpoch === direction) { if (cause instanceof AccountRequestError && [400, 403, 409, 413, 422, 429].includes(cause.status)) update(value => ({ ...value, steering: null })); error(cause); } return false; }
    finally { finish(key, controller); }
  }
}
