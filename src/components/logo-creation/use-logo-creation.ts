"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAccountSession } from "../workspace/account-session";
import { useLogoDraftMemory } from "../identity/logo-draft-memory-context";
import { useLogoCapabilities, type LogoCapabilitiesReadiness } from "../identity/use-logo-capabilities";
import { useLogoWorkspace } from "../identity/use-logo-workspace";
import { isAccountLogoClientCurrent } from "../identity/account-logo-client";
import { refreshLogoCreationWorkspace } from "./workspace-refresh";
import { createLogoCreationController, type LogoCreationController } from "./creation-controller";

export type LogoWorkspaceController = ReturnType<typeof useLogoWorkspace>;

/** One shared owner-scoped memory. No browser persistence or feature draft copy. */
export function useLogoCreation(projectId: string): { workspace: LogoWorkspaceController; creation: LogoCreationController | null; capabilities: LogoCapabilitiesReadiness } {
  const memory = useLogoDraftMemory();
  const workspace = useLogoWorkspace({ projectId, memory });
  const { session, isCurrent } = useAccountSession();
  const account = session.status === "ready" ? session : null;
  const client = workspace.client;
  const capabilities = useLogoCapabilities(client, projectId);
  const readiness = useRef(capabilities);
  useLayoutEffect(() => { readiness.current = capabilities; }, [capabilities]);
  const ownerId = workspace.workspace?.ownerId;
  const savedProjectId = workspace.workspace?.projectId;
  const latest = useRef<LogoWorkspaceController | null>(null);
  const [entry, setEntry] = useState<{ client: NonNullable<typeof client>; ownerId: string; projectId: string; generation: number; controller: LogoCreationController } | null>(null);
  useLayoutEffect(() => { latest.current = workspace; return () => { latest.current = null; }; }, [workspace]);
  useEffect(() => {
    if (!account || !client || ownerId !== account.userId || savedProjectId !== projectId || !isAccountLogoClientCurrent(client, account, projectId)) return;
    let disposed = false;
    const current = () => !disposed && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId);
    const controller = createLogoCreationController({ client, projectId,
      getWorkspace: () => current() ? memory.get(projectId)?.workspace ?? null : null,
      hasUnsavedInputs: () => {
        const draft = memory.get(projectId);
        return !draft || draft.dirty || !!draft.vectorDraft || !!draft.directionDraft || draft.conflict || !!draft.pendingMutation || !!draft.pendingExport || !latest.current?.canEdit;
      },
      getPendingIntent: () => current() ? memory.get(projectId)?.pendingIntent ?? null : null,
      retainIntent: intent => { if (current()) latest.current?.retainIntent(intent); },
      clearIntent: key => { if (current()) latest.current?.clearIntent(key); },
      refreshWorkspace: () => refreshLogoCreationWorkspace({ memory, projectId, isCurrent: current,
        reload: discard => latest.current?.reload(discard) ?? Promise.resolve("unavailable"),
      }),
      isOperationAvailable: operation => readiness.current.isAvailable(operation),
      isCurrent: current, now: Date.now, createRequestKey: () => crypto.randomUUID(),
    });
    queueMicrotask(() => { if (current()) setEntry({ client, ownerId, projectId, generation: account.generation, controller }); });
    return () => { disposed = true; controller.dispose(); };
  }, [account, client, isCurrent, memory, ownerId, projectId, savedProjectId]);
  const creation = entry && account && client === entry.client && projectId === entry.projectId && ownerId === entry.ownerId
    && account.generation === entry.generation && isCurrent(account) ? entry.controller : null;
  useEffect(() => { creation?.refreshInputs(); }, [creation, workspace.dirty, workspace.pending, workspace.workspace, workspace.draft?.conflict, capabilities.status, capabilities.available]);
  const pendingKey = workspace.pendingIntent?.requestKey;
  useEffect(() => {
    if (!creation || !pendingKey) return;
    let closed = false, timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      await creation!.checkRequest();
      if (closed) return;
      if (memory.get(projectId)?.pendingIntent?.requestKey === pendingKey) timer = setTimeout(() => { void poll(); }, 3000);
      else await latest.current?.reload(false);
    }
    timer = setTimeout(() => { void poll(); }, 3000);
    return () => { closed = true; clearTimeout(timer); };
  }, [creation, memory, pendingKey, projectId]);
  return { workspace, creation, capabilities };
}
