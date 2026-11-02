"use client";

import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  logoBriefDraftSchema, logoStageSchema, saveLogoBriefInputSchema, saveLogoReferencesInputSchema, type LogoBriefDraft, type LogoManualCommand,
  type LogoMutationReceipt, type LogoReferenceSnapshot, type LogoReferenceSelection, type LogoStage, type LogoStageRevision, type LogoWorkspaceV2,
} from "@/domain/logo-workspace";
import { logoGenerationIntentSchema, type LogoGenerationIntent, type LogoRequestState } from "@/domain/logo-jobs";
import { AccountRequestError, accountErrorMessage } from "@/components/workspace/account-api";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { createAccountLogoClient, isAccountLogoClientCurrent, AccountLogoInitializationRejectedError, type AccountLogoClient } from "./account-logo-client";
import type { LogoDraftMemory, LogoDraftRecord } from "./logo-draft-memory";
import { isExistingBrandLogoReceipt } from "@/features/logo-creation/model/existing-brand";

type Payloads = Partial<{ [S in LogoStage]: LogoStageRevision<S> }>;
type Scope = { ownerId: string; generation: number; projectId: string | null; memory: LogoDraftMemory; injected?: AccountLogoClient };
const sameScope = (a: Scope, b: Scope) => a.ownerId === b.ownerId && a.generation === b.generation && a.projectId === b.projectId && a.memory === b.memory && a.injected === b.injected;
type Activity = { scope: Scope; busy: boolean; error: string | null; failed: boolean; editableSave?: boolean };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const unresolved = (record: LogoDraftRecord) => !!(record.pendingIntent || record.pendingCreation || record.pendingExport || record.pendingMutation);
const empty = (): LogoDraftRecord => ({ workspace: null, base: null, brief: { name: "", activity: "", audience: "", personality: "", logoTypes: [] }, references: [], dirty: false,
  pendingIntent: null, pendingCreation: null, pendingExport: null, pendingMutation: null, conflict: false });
const briefOf = (revision: LogoStageRevision<"brief_references"> | undefined): LogoBriefDraft => {
  if (!revision) throw new AccountRequestError(503);
  const { name, activity, audience, personality, logoTypes } = revision.payload;
  return { name, activity, audience, personality, logoTypes };
};

export type LogoWorkspaceReloadResult = "reloaded" | "draft_blocked" | "unavailable";
export const LOGO_AUTOSAVE_DELAY_MS = 650;
export const LOGO_SAVE_TIMEOUT_MS = 30_000;

