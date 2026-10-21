import { initialInferredNamingPreferences } from "@/domain/naming-language";
import { z } from "zod";
import { confirmNamingChatQuestion, initialNamingChatProgress, namingChatQuestions, type NamingChatProgress } from "./naming-chat-progress";
import { boundedAccountRequest } from "@/components/workspace/bounded-account-request";
import { AccountRequestError } from "@/components/workspace/account-api";
import { getNamingPreferencesReadiness, namingApproachSchema, namingDirectnessSchema, namingPreferencesV2Schema, type NamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import { namingPreferenceRevisionSchema, updateNamingPreferencesResponseSchema, updateNamingPreferencesSchema, type NamingPreferenceRevision, type NamingSession, type ProjectNameEntry } from "@/domain/project-naming";
import { ensureNamingRunIntentSchema, stopNamingFeedIntentSchema, steerNamingFeedIntentSchema, type EnsureNamingRunIntent, type NamingFeed, type NamingFeedEntry, type NamingFeedEnsureResult, type SteerNamingFeedIntent, type StopNamingFeedIntent } from "@/domain/naming-brain";
import { createProjectInputSchema, type ContextSnapshot, type CreateProjectInput } from "@/domain/projects";
import type { NamingChatCheckpoint } from "@/domain/naming-chat-checkpoint";

export type NamingAccount = { userId: string; generation: number };
export type NamingPreferenceDraft = {
  saved: NamingPreferenceRevision | null; draft: NamingPreferencesV2; dirty: boolean;
  pending: z.infer<typeof updateNamingPreferencesSchema> | null;
  status: "saved" | "saving" | "error" | "conflict"; error: string | null; validationError: boolean;
};
export type NamingFeedState = {
  feed: NamingFeed | null; entries: NamingFeedEntry[]; status: "loading" | "ready" | "pending" | "paused" | "blocked" | "incomplete" | "error";
  pending: EnsureNamingRunIntent | null; acknowledged: boolean; acknowledgedRunId: string | null; stop: StopNamingFeedIntent | null; stopConflict: boolean; steering: SteerNamingFeedIntent | null;
  outcome: NamingFeedEnsureResult | null; error: string | null; stopped: boolean; stopRequested: boolean; directionEpoch: number;
};
export type NamingSteeringDraft = { candidateIds: string[]; instruction: string };
const emptySteeringDraft = (): NamingSteeringDraft => ({ candidateIds: [], instruction: "" });
const hasSteeringDraft = (draft: NamingSteeringDraft) => draft.candidateIds.length > 0 || draft.instruction.trim().length > 0;
const steeringDraftSchema = z.strictObject({ candidateIds: z.array(z.uuid()).max(5).refine(ids => new Set(ids).size === ids.length), instruction: z.string().max(2000) });
export type NamingBrainRecord = { preferences: NamingPreferenceDraft | null; preferenceSession?: NamingSession; feed: NamingFeedState; steeringDraft: NamingSteeringDraft; chatProgress?: NamingChatProgress; chatProgressSource?: "saved_run" | "interaction" };
export type NamingProjectEntry = { description: string; direction: string; language: string; input: CreateProjectInput | null; projectId: string | null; error: string | null; busy: boolean };
const emptyFeed = (): NamingFeedState => ({ feed: null, entries: [], status: "loading", pending: null, acknowledged: false, acknowledgedRunId: null, stop: null, stopConflict: false, steering: null, outcome: null, error: null, stopped: true, stopRequested: false, directionEpoch: 0 });
const emptyEntry = (): NamingProjectEntry => ({ description: "", direction: "", language: "English", input: null, projectId: null, error: null, busy: false });
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function preferencesFrom(saved: NamingPreferenceRevision | null, context: ContextSnapshot): NamingPreferencesV2 {
  if (saved?.preferences.version === 2) return saved.preferences;
  return { ...initialInferredNamingPreferences(context), ...saved?.preferences, version: 2 };
}
function normalizeDraft(draft: NamingPreferencesV2) {
  return namingPreferencesV2Schema.safeParse({ ...draft, sourceLanguages: draft.sourceLanguages.filter(value => value.trim()), requiredText: draft.requiredText.filter(value => value.trim()), excludedText: draft.excludedText.filter(value => value.trim()) });
}
// Recovery permits unfinished input; only the domain schema can authorize a save.
const recoveryDraftSchema = z.strictObject({ version: z.literal(2), creativeLocale: z.string().max(30), notes: z.string().max(2000), minimumGraphemes: z.number().finite().nullable(), maximumGraphemes: z.number().finite().nullable(), approaches: z.array(namingApproachSchema).max(11), directness: namingDirectnessSchema.nullable(), sourceLanguages: z.array(z.string().max(960)).max(961), heritageNotes: z.string().max(2000), culturalNotes: z.string().max(2000), requiredText: z.array(z.string().max(3200)).max(3201), excludedText: z.array(z.string().max(3200)).max(3201) });
const recoverySchema = z.strictObject({ version: z.literal(1), ownerId: z.uuid(), projects: z.array(z.strictObject({ projectId: z.uuid(),
  preferences: z.strictObject({ saved: namingPreferenceRevisionSchema.nullable(), draft: recoveryDraftSchema, pending: updateNamingPreferencesSchema.nullable() }).nullable(),
  steeringDraft: steeringDraftSchema.default(emptySteeringDraft),
  pending: ensureNamingRunIntentSchema.nullable(), acknowledged: z.boolean(), acknowledgedRunId: z.uuid().nullable().default(null), stop: stopNamingFeedIntentSchema.nullable().default(null), stopConflict: z.boolean().default(false), stopRequested: z.boolean().default(false), steering: steerNamingFeedIntentSchema.nullable(),
})).max(20), creation: z.strictObject({ description: z.string().max(3000), direction: z.string().max(1000), language: z.string().max(80), input: createProjectInputSchema.nullable(), projectId: z.uuid().nullable() }).nullable() });
type Recovery = z.infer<typeof recoverySchema>;
const RECOVERY_LIMIT = 262_144;

/** Account-session-owned memory. A bounded tab recovery copy is never an account save. */
export function createNamingBrainMemory(options: { request?: typeof boundedAccountRequest; storage?: () => Pick<Storage, "getItem" | "setItem" | "removeItem"> | null; debounceMs?: number } = {}) {
  const request = options.request ?? boundedAccountRequest;
  const storage = options.storage ?? (() => { try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; } });
  let owner: string | null = null, verified: NamingAccount | null = null, recovery: Recovery | null = null;
  let entry = emptyEntry();
  const records = new Map<string, NamingBrainRecord>(), listeners = new Set<() => void>();
  const operations = new Map<string, AbortController>(), timers = new Map<string, ReturnType<typeof setTimeout>>(), saves = new Map<string, Promise<boolean>>();
  let unauthorized: ((account: NamingAccount) => void) | null = null;
  const current = (account: NamingAccount) => verified?.userId === account.userId && verified.generation === account.generation;
  const key = (id: string) => `embel.naming-recovery.v1:${id}`;
  const get = (account: NamingAccount, projectId: string) => current(account) ? records.get(projectId) ?? null : null;
  function persist() {
    if (!owner || recovery) return;
    const projects: Recovery["projects"] = [];
    for (const [projectId, record] of records) {
      const p = record.preferences, draft = p && recoveryDraftSchema.safeParse(p.draft);
      // An acknowledged run lives in the account feed. Only an uncertain intent
      // needs a browser recovery copy; keeping the ACK in memory still permits polling.
      const pending = record.feed.acknowledged ? null : record.feed.pending;
      if (!p?.dirty && !p?.pending && !pending && !record.feed.steering && !record.feed.stop && !hasSteeringDraft(record.steeringDraft)) continue;
      projects.push({ projectId, steeringDraft: record.steeringDraft, preferences: (p?.dirty || p?.pending) && draft?.success ? { saved: p.saved, draft: draft.data, pending: p.pending } : null,
        pending, acknowledged: false, acknowledgedRunId: null, stop: record.feed.stop, stopConflict: record.feed.stopConflict, stopRequested: record.feed.stopRequested, steering: record.feed.steering });
    }
    const creation = !entry.projectId && (entry.input || entry.description) ? { description: entry.description, direction: entry.direction, language: entry.language, input: entry.input, projectId: entry.projectId } : null;
    try {
      if (!projects.length && !creation) storage()?.removeItem(key(owner));
      else { const body = JSON.stringify({ version: 1, ownerId: owner, projects, creation }); if (new TextEncoder().encode(body).byteLength <= RECOVERY_LIMIT && projects.length <= 20) storage()?.setItem(key(owner), body); }
    } catch { /* A recovery copy is optional; account status still comes only from the response. */ }
  }
  function publish() { persist(); listeners.forEach(listener => listener()); }
  function restoreCompletedChat(account: NamingAccount, projectId: string, record: NamingBrainRecord): NamingBrainRecord {
    const p = record.preferences, feed = record.feed.feed, run = feed?.activeRun;
    // A matching account run proves these saved choices were already submitted.
    // Defaults alone cannot prove completion, and polling must not close an Edit.
    if (recovery || record.chatProgressSource || !p?.saved || p.saved.preferences.version !== 2 || p.dirty || p.pending || p.status !== "saved"
      || !feed || !run || feed.ownerId !== account.userId || feed.projectId !== projectId || run.ownerId !== account.userId || run.projectId !== projectId
      || run.projectRevision !== feed.projectRevision || run.preferencesVersion !== p.saved.version || feed.preferencesVersion !== p.saved.version
      || !getNamingPreferencesReadiness(p.saved.preferences).ready) return record;
    const saved = p.saved.preferences;
    const chatProgress = namingChatQuestions().reduce((progress, question) => confirmNamingChatQuestion(progress, question, saved), initialNamingChatProgress(saved));
    return { ...record, chatProgress, chatProgressSource: "saved_run" };
  }
  function replace(account: NamingAccount, projectId: string, update: (record: NamingBrainRecord) => NamingBrainRecord) {
    if (!current(account)) return;
    const record = update(records.get(projectId) ?? { preferences: null, feed: emptyFeed(), steeringDraft: emptySteeringDraft() });
    records.set(projectId, restoreCompletedChat(account, projectId, record)); publish();
  }
  function stopOperations() {
    for (const timer of timers.values()) clearTimeout(timer); timers.clear();
    for (const controller of operations.values()) controller.abort(); operations.clear(); saves.clear();
    for (const [projectId, record] of records) {
      const p = record.preferences;
      records.set(projectId, { ...record, preferences: p && p.status === "saving" ? { ...p, status: "error", error: "Verify the saved choices, then retry this same save. Your latest edits are kept." } : p,
        feed: record.feed.pending && !record.feed.acknowledged || record.feed.steering || record.feed.stop ? { ...record.feed, status: "error", error: "This Naming request is not confirmed. Check saved names or retry the same request." } : record.feed });
    }
    if (entry.busy) entry = { ...entry, busy: false, error: "This project save is not confirmed. Continue to retry the same project." };
  }
  function acquire(account: NamingAccount, operation: string) {
    if (!current(account) || operations.has(operation)) return null;
    const controller = new AbortController(); operations.set(operation, controller); return controller;
  }
  const operationCurrent = (account: NamingAccount, operation: string, controller: AbortController) => current(account) && !controller.signal.aborted && operations.get(operation) === controller;
  function release(operation: string, controller: AbortController) { if (operations.get(operation) === controller) operations.delete(operation); }
  function schedule(account: NamingAccount, projectId: string) {
    const timer = timers.get(projectId); if (timer) clearTimeout(timer);
    const p = get(account, projectId)?.preferences;
    if (!p?.dirty || p.status === "conflict" || p.status === "error" || saves.has(projectId) || recovery) return;
    timers.set(projectId, setTimeout(() => { timers.delete(projectId); void flushPreferences(account, projectId); }, options.debounceMs ?? 450));
  }
  async function saveOne(account: NamingAccount, projectId: string) {
    const p = get(account, projectId)?.preferences; if (!p) return false;
    const parsed = normalizeDraft(p.draft);
    if (!p.pending && !parsed.success) {
      replace(account, projectId, record => ({ ...record, preferences: { ...record.preferences!, status: "error", validationError: true, error: "Check language, length and optional text fields. Your edits are kept here." } })); return false;
    }
    const pending = p.pending ?? { expectedPreferencesVersion: p.saved?.version ?? 0, preferences: parsed.success ? parsed.data : p.draft };
    const operation = `preferences:${projectId}`, controller = acquire(account, operation); if (!controller) return false;
    replace(account, projectId, record => ({ ...record, preferences: { ...record.preferences!, pending, status: "saving", error: null, validationError: false } }));
    try {
      const reply = await request(`/api/projects/${projectId}/naming/preferences`, updateNamingPreferencesResponseSchema, { method: "PATCH", body: pending, expectedOwnerId: account.userId, signal: controller.signal });
      if (!operationCurrent(account, operation, controller)) return false;
      if (reply.session.ownerId !== account.userId || reply.session.projectId !== projectId || reply.preferences.ownerId !== account.userId || reply.preferences.projectId !== projectId || reply.preferences.version !== pending.expectedPreferencesVersion + 1 || !equal(reply.preferences.preferences, pending.preferences)) throw new AccountRequestError(502);
      replace(account, projectId, record => {
        const previous = record.preferences!, newest = normalizeDraft(previous.draft);
        const dirty = !newest.success || !equal(newest.data, pending.preferences);
        return { ...record, preferenceSession: reply.session, preferences: { ...previous, saved: reply.preferences, pending: null, dirty, status: dirty ? "saving" : "saved", error: null } };
      }); return true;
    } catch (error) {
      if (!operationCurrent(account, operation, controller)) return false;
      const conflict = error instanceof AccountRequestError && error.status === 409;
      const definitive = error instanceof AccountRequestError && [400, 401, 403, 413, 422, 429].includes(error.status);
      replace(account, projectId, record => ({ ...record, preferences: { ...record.preferences!, pending: definitive ? null : pending, status: conflict ? "conflict" : "error", error: conflict ? "Naming choices changed in another session. Your edits are kept. Check the saved choices before continuing." : "Your Naming choices could not be confirmed as saved. Retry this save; your latest edits are kept." } }));
      if (error instanceof AccountRequestError && error.status === 401) unauthorized?.(account);
      return false;
    } finally { release(operation, controller); }
  }
  async function flushPreferences(account: NamingAccount, projectId: string, retry = false): Promise<boolean> {
    const timer = timers.get(projectId); if (timer) clearTimeout(timer); timers.delete(projectId);
    const active = saves.get(projectId);
    if (active) { if (!await active) return false; return flushPreferences(account, projectId, retry); }
    const p = get(account, projectId)?.preferences;
    if (!p || recovery || p.status === "conflict" || p.status === "error" && !retry) return false;
    if (!p.dirty && !p.pending) return true;
    const task = saveOne(account, projectId); saves.set(projectId, task);
    const ok = await task;
    if (saves.get(projectId) === task) saves.delete(projectId);
    if (!ok || !current(account)) return false;
    return flushPreferences(account, projectId);
  }
  return {
    bind(account: NamingAccount | null) {
      if (account && current(account)) return;
      stopOperations();
      if (account && owner !== account.userId) {
        if (owner) try { storage()?.removeItem(key(owner)); } catch {}
        records.clear(); entry = emptyEntry(); recovery = null; owner = account.userId;
        try {
          const raw = storage()?.getItem(key(owner));
          if (raw && new TextEncoder().encode(raw).byteLength <= RECOVERY_LIMIT) {
            const parsed = recoverySchema.safeParse(JSON.parse(raw));
            if (parsed.success && parsed.data.ownerId === owner && parsed.data.projects.every(item => !item.preferences?.saved || item.preferences.saved.ownerId === owner && item.preferences.saved.projectId === item.projectId)) {
              const projects = parsed.data.projects.map(item => ({ ...item, pending: item.acknowledged ? null : item.pending, acknowledged: false, acknowledgedRunId: null }))
                .filter(item => item.preferences || item.pending || item.stop || item.steering || hasSteeringDraft(item.steeringDraft));
              const creation = parsed.data.creation?.projectId ? null : parsed.data.creation;
              recovery = projects.length || creation ? { ...parsed.data, projects, creation } : null;
              if (recovery && !equal(recovery, parsed.data)) {
                const body = JSON.stringify(recovery);
                if (new TextEncoder().encode(body).byteLength <= RECOVERY_LIMIT) storage()?.setItem(key(owner), body);
              }
            }
          }
        } catch {}
      }
      verified = account ? { ...account } : null; publish();
    },
    setUnauthorized(handler: (account: NamingAccount) => void) { unauthorized = handler; },
    isCurrent: current, get, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    acquire, release, operationCurrent,
    getRecovery: (account: NamingAccount) => current(account) ? recovery : null,
    recover(account: NamingAccount) {
      if (!current(account) || !recovery) return;
      for (const item of recovery.projects) {
        const previous = records.get(item.projectId), unfinished = Boolean(item.stop || item.steering || item.pending && !item.acknowledged);
        records.set(item.projectId, { ...(previous?.chatProgress ? { chatProgress: previous.chatProgress, chatProgressSource: previous.chatProgressSource } : {}), steeringDraft: item.steeringDraft, preferences: item.preferences ? { ...item.preferences, dirty: true, status: "error", error: "Recovered unsaved Naming choices. Confirm this save to continue.", validationError: false } : previous?.preferences ?? null,
          feed: { ...(previous?.feed ?? emptyFeed()), pending: item.pending, acknowledged: item.acknowledged, acknowledgedRunId: item.acknowledgedRunId, stop: item.stop, stopConflict: item.stopConflict, stopped: true, stopRequested: item.stopRequested, steering: item.steering, directionEpoch: (previous?.feed.directionEpoch ?? 0) + 1,
            status: unfinished ? "error" : "paused", error: unfinished ? "Recovered an unfinished Naming request. Retry the same request to confirm its saved state." : null } });
      }
      if (recovery.creation) entry = { ...recovery.creation, error: "Recovered an unfinished request. Continue to confirm this same project.", busy: false };
      recovery = null; publish();
    },
    discardRecovery(account: NamingAccount) { if (current(account)) { recovery = null; publish(); } },
    connectPreferences(account: NamingAccount, projectId: string, saved: NamingPreferenceRevision | null, context: ContextSnapshot, checkpoint?: NamingChatCheckpoint) {
      if (!current(account) || saved && (saved.ownerId !== account.userId || saved.projectId !== projectId)) return;
      const previous = get(account, projectId)?.preferences;
      if (previous && (saved?.version ?? 0) < (previous.saved?.version ?? 0)) return;
      if (previous && equal(previous.saved, saved) && get(account, projectId)?.chatProgress) return;
      replace(account, projectId, currentRecord => {
        const record = { ...currentRecord, chatProgress: currentRecord.chatProgress ?? initialNamingChatProgress(saved?.preferences.version === 2 ? saved.preferences : null, checkpoint, saved?.version) };
        const p = record.preferences;
        if (!p || !p.dirty && !p.pending) return { ...record, preferences: { saved, draft: preferencesFrom(saved, context), dirty: false, pending: null, status: "saved", error: null, validationError: false } };
        if (p.pending && saved?.version === p.pending.expectedPreferencesVersion + 1 && equal(saved.preferences, p.pending.preferences)) {
          const parsed = normalizeDraft(p.draft), dirty = !parsed.success || !equal(parsed.data, saved.preferences);
          return { ...record, preferences: { ...p, saved, pending: null, dirty, status: dirty ? "saving" : "saved", error: null } };
        }
        if ((saved?.version ?? 0) !== (p.saved?.version ?? 0)) return { ...record, preferences: { ...p, saved, status: "conflict", error: "A different version of your Naming choices is saved. Your edits and pending request are kept." } };
        return record;
      });
      schedule(account, projectId);
    },
    editPreferences(account: NamingAccount, projectId: string, draft: NamingPreferencesV2) {
      const p = get(account, projectId)?.preferences; if (!p || recovery) return;
      replace(account, projectId, record => ({ ...record, chatProgressSource: "interaction", preferences: { ...record.preferences!, draft, dirty: true, status: p.status === "conflict" || p.status === "error" && !p.validationError ? p.status : "saving", error: p.validationError ? null : p.error, validationError: false } }));
      schedule(account, projectId);
    },
    flushPreferences,
    setChatProgress(account: NamingAccount, projectId: string, progress: NamingChatProgress) {
      if (!get(account, projectId)?.preferences || recovery) return;
      replace(account, projectId, record => ({ ...record, chatProgress: { ...progress, confirmed: { ...progress.confirmed } }, chatProgressSource: "interaction" }));
    },
    resolvePreferences(account: NamingAccount, projectId: string, keepEdits: boolean) {
      const p = get(account, projectId)?.preferences; if (!p?.saved) return;
      replace(account, projectId, record => ({ ...record, preferences: { ...p, draft: keepEdits ? p.draft : preferencesFrom(p.saved, { creativeLocale: p.draft.creativeLocale, intake: { namingNotes: p.draft.notes } } as ContextSnapshot), pending: null, dirty: keepEdits, status: keepEdits ? "saving" : "saved", error: null } }));
      if (keepEdits) schedule(account, projectId);
    },
    setSteeringDraft(account: NamingAccount, projectId: string, update: (draft: NamingSteeringDraft) => NamingSteeringDraft) {
      const record = get(account, projectId); if (!record || recovery) return false;
      const parsed = steeringDraftSchema.safeParse(update(record.steeringDraft)); if (!parsed.success) return false;
      const known = new Set([...record.steeringDraft.candidateIds, ...record.feed.entries.filter(row => row.entry.candidate.ownerId === account.userId && row.entry.candidate.projectId === projectId).map(row => row.entry.candidate.id)]);
      if (parsed.data.candidateIds.some(id => !known.has(id))) return false;
      replace(account, projectId, value => ({ ...value, steeringDraft: parsed.data })); return true;
    },
    acknowledgeSteeringDraft(account: NamingAccount, projectId: string, intent: SteerNamingFeedIntent) {
      const draft = get(account, projectId)?.steeringDraft;
      if (draft && equal(draft.candidateIds, intent.candidateIds) && draft.instruction.trim() === (intent.instruction ?? "")) replace(account, projectId, value => ({ ...value, steeringDraft: emptySteeringDraft() }));
    },
    setFeed(account: NamingAccount, projectId: string, update: (feed: NamingFeedState) => NamingFeedState) { replace(account, projectId, record => ({ ...record, feed: update(record.feed) })); },
    applyRetention(account: NamingAccount, projectId: string, next: ProjectNameEntry) {
      if (next.candidate.ownerId !== account.userId || next.candidate.projectId !== projectId) return;
      replace(account, projectId, record => ({ ...record, feed: { ...record.feed, entries: record.feed.entries.map(item => item.entry.candidate.id === next.candidate.id && item.entry.retention.revision <= next.retention.revision ? { ...item, entry: next } : item) } }));
    },
    startAnotherEntry(account: NamingAccount) { if (!current(account) || !entry.projectId || entry.busy) return false; entry = emptyEntry(); publish(); return true; },
    getEntry: (account: NamingAccount) => current(account) ? entry : null,
    setEntry(account: NamingAccount, update: (value: NamingProjectEntry) => NamingProjectEntry) { if (current(account)) { entry = update(entry); publish(); } },
    hasUnsaved: () => Boolean(recovery || entry.input && !entry.projectId || entry.description && !entry.projectId || [...records.values()].some(record => record.preferences?.dirty || record.preferences?.pending || record.feed.pending && !record.feed.acknowledged || record.feed.steering || record.feed.stop || hasSteeringDraft(record.steeringDraft))),
    clear() { stopOperations(); if (owner) try { storage()?.removeItem(key(owner)); } catch {} records.clear(); entry = emptyEntry(); owner = null; verified = null; recovery = null; publish(); },
  };
}
export type NamingBrainMemory = ReturnType<typeof createNamingBrainMemory>;
