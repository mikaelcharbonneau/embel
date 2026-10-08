"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { standaloneImportKey, type StandaloneImportSource, type StandalonePayloadCodec, type StandaloneWorkspace } from "@/domain/standalone-workspaces";
import { useAccountSession } from "@/components/workspace/account-session";
import { AccountRequestError } from "@/components/workspace/account-api";
import { getStandaloneImport, getStandaloneWorkspace, saveStandaloneWorkspace, standaloneErrorMessage } from "./account-standalone-client";
import type { StandaloneDraftMemory, StandaloneDraftRecord } from "./standalone-draft-memory";

type Activity = { generation: number; busy: boolean; error: string | null; failed: boolean };
export function useStandaloneWorkspace<T>({ codec, emptyPayload, memory }: {
  codec: StandalonePayloadCodec<T>; emptyPayload: () => T; memory: StandaloneDraftMemory;
}) {
  const { session, isCurrent, expire } = useAccountSession();
  const account = session.status === "ready" ? session : null;
  const snapshot = useCallback(() => account ? memory.get(account, codec.tool) : null, [account, codec.tool, memory]);
  const record = useSyncExternalStore(memory.subscribe, snapshot, () => null) as StandaloneDraftRecord<T> | null;
  const [activity, setActivity] = useState<Activity>({ generation: -1, busy: false, error: null, failed: false });
  const operation = useRef<{ controller: AbortController; generation: number } | null>(null);
  const live = () => account !== null && isCurrent(account) && memory.isCurrent(account);
  const busy = activity.generation === session.generation && activity.busy;
  const error = account && activity.generation === session.generation ? activity.error : null;

  const reload = useCallback(async (discardUnsaved = false): Promise<boolean> => {
    if (!account || !isCurrent(account) || !memory.isCurrent(account) || operation.current?.generation === account.generation) return false;
    const previous = memory.get(account, codec.tool);
    if (previous && (previous.dirty || previous.pending) && !discardUnsaved) return false;
    const controller = new AbortController(); operation.current = { controller, generation: account.generation };
    const current = () => !controller.signal.aborted && operation.current?.controller === controller && isCurrent(account) && memory.isCurrent(account);
    setActivity({ generation: account.generation, busy: true, error: null, failed: false });
    try {
      const response = await getStandaloneWorkspace(codec, account, controller.signal);
      if (!current()) return false;
      memory.set(account, codec.tool, { workspace: response.workspace, payload: response.workspace?.payload ?? codec.schema.parse(emptyPayload()),
        imports: response.workspace?.imports ?? [], dirty: false, pending: null, conflict: false });
      return true;
    } catch (error) {
      if (current()) {
        setActivity({ generation: account.generation, busy: false, error: standaloneErrorMessage(error), failed: true });
        if (error instanceof AccountRequestError && error.status === 401) expire(account);
      }
      return false;
    } finally {
      if (operation.current?.controller === controller) operation.current = null;
      if (!controller.signal.aborted && isCurrent(account)) setActivity(value => ({ ...value, busy: false }));
    }
  }, [account, codec, emptyPayload, expire, isCurrent, memory]);

  useEffect(() => {
    const timer = window.setTimeout(() => { if (account && !memory.get(account, codec.tool)) void reload(); }, 0);
    return () => { window.clearTimeout(timer); operation.current?.controller.abort(); operation.current = null; };
  }, [account, codec.tool, memory, reload]);

  function setPayload(next: T) {
    if (!account || !live() || busy || operation.current?.generation === account.generation) return;
    const current = memory.get(account, codec.tool);
    if (!current || current.pending || current.conflict) return;
    const parsed = codec.schema.safeParse(next);
    if (!parsed.success) { setActivity({ generation: account.generation, busy: false, error: "Review the draft field values and lengths.", failed: false }); return; }
    const dirty = !current.workspace || JSON.stringify(parsed.data) !== JSON.stringify(current.workspace.payload) || JSON.stringify(current.imports) !== JSON.stringify(current.workspace.imports);
    memory.set(account, codec.tool, { ...current, payload: parsed.data, dirty });
    setActivity({ generation: account.generation, busy: false, error: null, failed: false });
  }
  async function importProject(projectId: string, apply: (source: StandaloneImportSource, current: T) => T): Promise<boolean> {
    if (!account || !live() || operation.current?.generation === account.generation) return false;
    const previous = memory.get(account, codec.tool) as StandaloneDraftRecord<T> | null;
    if (!previous || previous.pending || previous.conflict) return false;
    const controller = new AbortController(); operation.current = { controller, generation: account.generation };
    const current = () => !controller.signal.aborted && operation.current?.controller === controller && isCurrent(account) && memory.isCurrent(account);
    setActivity({ generation: account.generation, busy: true, error: null, failed: false });
    try {
      const { source } = await getStandaloneImport(projectId, account, controller.signal);
      if (!current()) return false;
      if (memory.get(account, codec.tool) !== previous) return false;
      if (!source) { setActivity({ generation: account.generation, busy: false, error: "Choose a project with a saved name.", failed: false }); return false; }
      const imports = previous.imports.some(item => standaloneImportKey(item) === standaloneImportKey(source)) ? previous.imports : [...previous.imports, source];
      if (imports.length > 30) throw new AccountRequestError(422);
      let payload: T;
      try { payload = codec.schema.parse(apply(source, structuredClone(previous.payload))); }
      catch { throw new AccountRequestError(422); }
      memory.set(account, codec.tool, { ...previous, payload, imports, dirty: true });
      return true;
    } catch (error) {
      if (current()) { setActivity({ generation: account.generation, busy: false, error: standaloneErrorMessage(error), failed: false }); if (error instanceof AccountRequestError && error.status === 401) expire(account); }
      return false;
    } finally {
      if (operation.current?.controller === controller) operation.current = null;
      if (!controller.signal.aborted && isCurrent(account)) setActivity(value => ({ ...value, busy: false }));
    }
  }
  async function save(): Promise<boolean> {
    if (!account || !live() || operation.current?.generation === account.generation) return false;
    const previous = memory.get(account, codec.tool) as StandaloneDraftRecord<T> | null;
    if (!previous || previous.conflict || (!previous.dirty && !previous.pending)) return false;
    const input = previous.pending ?? { requestKey: crypto.randomUUID(), expectedRevision: previous.workspace?.revision ?? 0, payload: previous.payload,
      imports: previous.imports.map(({ projectId, projectRevision, selectionId }) => ({ projectId, projectRevision, selectionId })) };
    memory.set(account, codec.tool, { ...previous, pending: input });
    const controller = new AbortController(); operation.current = { controller, generation: account.generation };
    const current = () => !controller.signal.aborted && operation.current?.controller === controller && isCurrent(account) && memory.isCurrent(account);
    setActivity({ generation: account.generation, busy: true, error: null, failed: false });
    try {
      const response = await saveStandaloneWorkspace(codec, account, input, controller.signal);
      if (!current()) return false;
      const workspace = response.workspace as StandaloneWorkspace<T>;
      if (previous.workspace && workspace.id !== previous.workspace.id) throw new AccountRequestError(502);
      memory.set(account, codec.tool, { workspace, payload: workspace.payload, imports: workspace.imports, dirty: false, pending: null, conflict: false });
      return true;
    } catch (error) {
      if (current()) {
        if (error instanceof AccountRequestError && [409, 413, 422].includes(error.status)) memory.set(account, codec.tool, { ...previous, pending: null, conflict: error.status === 409 });
        setActivity({ generation: account.generation, busy: false, error: standaloneErrorMessage(error), failed: false });
        if (error instanceof AccountRequestError && error.status === 401) expire(account);
      }
      return false;
    } finally {
      if (operation.current?.controller === controller) operation.current = null;
      if (!controller.signal.aborted && isCurrent(account)) setActivity(value => ({ ...value, busy: false }));
    }
  }
  const status = !account ? "unverified" as const : record ? "ready" as const : activity.generation === session.generation && activity.failed ? "error" as const : "loading" as const;
  return { status, payload: account && record ? record.payload : null, workspace: account && record ? record.workspace : null,
    imports: account && record ? record.imports : [], dirty: Boolean(account && record?.dirty), pending: Boolean(account && (busy || record?.pending)), busy: Boolean(account && busy), error,
    canEdit: Boolean(account && record && !busy && !record.pending && !record.conflict),
    canSave: Boolean(account && record && !busy && !record.conflict && (record.dirty || record.pending)),
    setPayload, importProject, save, reload };
}