export type LogoWorkspaceBaseline = {
  workspace: LogoWorkspaceV2; stagePayloads: Payloads; referenceSnapshot: LogoReferenceSnapshot | null;
  brief: LogoBriefDraft; references: LogoReferenceSelection[];
};
const selectionsOf = (snapshot: LogoReferenceSnapshot): LogoReferenceSelection[] => snapshot.references.map(({ referenceId, aspects }) => ({ referenceId, aspects }));
const sameSelections = (a: LogoReferenceSelection[], b: LogoReferenceSelection[]) => {
  const canonical = (rows: LogoReferenceSelection[]) => rows.map(row => [row.referenceId, [...row.aspects].sort()]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return same(canonical(a), canonical(b));
};
async function readBaseline(source: AccountLogoClient, workspace: LogoWorkspaceV2, signal: AbortSignal, current: () => boolean): Promise<LogoWorkspaceBaseline | null> {
  if (!current()) return null;
  const entries = await Promise.all(logoStageSchema.options.map(async stage => {
    const ref = workspace.stages[stage]; if (!ref) return null;
    const revision = await source.getLogoStageRevision(stage, ref.id, signal);
    if (!revision) return null;
    if (revision.ownerId !== workspace.ownerId || revision.projectId !== workspace.projectId || revision.id !== ref.id || revision.stage !== stage || revision.revision !== ref.revision) throw new AccountRequestError(502);
    return [stage, revision] as const;
  }));
  if (!current() || entries.some((entry, index) => workspace.stages[logoStageSchema.options[index]!] !== null && entry === null)) return null;
  const stagePayloads = Object.fromEntries(entries.filter(entry => entry !== null)) as Payloads;
  const stage = stagePayloads.brief_references;
  if (!stage) {
    // An owned saved brand can have no V2 stages yet. Reading it is not a
    // mutation: retain its exact current heads and allow explicit first save.
    if (Object.keys(stagePayloads).length || workspace.heads.workspaceRevision !== 0) throw new AccountRequestError(503);
    return { workspace, stagePayloads, referenceSnapshot: null, brief: empty().brief, references: [] };
  }
  const referenceSnapshot = await source.readLogoReferenceSnapshot(stage.payload.referenceSnapshotId, signal);
  if (!referenceSnapshot || !current()) return null;
  if (referenceSnapshot.id !== stage.payload.referenceSnapshotId || referenceSnapshot.ownerId !== workspace.ownerId || referenceSnapshot.projectId !== workspace.projectId) throw new AccountRequestError(502);
  return { workspace, stagePayloads, referenceSnapshot, brief: briefOf(stage), references: selectionsOf(referenceSnapshot) };
}

/** Actual hook loader, independently testable without a second store or React mock. */
export async function loadLogoWorkspaceBaseline({ client, account, projectId, memory, signal, isCurrent = () => true }: {
  client: AccountLogoClient; account: VerifiedAccount; projectId: string; memory: LogoDraftMemory; signal: AbortSignal; isCurrent?: () => boolean;
}): Promise<LogoWorkspaceBaseline | null> {
  const captured = memory.get(projectId);
  const current = () => !signal.aborted && isCurrent() && isAccountLogoClientCurrent(client, account, projectId) && memory.get(projectId) === captured;
  if (!current()) return null;
  const workspace = await client.getLogoWorkspace(signal);
  if (!workspace || !current()) return null;
  return readBaseline(client, workspace, signal, current);
}

/** Root binds memory synchronously with account state. No feature-local draft store. */
export function useLogoWorkspace({ projectId: routeProjectId, memory, client: injected }: { projectId?: string; memory: LogoDraftMemory; client?: AccountLogoClient }) {
  const projectId = routeProjectId ?? null;
  const { session, isCurrent, expire } = useAccountSession();
  const account = session.status === "ready" ? session : null;
  const [transport, setTransport] = useState<{ scope: Scope; client: AccountLogoClient } | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [payloads, setPayloads] = useState<{ scope: Scope; baseline: LogoWorkspaceBaseline } | null>(null);
  const [created, setCreated] = useState<{ scope: Scope; workspace: LogoWorkspaceV2; pendingCreation: LogoDraftRecord["pendingCreation"] } | null>(null);
  const operation = useRef<{ controller: AbortController; scope: Scope; editableSave: boolean } | null>(null);
  const scope = account ? { ownerId: account.userId, generation: account.generation, projectId, memory, injected } : null;
  const committedScope = useRef<Scope | null>(null);
  const client = account && scope && transport && sameScope(transport.scope, scope) && isCurrent(account) && isAccountLogoClientCurrent(transport.client, account, projectId) ? transport.client : null;
  const snapshot = useCallback(() => account && isCurrent(account) ? memory.get(projectId) : null, [account, isCurrent, memory, projectId]);
  const record = useSyncExternalStore(memory.subscribe, snapshot, () => null);
  const proposal = useSyncExternalStore(memory.subscribe, () => projectId ? memory.getVectorProposal(projectId) : null, () => null);
  const visible = !!(account && isCurrent(account));
  const busy = !!(visible && scope && activity && sameScope(activity.scope, scope) && activity.busy);
  const saving = busy && activity?.editableSave === true;
  const completed = visible && scope && created && sameScope(created.scope, scope) ? created : null;

  useLayoutEffect(() => {
    const captured: Scope | null = account ? { ownerId: account.userId, generation: account.generation, projectId, memory, injected } : null;
    committedScope.current = captured;
    return () => {
      if (committedScope.current === captured) committedScope.current = null;
      operation.current?.controller.abort(); operation.current = null;
    };
  }, [account, injected, memory, projectId]);

  useEffect(() => {
    if (!account || !isCurrent(account)) return;
    // Effect-owned construction survives React Strict Mode's setup/cleanup cycle.
    // An injected client must have actual factory provenance; its creator owns it.
    const candidate = injected ?? createAccountLogoClient(account, projectId, isCurrent, expire);
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || !isCurrent(account)) return;
      if (!isAccountLogoClientCurrent(candidate, account, projectId)) {
        setActivity({ scope: { ownerId: account.userId, generation: account.generation, projectId, memory, injected }, busy: false, failed: true, error: "The logo client is unavailable for this verified account." });
        return;
      }
      setTransport({ scope: { ownerId: account.userId, generation: account.generation, projectId, memory, injected }, client: candidate });
    });
    return () => {
      cancelled = true; operation.current?.controller.abort(); operation.current = null;
      if (!injected) candidate.dispose();
    };
  }, [account, expire, injected, isCurrent, memory, projectId]);

  const perform = useCallback(async (work: (client: AccountLogoClient, signal: AbortSignal, current: () => boolean, account: VerifiedAccount) => Promise<void>, { editableSave = false, bounded = false }: { editableSave?: boolean; bounded?: boolean } = {}) => {
    if (!account || !client || !isCurrent(account) || operation.current) return;
    const capturedScope = { ownerId: account.userId, generation: account.generation, projectId, memory, injected };
    if (!committedScope.current || !sameScope(committedScope.current, capturedScope)) return;
    const token = { controller: new AbortController(), scope: capturedScope, editableSave }; operation.current = token;
    const current = () => operation.current === token && committedScope.current !== null && sameScope(committedScope.current, capturedScope) && !token.controller.signal.aborted && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId);
    let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
    setActivity({ scope: capturedScope, busy: true, error: null, failed: false, editableSave });
    try {
      const result = work(client, token.controller.signal, current, account);
      if (editableSave || bounded) await Promise.race([result, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { timedOut = true; reject(new AccountRequestError(408)); }, LOGO_SAVE_TIMEOUT_MS);
      })]);
      else await result;
    }
    catch (error) {
      if (current()) {
        const value = memory.get(projectId);
        if (value && error instanceof AccountRequestError && error.status === 409) memory.set(projectId, { ...value, conflict: true });
        setActivity({ scope: capturedScope, busy: false, error: error instanceof AccountRequestError && error.status === 409
          ? value && unresolved(value) ? "Saved inputs changed. Your draft and original request remain here. Check the request before reloading."
            : "Saved inputs changed. Your draft is still here. Explicitly discard and reload the latest saved brand before trying again."
          : accountErrorMessage(error), failed: true });
      }
    } finally {
      clearTimeout(timer);
      if (operation.current === token) {
        operation.current = null;
        if (!token.controller.signal.aborted && isCurrent(account)) setActivity(value => value && sameScope(value.scope, capturedScope) ? { ...value, busy: false } : value);
      }
      // The original save may have committed. Keep its immutable pending intent
      // while stopping transport and rejecting any late acknowledgement.
      if (timedOut) token.controller.abort();
    }
  }, [account, client, injected, isCurrent, memory, projectId]);

  const reload = useCallback(async (discard: boolean): Promise<LogoWorkspaceReloadResult> => {
    let result: LogoWorkspaceReloadResult = "unavailable";
    await perform(async (source, signal, current, verified) => {
      const previous = memory.get(projectId);
      if (previous && (previous.dirty || previous.vectorDraft || previous.directionDraft || previous.conflict || unresolved(previous) || projectId && memory.getVectorProposal(projectId) && (memory.getVectorProposal(projectId)!.dirty || memory.getVectorProposal(projectId)!.pendingGeneration || memory.getVectorProposal(projectId)!.pendingApplication)) && !discard) { result = "draft_blocked"; return; }
      if (projectId === null) { if (current()) { memory.set(null, empty()); setCreated(null); result = "reloaded"; } return; }
      const baseline = await loadLogoWorkspaceBaseline({ client: source, account: verified, projectId, memory, signal, isCurrent: current });
      if (!baseline || !current() || memory.get(projectId) !== previous) return;
      memory.set(projectId, { ...empty(), workspace: baseline.workspace, base: baseline.workspace.heads, brief: baseline.brief, references: baseline.references });
      setPayloads({ scope: { ownerId: verified.userId, generation: verified.generation, projectId, memory, injected }, baseline });
      result = "reloaded";
    });
    return result;
  }, [injected, memory, perform, projectId]);

  useEffect(() => {
    if (!account || !client || !isCurrent(account)) return;
    const timer = setTimeout(() => {
      const value = memory.get(projectId);
      if (!value || !value.dirty && !value.vectorDraft && !value.directionDraft && !value.conflict && !unresolved(value) && !(projectId && memory.getVectorProposal(projectId) && (memory.getVectorProposal(projectId)!.dirty || memory.getVectorProposal(projectId)!.pendingGeneration || memory.getVectorProposal(projectId)!.pendingApplication))) { void reload(false); return; }
      if (value.workspace) void perform(async (source, signal, current, verified) => {
        const unchanged = () => current() && memory.get(projectId) === value;
        const baseline = await readBaseline(source, value.workspace!, signal, unchanged);
        if (baseline && unchanged()) setPayloads({ scope: { ownerId: verified.userId, generation: verified.generation, projectId, memory, injected }, baseline });
      });
    }, 0);
    return () => { clearTimeout(timer); };
  }, [account, client, injected, isCurrent, memory, perform, projectId, reload]);

  const editable = () => !!(scope && committedScope.current && sameScope(committedScope.current, scope) && account && client && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId) && (!operation.current || operation.current.editableSave) && !completed && (projectId === null || memory.get(projectId)));
  function edit(change: (value: LogoDraftRecord) => LogoDraftRecord) {
    if (!editable() || !scope) return;
    try {
      const previous = memory.get(projectId) ?? empty();
      memory.set(projectId, change(previous));
      // A corrected local validation failure may save automatically. Uncertain
      // requests and conflicts keep their original recovery state instead.
      if (!operation.current && !previous.conflict && !unresolved(previous)) setActivity({ scope, busy: false, error: null, failed: false });
    }
    catch (error) { setActivity({ scope, busy: false, error: accountErrorMessage(error), failed: false }); }
  }
  function setBriefDraft(brief: LogoBriefDraft): void { edit(value => ({ ...value, brief, dirty: true })); }
  function setReferenceDraft(selections: LogoReferenceSelection[]): void { edit(value => ({ ...value, references: selections, dirty: true })); }
  function retainIntent(intent: LogoGenerationIntent): void {
    if (!editable()) return;
    const parsed = logoGenerationIntentSchema.safeParse(intent);
    if (!parsed.success) throw new AccountRequestError(422);
    const value = memory.get(projectId);
    if (!value?.workspace || value.dirty || value.conflict || value.pendingMutation || value.pendingExport) throw new AccountRequestError(409);
    memory.set(projectId, { ...value, pendingIntent: parsed.data });
  }
  function clearIntent(requestKey: string): void {
    if (!editable()) return;
    const value = memory.get(projectId);
    if (value?.pendingIntent?.requestKey === requestKey) memory.set(projectId, { ...value, pendingIntent: null });
  }

  async function applyMutation(receipt: LogoMutationReceipt, source: AccountLogoClient, signal: AbortSignal, current: () => boolean) {
    const original = memory.get(projectId);
    if (!original || original.pendingMutation?.requestKey !== receipt.requestKey) return;
    const command = original.pendingMutation.command;
    if ((command.method !== "saveLogoBrief" && command.method !== "saveLogoReferences") || receipt.revision.stage !== "brief_references"
      || receipt.revision.revision !== command.body.expected.stageRevisions.brief_references + 1
      || (command.method === "saveLogoBrief" && !same(briefOf(receipt.revision), command.body.brief))) throw new AccountRequestError(502);
    if (command.method === "saveLogoBrief" && command.body.expected.stageRevisions.brief_references === 0
      && !isExistingBrandLogoReceipt(receipt, command.body)) throw new AccountRequestError(502);
    const snapshot = await source.readLogoReferenceSnapshot(receipt.revision.payload.referenceSnapshotId, signal);
    if (!snapshot || !current()) return;
    const references = selectionsOf(snapshot), brief = briefOf(receipt.revision);
    if (command.method === "saveLogoReferences" && !sameSelections(references, command.body.selections)) throw new AccountRequestError(502);
    const latest = memory.get(projectId);
    if (!latest || latest.pendingMutation?.requestKey !== receipt.requestKey || !same(latest.base, original.base)) return;
    const dirty = !same(latest.brief, brief) || !sameSelections(latest.references, references);
    memory.set(projectId, { ...latest, workspace: receipt.workspace, base: receipt.workspace.heads, pendingMutation: null, conflict: false, dirty });
    if (scope) setPayloads(value => ({ scope, baseline: { workspace: receipt.workspace, referenceSnapshot: snapshot, brief, references,
      stagePayloads: { ...(value && sameScope(value.scope, scope) ? value.baseline.stagePayloads : {}), [receipt.revision.stage]: receipt.revision } } }));
  }
  async function save(method: "saveLogoBrief" | "saveLogoReferences", input: LogoBriefDraft | LogoReferenceSelection[]): Promise<void> {
    let recovered = false;
    await perform(async (source, signal, current) => {
      const value = memory.get(projectId);
      if (!value?.workspace || !value.base) throw new AccountRequestError(503);
      const requestKey = value.pendingMutation?.requestKey ?? crypto.randomUUID();
      const common = { requestKey, expected: value.base };
      const parsed = method === "saveLogoBrief" ? saveLogoBriefInputSchema.safeParse({ ...common, brief: input }) : saveLogoReferencesInputSchema.safeParse({ ...common, selections: input });
      if (!parsed.success) throw new AccountRequestError(422);
      const intent: Extract<LogoManualCommand, { method: "saveLogoBrief" | "saveLogoReferences" }> = "brief" in parsed.data
        ? { method: "saveLogoBrief", body: parsed.data } : { method: "saveLogoReferences", body: parsed.data };
      if (value.pendingMutation) {
        // A confirmed original receipt can resolve retained work even when a
        // conflict or unavailable save capability prevents another write.
        if (!same(value.pendingMutation.command, intent)) throw new AccountRequestError(409);
        const known = await source.readLogoRequest(requestKey, signal); if (!known || !current()) return;
        if (known.status !== "not_found") {
          if (known.status === "succeeded" && known.receipt && "workspace" in known.receipt) {
            await applyMutation(known.receipt, source, signal, current);
            recovered = current() && !memory.get(projectId)?.pendingMutation && !memory.get(projectId)?.dirty;
          }
          // A lost tombstone acknowledgement is discoverable as failed. Only
          // this explicit exact-key retry may fetch its typed rejection proof.
          if (!(intent.method === "saveLogoBrief" && intent.body.expected.stageRevisions.brief_references === 0
            && known.status === "failed" && known.reason === "admission_rejected")) return;
        }
      }
      if (value.workspace.capabilities.save.status !== "available") throw new AccountRequestError(503);
      if (value.pendingIntent || value.pendingCreation || value.pendingExport || value.conflict) throw new AccountRequestError(409);
      if (!value.pendingMutation) {
        // Store original bodies/keys before sending. Acknowledgement alone does
        // not clear pending until its exact reference snapshot is readable.
        memory.set(projectId, { ...value, ...(intent.method === "saveLogoBrief" ? { brief: intent.body.brief } : { references: intent.body.selections }), dirty: true,
          pendingMutation: { requestKey, command: intent } });
      }
      const initializing = intent.method === "saveLogoBrief" && intent.body.expected.stageRevisions.brief_references === 0;
      let result: LogoMutationReceipt | null;
      try {
        result = intent.method === "saveLogoBrief"
          ? initializing ? await source.initializeExistingBrandLogo(intent.body, signal) : await source.saveLogoBrief(intent.body, signal)
          : await source.saveLogoReferences(intent.body, signal);
      } catch (error) {
        // Only a verified durable tombstone settles an ambiguous original.
        // Generic HTTP/SQL conflicts cannot prove it will never commit later.
        if (initializing && error instanceof AccountLogoInitializationRejectedError && current()) {
          const retained = memory.get(projectId);
          if (retained?.pendingMutation?.requestKey === requestKey) memory.set(projectId, { ...retained, pendingMutation: null, conflict: true });
        }
        if (initializing && error instanceof AccountRequestError && error.status === 409 && !(error instanceof AccountLogoInitializationRejectedError)) throw new AccountRequestError(503);
        throw error;
      }
      if (result && current()) {
        await applyMutation(result, source, signal, current);
        recovered = Boolean(value.pendingMutation) && current() && !memory.get(projectId)?.pendingMutation && !memory.get(projectId)?.dirty;
      }
    }, { editableSave: true });
    // A receipt is the historical commit, not proof of today's workspace head.
    // Explicit recovery may rehydrate current saved work only without local edits.
    if (recovered) await reload(false);
  }
  const saveBrief = (brief: LogoBriefDraft): Promise<void> => save("saveLogoBrief", brief);
  const saveReferences = (selections: LogoReferenceSelection[]): Promise<void> => save("saveLogoReferences", selections);
  async function checkPendingSave(): Promise<LogoRequestState | null> {
    let state: LogoRequestState | null = null;
    await perform(async (source, signal, current) => {
      const pending = memory.get(projectId)?.pendingMutation;
      if (!pending || !["saveLogoBrief", "saveLogoReferences"].includes(pending.command.method)) return;
      state = await source.readLogoRequest(pending.requestKey, signal);
      if (!state || !current()) { state = null; return; }
      if (state.status === "succeeded" && state.receipt && "workspace" in state.receipt) await applyMutation(state.receipt, source, signal, current);
      // In particular, not_found NEVER dispatches a mutation from this action.
    }, { bounded: true });
    return state;
  }

  function confirmCreation(value: LogoDraftRecord, workspace: LogoWorkspaceV2, verified: VerifiedAccount) {
    if (!value.pendingCreation) throw new AccountRequestError(422);
    const pendingCreation = { input: value.pendingCreation.input, state: { status: "succeeded" as const, requestKey: value.pendingCreation.input.requestKey, projectId: workspace.projectId, workspace } };
    memory.set(null, { ...value, pendingCreation });
    setCreated({ scope: { ownerId: verified.userId, generation: verified.generation, projectId: null, memory, injected }, workspace, pendingCreation });
  }
  async function startProject(brief: LogoBriefDraft): Promise<void> {
    await perform(async (source, signal, current, verified) => {
      if (projectId !== null) throw new AccountRequestError(422);
      const parsed = logoBriefDraftSchema.safeParse(brief); if (!parsed.success) throw new AccountRequestError(422);
      const previous = memory.get(null) ?? empty(); if (previous.pendingCreation) throw new AccountRequestError(409);
      const value: LogoDraftRecord = { ...previous, brief, dirty: true, pendingCreation: { input: { requestKey: crypto.randomUUID(), brief: parsed.data }, state: null } };
      memory.set(null, value);
      const result = await source.startLogoProject(value.pendingCreation!.input, signal);
      if (result && current()) confirmCreation(memory.get(null) ?? value, result, verified);
    });
  }
  async function checkCreation(retry: boolean): Promise<void> {
    await perform(async (source, signal, current, verified) => {
      if (projectId !== null) throw new AccountRequestError(422);
      const previous = memory.get(null); if (!previous?.pendingCreation) return;
      const state = await source.readLogoProjectCreation(previous.pendingCreation.input.requestKey, signal); if (!state || !current()) return;
      if (state.status === "succeeded") { confirmCreation(previous, state.workspace, verified); return; }
      const value = { ...previous, pendingCreation: { input: previous.pendingCreation.input, state } }; memory.set(null, value);
      if (!retry) return;
      // Only this explicit retry action can replay the exact original body/key.
      const result = await source.startLogoProject(value.pendingCreation.input, signal);
      if (result && current()) confirmCreation(memory.get(null) ?? value, result, verified);
    });
  }
  const checkProjectCreation = (): Promise<void> => checkCreation(false);
  const retryProjectCreation = (): Promise<void> => checkCreation(true);
  async function recoverProjectCreation(requestKey: string): Promise<void> {
    await perform(async (source, signal, current, verified) => {
      if (projectId !== null) throw new AccountRequestError(422);
      const previous = memory.get(null);
      if (previous && (previous.dirty || previous.vectorDraft || previous.directionDraft || previous.conflict || unresolved(previous))) throw new AccountRequestError(409);
      const state = await source.readLogoProjectCreation(requestKey, signal); if (!state || !current() || state.status === "not_found") return;
      // Selection comes from the owned durable creation list. No guessed newest
      // request and no automatic replay occurs when the original local key is lost.
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const summaries = await source.listLogoProjectCreations({ cursor, limit: 50 }, signal); if (!summaries || !current()) return;
        const summary = summaries.items.find(item => item.requestKey === requestKey && item.projectId === state.projectId);
        if (summary) {
          const value = { ...empty(), brief: summary.brief, pendingCreation: { input: { requestKey, brief: summary.brief }, state: null } };
          confirmCreation(value, state.workspace, verified); return;
        }
        if (!summaries.nextCursor) break;
        cursor = summaries.nextCursor;
      }
      throw new AccountRequestError(503);
    });
  }

  const error = visible && scope && activity && sameScope(activity.scope, scope) ? activity.error : null;
  const loaded = visible && scope && payloads && sameScope(payloads.scope, scope) ? payloads : null;
  const status = !visible ? "unverified" as const : record || completed || loaded ? "ready" as const : error ? "error" as const : "loading" as const;
  const workspace = visible ? completed?.workspace ?? record?.workspace ?? loaded?.baseline.workspace ?? null : null;
  const stagePayloads = !visible ? null : loaded && workspace?.heads.workspaceRevision === loaded.baseline.workspace.heads.workspaceRevision ? loaded.baseline.stagePayloads : {};
  const referenceSnapshot = loaded && workspace?.heads.workspaceRevision === loaded.baseline.workspace.heads.workspaceRevision ? loaded.baseline.referenceSnapshot : null;
  const autoSaveReady = Boolean(projectId && visible && client && !busy && !error && record?.dirty && !record.conflict && !unresolved(record)
    && !record.vectorDraft && !record.directionDraft && !proposal?.dirty && !proposal?.pendingGeneration && !proposal?.pendingApplication
    && record.workspace?.stages.brief_references && record.workspace.capabilities.save.status === "available"
    && loaded && same(record.base, loaded.baseline.workspace.heads) && logoBriefDraftSchema.safeParse(record.brief).success);
  const saveAutomatic = useEffectEvent(async () => {
    const value = memory.get(projectId), baseline = loaded?.baseline;
    if (!autoSaveReady || !value || value !== record || !baseline) return;
    // Each acknowledged receipt advances the baseline. A newer brief or
    // reference edit then gets its own serialized intent on that exact head.
    if (!same(value.brief, baseline.brief)) await saveBrief(value.brief);
    else if (!sameSelections(value.references, baseline.references)) await saveReferences(value.references);
    else memory.set(projectId, { ...value, dirty: false });
  });
  useEffect(() => {
    if (!autoSaveReady) return;
    const timer = setTimeout(() => { void saveAutomatic(); }, LOGO_AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autoSaveReady, record, loaded]);

  return { status, workspace, stagePayloads, referenceSnapshot, draft: visible ? record : null, dirty: !!(visible && (record?.dirty || record?.vectorDraft || record?.directionDraft || proposal?.dirty)), pending: !!(visible && (busy || record && unresolved(record) || proposal?.pendingGeneration || proposal?.pendingApplication)), saving, autoSaveReady, error,
    canEdit: !!(visible && client && (!busy || saving) && !completed && (projectId === null || record)), client,
    pendingIntent: visible ? record?.pendingIntent ?? null : null, pendingCreation: visible ? completed?.pendingCreation ?? record?.pendingCreation ?? null : null,
    retainIntent, clearIntent, setBriefDraft, setReferenceDraft, reload, saveBrief, saveReferences, checkPendingSave, startProject, checkProjectCreation, retryProjectCreation, recoverProjectCreation };
}
