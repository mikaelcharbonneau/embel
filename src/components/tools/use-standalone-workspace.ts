"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { standaloneImportKey, type StandaloneImportSource, type StandalonePayloadCodec, type StandaloneWorkspace } from "@/domain/standalone-workspaces";
import { useAccountSession } from "@/components/workspace/account-session";
import { AccountRequestError } from "@/components/workspace/account-api";
import { getStandaloneImport, getStandaloneWorkspace, saveStandaloneWorkspace, standaloneErrorMessage } from "./account-standalone-client";
import type { StandaloneDraftMemory, StandaloneDraftOperation, StandaloneDraftRecord } from "./standalone-draft-memory";

export const STANDALONE_AUTOSAVE_DELAY_MS = 600;
const REQUEST_TIMEOUT_MS = 30_000;
type Activity = { generation: number; error: string | null; failed: boolean };
const matches = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function useStandaloneWorkspace<T>({ codec, emptyPayload, memory }: {
  codec: StandalonePayloadCodec<T>; emptyPayload: () => T; memory: StandaloneDraftMemory;
}) {
  const { session, isCurrent, expire } = useAccountSession();
  const account = session.status === "ready" ? session : null;
  const snapshot = useCallback(() => account ? memory.get(account, codec.tool) : null, [account, codec.tool, memory]);
  const operationSnapshot = useCallback(() => account ? memory.getOperation(account, codec.tool) : null, [account, codec.tool, memory]);
  const record = useSyncExternalStore(memory.subscribe, snapshot, () => null) as StandaloneDraftRecord<T> | null;
  const operation = useSyncExternalStore(memory.subscribe, operationSnapshot, () => null);
  const [activity, setActivity] = useState<Activity>({ generation: -1, error: null, failed: false });
  const ownedRead = useRef<StandaloneDraftOperation | null>(null);
  const live = () => account !== null && isCurrent(account) && memory.isCurrent(account);
  const error = account ? record?.saveError ?? (activity.generation === session.generation ? activity.error : null) : null;

  const read = useCallback(async (recovery: "none" | "saved" | "edits"): Promise<boolean> => {
    if (!account || !isCurrent(account) || !memory.isCurrent(account)) return false;
    const previous = memory.get(account, codec.tool) as StandaloneDraftRecord<T> | null;
    if (previous && (previous.dirty || previous.pending || previous.conflict) && recovery === "none") return false;
    // An uncertain save must be replayed before a replacement write can be based on it.
    if (recovery === "edits" && (!previous?.conflict || previous.pending)) return false;
    const request = memory.beginOperation(account, codec.tool, "loading");
    if (!request) return false;
    ownedRead.current = request;
    const { controller } = request;
    const current = () => memory.getOperation(account, codec.tool) === request && isCurrent(account) && memory.isCurrent(account);
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    setActivity({ generation: account.generation, error: null, failed: false });
    try {
      const response = await getStandaloneWorkspace(codec, account, controller.signal);
      if (controller.signal.aborted || !current()) return false;
      const payload = recovery === "edits" && previous ? previous.payload : response.workspace?.payload ?? codec.schema.parse(emptyPayload());
      const imports = recovery === "edits" && previous ? previous.imports : response.workspace?.imports ?? [];
      const dirty = recovery === "edits" && (!response.workspace || !matches(payload, response.workspace.payload) || !matches(imports, response.workspace.imports));
      memory.set(account, codec.tool, { workspace: response.workspace, payload, imports, dirty, pending: null, conflict: false, saveError: null });
      return true;
    } catch (error) {
      if (current()) {
        setActivity({ generation: account.generation, error: standaloneErrorMessage(error), failed: true });
        if (error instanceof AccountRequestError && error.status === 401) expire(account);
      }
      return false;
    } finally {
      window.clearTimeout(timeout);
      memory.finishOperation(codec.tool, request);
      if (ownedRead.current === request) ownedRead.current = null;
    }
  }, [account, codec, emptyPayload, expire, isCurrent, memory]);

  const reload = useCallback((discardUnsaved = false) => read(discardUnsaved ? "saved" : "none"), [read]);
  const keepChanges = useCallback(() => read("edits"), [read]);

  // The writer belongs to provider memory, so navigation cannot start a second writer
  // or cancel an admitted save. Every acknowledgement still obeys the session fence.
  const save = useCallback(async (): Promise<boolean> => {
    if (!account || !isCurrent(account) || !memory.isCurrent(account)) return false;
    const before = memory.get(account, codec.tool) as StandaloneDraftRecord<T> | null;
    if (!before || before.conflict || (!before.dirty && !before.pending)) return false;
    const request = memory.beginOperation(account, codec.tool, "saving");
    if (!request) return false;
    const { controller } = request;
    const current = () => memory.getOperation(account, codec.tool) === request && isCurrent(account) && memory.isCurrent(account);
    try {
      while (current()) {
        const previous = memory.get(account, codec.tool) as StandaloneDraftRecord<T> | null;
        if (!previous || previous.conflict) return false;
        if (!previous.dirty && !previous.pending) return true;
        const input = previous.pending ?? { requestKey: crypto.randomUUID(), expectedRevision: previous.workspace?.revision ?? 0, payload: previous.payload,
          imports: previous.imports.map(({ projectId, projectRevision, selectionId }) => ({ projectId, projectRevision, selectionId })) };
        memory.set(account, codec.tool, { ...previous, pending: input, saveError: null });
        const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          const response = await saveStandaloneWorkspace(codec, account, input, controller.signal);
          if (controller.signal.aborted || !current()) return false;
          const workspace = response.workspace as StandaloneWorkspace<T>;
          if (previous.workspace && workspace.id !== previous.workspace.id) throw new AccountRequestError(502);
          const latest = memory.get(account, codec.tool) as StandaloneDraftRecord<T> | null;
          if (!latest || latest.pending?.requestKey !== input.requestKey) return false;
          // Acknowledging an older snapshot never replaces newer input. Advance the
          // baseline, then serialize one more write if the user kept editing.
          const dirty = !matches(latest.payload, workspace.payload) || !matches(latest.imports, workspace.imports);
          memory.set(account, codec.tool, { ...latest, workspace, dirty, pending: null, conflict: false, saveError: null });
        } catch (error) {
          if (current()) {
            const latest = memory.get(account, codec.tool);
            if (latest?.pending?.requestKey === input.requestKey) {
              const rejected = error instanceof AccountRequestError && [409, 413, 422].includes(error.status);
              memory.set(account, codec.tool, { ...latest, pending: rejected ? null : latest.pending,
                conflict: error instanceof AccountRequestError && error.status === 409, saveError: standaloneErrorMessage(error) });
            }
            if (error instanceof AccountRequestError && error.status === 401) expire(account);
          }
          return false;
        } finally { window.clearTimeout(timeout); }
      }
      return false;
    } finally { memory.finishOperation(codec.tool, request); }
  }, [account, codec, expire, isCurrent, memory]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!account) return;
      const cached = memory.get(account, codec.tool);
      if (!cached || (!cached.dirty && !cached.pending && !cached.conflict)) void reload();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      const request = ownedRead.current;
      if (request) { request.controller.abort(); memory.finishOperation(codec.tool, request); ownedRead.current = null; }
      const latest = account ? memory.get(account, codec.tool) : null;
      if (latest && !latest.saveError && !latest.conflict) void save();
    };
  }, [account, codec.tool, memory, reload, save]);

  useEffect(() => {
    if (!account || !record || operation || record.conflict || record.saveError || (!record.dirty && !record.pending)) return;
    const timer = window.setTimeout(() => void save(), STANDALONE_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [account, record, operation, save]);

  function setPayload(next: T) {
    if (!account || !live()) return;
    const request = memory.getOperation(account, codec.tool);
    if (request && request.kind !== "saving") return;
    const current = memory.get(account, codec.tool) as StandaloneDraftRecord<T> | null;
    if (!current) return;
    const parsed = codec.schema.safeParse(next);
    if (!parsed.success) { setActivity({ generation: account.generation, error: "Review the draft field values and lengths.", failed: false }); return; }
    const dirty = !current.workspace || !matches(parsed.data, current.workspace.payload) || !matches(current.imports, current.workspace.imports);
    memory.set(account, codec.tool, { ...current, payload: parsed.data, dirty,
      saveError: current.pending || current.conflict ? current.saveError : null });
    setActivity({ generation: account.generation, error: null, failed: false });
  }
  async function importProject(projectId: string, apply: (source: StandaloneImportSource, current: T) => T): Promise<boolean> {
    if (!account || !live()) return false;
    const previous = memory.get(account, codec.tool) as StandaloneDraftRecord<T> | null;
    if (!previous || previous.pending || previous.conflict) return false;
    const request = memory.beginOperation(account, codec.tool, "importing");
    if (!request) return false;
    ownedRead.current = request;
    const { controller } = request;
    const current = () => memory.getOperation(account, codec.tool) === request && isCurrent(account) && memory.isCurrent(account);
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    setActivity({ generation: account.generation, error: null, failed: false });
    try {
      const { source } = await getStandaloneImport(projectId, account, controller.signal);
      if (controller.signal.aborted || !current() || memory.get(account, codec.tool) !== previous) return false;
      if (!source) { setActivity({ generation: account.generation, error: "Choose a project with a saved name.", failed: false }); return false; }
      const imports = previous.imports.some(item => standaloneImportKey(item) === standaloneImportKey(source)) ? previous.imports : [...previous.imports, source];
      if (imports.length > 30) throw new AccountRequestError(422);
      let payload: T;
      try { payload = codec.schema.parse(apply(source, structuredClone(previous.payload))); }
      catch { throw new AccountRequestError(422); }
      memory.set(account, codec.tool, { ...previous, payload, imports, dirty: true, saveError: null });
      return true;
    } catch (error) {
      if (current()) { setActivity({ generation: account.generation, error: standaloneErrorMessage(error), failed: false }); if (error instanceof AccountRequestError && error.status === 401) expire(account); }
      return false;
    } finally {
      window.clearTimeout(timeout);
      memory.finishOperation(codec.tool, request);
      if (ownedRead.current === request) ownedRead.current = null;
    }
  }
  const status = !account ? "unverified" as const : record ? "ready" as const : activity.generation === session.generation && activity.failed ? "error" as const : "loading" as const;
  return { status, payload: account && record ? record.payload : null, workspace: account && record ? record.workspace : null,
    imports: account && record ? record.imports : [], dirty: Boolean(account && record?.dirty), pending: Boolean(account && (operation || record?.pending)), busy: Boolean(operation), error,
    conflict: Boolean(account && record?.conflict), saving: operation?.kind === "saving", importing: operation?.kind === "importing",
    canEdit: Boolean(account && record && (!operation || operation.kind === "saving")),
    canImport: Boolean(account && record && !operation && !record.pending && !record.conflict),
    canSave: Boolean(account && record && !operation && !record.conflict && (record.dirty || record.pending)),
    setPayload, importProject, save, reload, keepChanges };
}
