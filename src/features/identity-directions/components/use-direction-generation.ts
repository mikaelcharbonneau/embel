"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "@/components/identity/account-logo-client";
import { useLogoCapabilities } from "@/components/identity/use-logo-capabilities";
import { useLogoDraftMemory } from "@/components/identity/logo-draft-memory-context";
import type { useLogoWorkspace } from "@/components/identity/use-logo-workspace";
import { useAccountSession } from "@/components/workspace/account-session";
import { refreshLogoCreationWorkspace } from "@/components/logo-creation/workspace-refresh";
import { createDirectionGenerationController, emptyDirectionGeneration, type DirectionGenerationController } from "./generation-controller";
const noSubscription = () => () => undefined;
type WorkspaceController = ReturnType<typeof useLogoWorkspace>;

export function useDirectionGeneration(client: AccountLogoClient, workspace: WorkspaceController) {
  const memory = useLogoDraftMemory(), { session, isCurrent } = useAccountSession();
  const account = session.status === "ready" ? session : null;
  const projectId = workspace.workspace?.projectId, ownerId = workspace.workspace?.ownerId;
  const capabilities = useLogoCapabilities(client, projectId ?? null);
  const readiness = useRef(capabilities);
  useLayoutEffect(() => { readiness.current = capabilities; }, [capabilities]);
  const latest = useRef<WorkspaceController | null>(null);
  const [entry, setEntry] = useState<{ client: AccountLogoClient; ownerId: string; projectId: string; generation: number; controller: DirectionGenerationController } | null>(null);
  useLayoutEffect(() => { latest.current = workspace; return () => { latest.current = null; }; }, [workspace]);
  useEffect(() => {
    if (!account || !projectId || ownerId !== account.userId || !isAccountLogoClientCurrent(client, account, projectId)) return;
    let closed = false;
    const current = () => !closed && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId);
    const controller = createDirectionGenerationController({ client, projectId,
      getWorkspace: () => current() ? memory.get(projectId)?.workspace ?? null : null,
      hasUnsavedInputs: () => {
        const draft = memory.get(projectId);
        return !draft || draft.dirty || !!draft.vectorDraft || !!draft.directionDraft || draft.conflict || !!draft.pendingMutation || !!draft.pendingExport || !latest.current?.canEdit;
      },
      getPendingIntent: () => current() ? memory.get(projectId)?.pendingIntent ?? null : null,
      retainIntent: intent => { if (current()) latest.current?.retainIntent(intent); },
      clearIntent: key => { if (current()) latest.current?.clearIntent(key); },
      refreshWorkspace: () => refreshLogoCreationWorkspace({ memory, projectId, isCurrent: current, reload: discard => latest.current?.reload(discard) ?? Promise.resolve("unavailable") }),
      isOperationAvailable: operation => readiness.current.isAvailable(operation),
      isCurrent: current, now: Date.now, createRequestKey: () => crypto.randomUUID(),
    });
    queueMicrotask(() => { if (current()) { setEntry({ client, ownerId, projectId, generation: account.generation, controller }); void controller.refreshFonts(); } });
    return () => { closed = true; controller.dispose(); };
  }, [account, client, isCurrent, memory, ownerId, projectId]);
  const controller = entry && account && client === entry.client && projectId === entry.projectId && ownerId === entry.ownerId
    && account.generation === entry.generation && isCurrent(account) ? entry.controller : null;
  const state = useSyncExternalStore(controller?.subscribe ?? noSubscription, controller?.getSnapshot ?? emptyDirectionGeneration, emptyDirectionGeneration);
  useEffect(() => { controller?.refreshInputs(); }, [controller, workspace.draft, workspace.canEdit, capabilities.status, capabilities.available]);
  const quoteExpiresAt = state.generation.quote?.expiresAt;
  useEffect(() => {
    if (!controller || !quoteExpiresAt) return;
    const delay = Math.max(0, Date.parse(quoteExpiresAt) - Date.now());
    // Avoid overflowing the browser timer for a malformed or very distant quote.
    const timer = setTimeout(() => controller.refreshInputs(), Math.min(delay + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [controller, quoteExpiresAt]);
  const pendingKey = workspace.pendingIntent?.requestKey;
  useEffect(() => {
    if (!controller || !pendingKey || !projectId) return;
    let closed = false, timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      await controller!.checkRequest();
      if (!closed && memory.get(projectId!)?.pendingIntent?.requestKey === pendingKey) timer = setTimeout(() => { void poll(); }, 3000);
    }
    timer = setTimeout(() => { void poll(); }, 0);
    return () => { closed = true; clearTimeout(timer); };
  }, [controller, memory, pendingKey, projectId]);
  return controller ? { state, prepare: controller.prepare, confirmQuote: controller.confirmQuote, cancelQuote: controller.cancelQuote,
    checkRequest: controller.checkRequest, refreshAvailability: capabilities.refresh, refreshFonts: controller.refreshFonts, returnToCostReview: controller.returnToCostReview } : null;
}
export type DirectionGeneration = ReturnType<typeof useDirectionGeneration>;
