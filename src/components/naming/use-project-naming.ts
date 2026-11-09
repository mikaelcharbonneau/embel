"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { z } from "zod";
import { AccountRequestError } from "@/components/workspace/account-api";
import { boundedAccountRequest } from "@/components/workspace/bounded-account-request";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import type { AccountWorkspace } from "@/components/workspace/account-draft-memory";
import { accountDraftChanged } from "@/components/workspace/account-draft-memory";
import type { AccountProject } from "@/domain/project-api";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import type { NamingChatCheckpoint } from "@/domain/naming-chat-checkpoint";
import {
  importProjectNameResponseSchema, namingStrategyKey, selectProjectNameResponseSchema,
  updateNameRetentionResponseSchema, updateNamingPreferencesResponseSchema, updateNamingViewStateResponseSchema,
  type ImportProjectName, type NamingPreferences, type NamingSession, type NamingViewState, type ProjectNameEntry,
} from "@/domain/project-naming";
import { projectNamingOverviewSchema, type ProjectNamingOverview } from "@/domain/naming-jobs";

/** All private naming reads and writes share this post-response identity fence. */
export function createNamingRequestScope(account: VerifiedAccount, isCurrent: (account: VerifiedAccount) => boolean, expire: (account: VerifiedAccount) => void) {
  const controllers = new Set<AbortController>();
  let closed = false;
  const current = () => !closed && isCurrent(account);
  return {
    current,
    activate() { closed = false; },
    async request<T>(path: string, schema: z.ZodType<T>, verify: (value: T) => boolean, options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown } = {}): Promise<T | null> {
      if (!current()) return null;
      const controller = new AbortController(); controllers.add(controller);
      try {
        const response = await boundedAccountRequest(path, schema, { ...options, ...(options.method && options.method !== "GET" ? { expectedOwnerId: account.userId } : {}), signal: controller.signal });
        if (controller.signal.aborted || !current()) return null;
        if (!verify(response)) { expire(account); return null; }
        return response;
      } catch (error) {
        if (controller.signal.aborted || !current()) return null;
        if (error instanceof AccountRequestError && error.status === 401) { expire(account); return null; }
        throw error;
      } finally { controllers.delete(controller); }
    },
    dispose() { closed = true; for (const controller of controllers) controller.abort(); controllers.clear(); },
  };
}

export function namingOwned(value: { ownerId: string; projectId: string }, ownerId: string, projectId: string) {
  return value.ownerId === ownerId && value.projectId === projectId;
}

export function namingDraftBlocked(workspace: AccountWorkspace | null, account: VerifiedAccount, projectId: string): boolean {
  return !workspace || workspace.ownerId !== account.userId || workspace.generation !== account.generation || workspace.saved.id !== projectId || workspace.conflict || accountDraftChanged(workspace);
}

export function namingErrorMessage(error: unknown, retentionField?: "favorite" | "saved") {
  if (retentionField && (!(error instanceof AccountRequestError) || [408, 502, 503].includes(error.status))) {
    return retentionField === "favorite"
      ? "The favorite change could not be confirmed. Check the latest version before trying again."
      : "The change to saved names could not be confirmed. Check the latest version before trying again.";
  }
  if (error instanceof AccountRequestError) {
    if (error.status === 408) return "The naming request could not be confirmed in time. Check the latest version before trying again. Any saved request or name is retained.";
    if (error.code === "naming_history_capacity") return "This project’s naming history has reached the generation limit. Your saved names are preserved.";
    if (error.status === 404) return "These names are not available to this account.";
    if (error.status === 409) return "The project or naming workspace changed. Check the latest version before trying again. Earlier names are still retained.";
    if (error.status === 413) return "This naming request is too large. Shorten the notes or imported context before trying again.";
    if (error.status === 422) return "These naming details could not be saved. Review the fields and try again.";
    if (error.status === 429) return "The current request limit has been reached. Keep exploring saved names and try again later.";
    if (error.status === 503) return "Naming is unavailable right now. Your saved names and preferences are retained.";
    if (error.status === 502) return "The naming response could not be verified. Check the saved version before trying again.";
  }
  return "The naming workspace could not be reached. Check your connection and try again.";
}

export const initialNamingView: NamingViewState = { pane: "results", conversationOpen: true, filter: "all", query: "", visibleBatchId: null, scrollCandidateId: null, workshopCandidateId: null };

/** The conversation shows every name in one list: an older saved filter, search or batch view no longer applies. */
export function namingViewNeedsReset(view: NamingViewState) {
  return view.pane !== "results" || view.filter !== "all" || view.query !== "" || view.visibleBatchId !== null || view.workshopCandidateId !== null;
}

function mergeNames(first: ProjectNameEntry[], second: ProjectNameEntry[]) {
  const seen = new Set(first.map(entry => entry.candidate.id));
  return [...first, ...second.filter(entry => !seen.has(entry.candidate.id))];
}
const emptyWorkspace = () => null;
// Session-provider scoped, generation-fenced read cache; never browser storage.
const overviewCaches = new WeakMap<object, Map<string, ProjectNamingOverview>>();
function overviewCache(memory: object) {
  let cache = overviewCaches.get(memory);
  if (!cache) { cache = new Map(); overviewCaches.set(memory, cache); }
  return cache;
}

/** Account data remains in React/session-provider memory; this hook never uses browser storage. */
export function useProjectNaming({ account, projectId }: { account: VerifiedAccount; projectId: string }) {
  const { isCurrent, expire, drafts, namingBrainDrafts } = useAccountSession();
  const [scope] = useState(() => createNamingRequestScope(account, isCurrent, expire));
  const cache = overviewCache(drafts);
  const cacheKey = `${account.userId}:${account.generation}:${projectId}`;
  const [overview, setOverview] = useState<ProjectNamingOverview | null>(() => cache.get(cacheKey) ?? null);
  const current = useRef<ProjectNamingOverview | null>(overview);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const inFlight = useRef(false);
  const epoch = useRef(0);
  const readSequence = useRef(0);
  const importIntent = useRef<ImportProjectName | null>(null);
  const base = `/api/projects/${projectId}/naming`;
  const getWorkspace = useCallback(() => drafts.get(projectId), [drafts, projectId]);
  const workspace = useSyncExternalStore(drafts.subscribe, getWorkspace, emptyWorkspace);
  const blocked = namingDraftBlocked(workspace, account, projectId);
  const owned = useCallback((value: { ownerId: string; projectId: string }) => namingOwned(value, account.userId, projectId), [account.userId, projectId]);
  const ownedProject = useCallback((project: AccountProject) => project.id === projectId && project.owner_id === account.userId, [account.userId, projectId]);
  const publish = useCallback((next: ProjectNamingOverview) => { if (scope.current()) {
    cache.delete(cacheKey); cache.set(cacheKey, next);
    while (cache.size > 20) cache.delete(cache.keys().next().value!);
    current.current = next; setOverview(next);
  } }, [scope, cache, cacheKey]);
  const refresh = useCallback(() => setRefreshVersion(version => version + 1), []);

  const syncProject = useCallback((project: AccountProject) => {
    if (!scope.current()) return;
    const previous = drafts.get(projectId);
    if (previous?.ownerId === account.userId && previous.saved.id === projectId) {
      if (project.current_revision < previous.saved.current_revision) return;
      if (accountDraftChanged(previous) || previous.conflict) {
        drafts.set({ ...previous, generation: account.generation, conflict: previous.conflict || project.current_revision !== previous.saved.current_revision });
        return;
      }
    }
    if (!drafts.set({ ownerId: account.userId, generation: account.generation, saved: project, draft: accountProjectDraft(project), conflict: false })) throw new Error("Account draft memory is full");
  }, [account, drafts, projectId, scope]);

  useEffect(() => { scope.activate(); return () => scope.dispose(); }, [scope]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const sequence = ++readSequence.current;
      const startedEpoch = epoch.current;
      const stillCurrent = () => active && scope.current() && sequence === readSequence.current && startedEpoch === epoch.current && !inFlight.current;
      try {
        const before = current.current;
        // The project, saved choices, view and selection, including changes from another tab.
        // Generated names and their progress come from the naming feed.
        const reply = await scope.request(`${base}?limit=100`, projectNamingOverviewSchema, value => ownedProject(value.project));
        if (!reply || !stillCurrent()) return;
        if (before && reply.project.current_revision < before.project.current_revision) return;
        syncProject(reply.project); publish(reply); setReadError(null);
      } catch (error) { if (stillCurrent()) setReadError(namingErrorMessage(error)); }
      finally {
        if (active && scope.current()) timer = setTimeout(() => void poll(), 15000);
      }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [base, ownedProject, publish, refreshVersion, scope, syncProject]);

  async function mutate<T>(operation: () => Promise<T | null>, shouldRefresh = true, retentionField?: "favorite" | "saved"): Promise<T | null> {
    if (!scope.current() || inFlight.current) return null;
    inFlight.current = true; epoch.current += 1; setPending(true); setActionError(null);
    try { return await operation(); }
    catch (error) { if (scope.current()) setActionError(namingErrorMessage(error, retentionField)); return null; }
    finally {
      inFlight.current = false;
      if (scope.current()) { setPending(false); if (shouldRefresh) refresh(); }
    }
  }
  function readyForContextMutation() {
    const before = current.current;
    if (!before || namingDraftBlocked(getWorkspace(), account, projectId)) {
      if (scope.current()) setActionError("Save your Strategy changes or resolve the saved-version conflict before continuing Naming.");
      return null;
    }
    return before;
  }
  async function savePreferences(preferences: NamingPreferences, expectedVersion?: number) {
    const before = current.current; if (!before || !scope.current()) return false;
    const response = await mutate(async () => {
      const version = expectedVersion ?? before.preferences?.version ?? 0;
      const reply = await scope.request(`${base}/preferences`, updateNamingPreferencesResponseSchema, value => owned(value.session), { method: "PATCH", body: { expectedPreferencesVersion: version, preferences } });
      if (!reply) return null;
      if (reply.preferences.version !== version + 1) throw new AccountRequestError(502);
      const latest = current.current; if (latest) publish({ ...latest, ...reply });
      return reply;
    });
    return Boolean(response);
  }
  async function saveView(patch: Partial<NamingViewState>, acknowledgedSession?: NamingSession) {
    const overview = current.current;
    const before = overview && acknowledgedSession ? { ...overview, session: acknowledgedSession } : overview;
    if (!before?.session || !scope.current()) return false;
    const response = await mutate(async () => {
      const viewState = { ...before.session!.viewState, ...patch };
      const reply = await scope.request(`${base}/view`, updateNamingViewStateResponseSchema, value => owned(value.session), { method: "PATCH", body: { expectedViewRevision: before.session!.viewRevision, viewState } });
      if (!reply) return null;
      const expectedView = viewState.namingChat === undefined && reply.session.viewState.namingChat
        ? { ...viewState, namingChat: reply.session.viewState.namingChat } : viewState;
      if (reply.session.viewRevision !== before.session!.viewRevision + 1 || JSON.stringify(reply.session.viewState) !== JSON.stringify(expectedView)) throw new AccountRequestError(502);
      const latest = current.current;
      if (latest) publish({ ...latest, session: reply.session });
      return reply;
    });
    return Boolean(response);
  }
  async function saveChatProgress(checkpoint: NamingChatCheckpoint) {
    // Preference autosave owns its newer receipt independently of this overview.
    // The SQL view CAS also verifies the exact current preference version.
    const preferenceSession = namingBrainDrafts.get(account, projectId)?.preferenceSession;
    const viewSession = current.current?.session;
    const session = preferenceSession && (!viewSession || preferenceSession.viewRevision >= viewSession.viewRevision) ? preferenceSession : viewSession;
    return saveView({ namingChat: checkpoint }, session ?? undefined);
  }
  async function retain(entry: ProjectNameEntry, field: "favorite" | "saved", onAcknowledged?: (entry: ProjectNameEntry) => void) {
    if (!scope.current()) return false;
    return Boolean(await mutate(async () => {
      const body = { candidateId: entry.candidate.id, expectedRevision: entry.retention.revision, favorite: entry.retention.favorite, saved: entry.retention.saved, [field]: !entry.retention[field] };
      const reply = await scope.request(`${base}/retention`, updateNameRetentionResponseSchema, value => owned(value.entry.candidate), { method: "PATCH", body });
      if (!reply) return null;
      if (reply.entry.candidate.id !== entry.candidate.id || reply.entry.retention.revision !== entry.retention.revision + 1 || reply.entry.retention[field] !== body[field]) throw new AccountRequestError(502);
      namingBrainDrafts?.applyRetention(account, projectId, reply.entry);
      onAcknowledged?.(reply.entry);
      const latest = current.current; if (latest) publish({ ...latest, candidates: { ...latest.candidates, items: latest.candidates.items.map(item => item.candidate.id === entry.candidate.id ? reply.entry : item) } });
      return reply;
    }, true, field));
  }
  async function select(entry: ProjectNameEntry, acceptEarlierContext: boolean) {
    const before = readyForContextMutation(); if (!before) return false;
    const stale = entry.candidate.strategyKey !== namingStrategyKey(before.project.context);
    if (stale && !acceptEarlierContext) { setActionError("Acknowledge the earlier strategy context before using this name."); return false; }
    return Boolean(await mutate(async () => {
      const reply = await scope.request(`${base}/selection`, selectProjectNameResponseSchema, value => ownedProject(value.project), { method: "POST", body: { candidateId: entry.candidate.id, expectedRevision: before.project.current_revision, acceptEarlierContext } });
      if (!reply) return null;
      if (reply.project.current_revision !== before.project.current_revision + 1 || reply.currentSelection.candidate.id !== entry.candidate.id) throw new AccountRequestError(502);
      syncProject(reply.project);
      const latest = current.current; if (latest) publish({ ...latest, ...reply });
      return reply;
    }));
  }
  async function importLocal(input: Pick<ImportProjectName, "source" | "capturedContext">, onAcknowledged?: (entry: ProjectNameEntry) => void) {
    const before = readyForContextMutation(); if (!before) return false;
    if (importIntent.current && importIntent.current.source.id !== input.source.id) return false;
    importIntent.current ??= { ...input, expectedProjectRevision: before.project.current_revision, idempotencyKey: `import:${projectId}:${input.source.id}:${before.project.current_revision}` };
    const body = importIntent.current;
    return Boolean(await mutate(async () => {
      const reply = await scope.request(`${base}/imports`, importProjectNameResponseSchema, value => owned(value.entry.candidate), { method: "POST", body });
      if (!reply) return null;
      if (reply.entry.candidate.value !== input.source.value) throw new AccountRequestError(502);
      importIntent.current = null;
      onAcknowledged?.(reply.entry);
      const latest = current.current; if (latest) publish({ ...latest, candidates: { ...latest.candidates, items: mergeNames([reply.entry], latest.candidates.items) } });
      return reply;
    }));
  }
  return { overview, workspace, blocked, readError, actionError, pending, refresh, savePreferences, saveView, saveChatProgress, retain, select, importLocal };
}
