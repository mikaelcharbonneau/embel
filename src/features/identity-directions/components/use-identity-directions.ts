"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "@/components/identity/account-logo-client";
import { useLogoDraftMemory } from "@/components/identity/logo-draft-memory-context";
import { useLogoWorkspace } from "@/components/identity/use-logo-workspace";
import { useAccountSession } from "@/components/workspace/account-session";
import { AccountRequestError, accountErrorMessage } from "@/components/workspace/account-api";
import type { IdentityDirectionsOverview } from "@/domain/logo-directions";
import type { LogoWorkspaceV2 } from "@/domain/logo-workspace";
import type { LogoVectorDocument } from "@/domain/logo-vector";
import { validateLogoVectorDocument } from "@/features/logo-vector/model/geometry";
import { previewIdentityMix, type DirectionMixPreview } from "../model/mix";
import { buildDirectionApprovalCommand, buildDirectionSelectionCommand, dispatchDirectionCommand, reconcileDirectionCommand, replayDirectionCommand, type DirectionActionContext } from "./direction-actions";

import { useDirectionGeneration, type DirectionGeneration } from "./use-direction-generation";

type ComponentIds = DirectionMixPreview["components"];
export interface IdentityDirectionsController {
  generation: DirectionGeneration; pendingGeneration: boolean; canDiscardDraft: boolean; hasDirectionDraft: boolean;
  history: { overview: IdentityDirectionsOverview | null; loading: boolean; error: string | null; canLoadMore: boolean; canLoadPrevious: boolean };
  loadHistory(direction?: "next" | "previous"): Promise<void>;
  overview: IdentityDirectionsOverview | null; draft: DirectionMixPreview | null; pendingRequestKey: string | null; pendingRequestKind: "save" | "approval" | null; canRetryRequest: boolean;
  loading: boolean; error: string | null; canRead: boolean; canSave: boolean; workspace: LogoWorkspaceV2 | null;
  directionIds: readonly string[]; requestStatus: string | null; approvedLogoDocument: LogoVectorDocument | null; reviewedWarnings: boolean;
  refresh(): Promise<void>; preview(ids: ComponentIds): Promise<void>; saveMix(): Promise<void>; approve(): Promise<void>;
  reconcile(): Promise<void>; retryOriginal(): Promise<void>; reviewWarnings(reviewed: boolean): void; discardAndReload(): Promise<void>;
}
type ReadState = { key: string; client: AccountLogoClient; overview: IdentityDirectionsOverview | null; loading: boolean; error: string | null; requestStatus: string | null; logo: LogoVectorDocument | null; logoHash: string | null; directionIds: readonly string[] };
type HistoryState = { key: string; client: AccountLogoClient; overview: IdentityDirectionsOverview | null; cursors: string[]; index: number; loading: boolean; error: string | null };
type MutationState = { scope: string; client: AccountLogoClient; loading: boolean };
export function useIdentityDirections(client: AccountLogoClient, workspace: LogoWorkspaceV2): IdentityDirectionsController {
  const memory = useLogoDraftMemory(), baseline = useLogoWorkspace({ projectId: workspace.projectId, memory, client });
  const generation = useDirectionGeneration(client, baseline);
  const { session, isCurrent } = useAccountSession(), account = session.status === "ready" ? session : null;
  const active = account && isCurrent(account) && baseline.client === client && isAccountLogoClientCurrent(client, account, workspace.projectId)
    && baseline.workspace?.ownerId === account.userId && baseline.workspace.ownerId === workspace.ownerId && baseline.workspace.projectId === workspace.projectId ? baseline.workspace : null;
  // The memory store deliberately parses/clones records. Lifecycle dependencies
  // bind semantic scope and heads, never those replaceable workspace objects.
  const projectId = active?.projectId ?? null, ownerId = active?.ownerId ?? null;
  const revision = active?.heads.workspaceRevision ?? null, approvedLogoId = active?.approvedLogo?.id ?? null;
  const vectorRevisionId = active?.approvedLogo?.vectorRevisionId ?? null, directionStageId = active?.stages.directions?.id ?? null;
  const scopeKey = account && projectId ? `${account.userId}:${account.generation}:${projectId}` : "";
  const key = scopeKey && revision !== null ? `${scopeKey}:${revision}:${approvedLogoId ?? ""}:${vectorRevisionId ?? ""}` : "";
  const [state, setState] = useState<ReadState | null>(null), [mutation, setMutation] = useState<MutationState | null>(null);
  const [historyState, setHistoryState] = useState<HistoryState | null>(null);
  const historyOperation = useRef<AbortController | null>(null);
  const [previewState, setPreviewState] = useState<{ key: string; client: AccountLogoClient; draft: DirectionMixPreview } | null>(null);
  const readOperation = useRef<AbortController | null>(null), mutationOperation = useRef<AbortController | null>(null), previewSequence = useRef(0);
  const committedScope = useRef<{ key: string; client: AccountLogoClient } | null>(null);
  useLayoutEffect(() => {
    const scope = { key: scopeKey, client }; committedScope.current = scope;
    return () => {
      if (committedScope.current === scope) committedScope.current = null;
      historyOperation.current?.abort(); historyOperation.current = null;
      readOperation.current?.abort(); readOperation.current = null;
      mutationOperation.current?.abort(); mutationOperation.current = null;
    };
  }, [scopeKey, client, memory]);
  const currentScope = useCallback(() => !!(account && projectId && committedScope.current?.key === scopeKey && committedScope.current.client === client
    && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId)), [account, client, isCurrent, projectId, scopeKey]);
  const visible = active && state?.key === key && state.client === client ? state : null;
  const history = active && historyState?.key === key && historyState.client === client ? historyState : null;
  const pendingGeneration = !!(active && baseline.draft?.pendingIntent);
  const mutating = mutation?.scope === scopeKey && mutation.client === client && mutation.loading;
  const directionDraftCanBeDiscarded = !!(active && baseline.canEdit && baseline.draft && !mutating && !baseline.draft.dirty
    && !baseline.draft.vectorDraft && !baseline.draft.conflict && !baseline.draft.pendingIntent && !baseline.draft.pendingExport && !baseline.draft.pendingMutation);
  const pending = baseline.draft?.pendingMutation;
  const pendingRequestKey = active && pending && ["selectIdentityDirectionComponents", "approveIdentityDirection"].includes(pending.command.method) ? pending.requestKey : null;
  const updateError = (error: unknown) => setState(value => value?.key === key && value.client === client ? { ...value, error: accountErrorMessage(error) } : value);
  const read = useCallback(async (): Promise<void> => {
    if (!account || !projectId || !ownerId || revision === null || !currentScope() || mutationOperation.current) return;
    historyOperation.current?.abort(); historyOperation.current = null;
    setHistoryState(value => value?.key === key && value.client === client ? { ...value, loading: false } : value);
    readOperation.current?.abort(); const controller = new AbortController(); readOperation.current = controller;
    const current = () => readOperation.current === controller && !controller.signal.aborted && currentScope()
      && memory.get(projectId)?.workspace?.heads.workspaceRevision === revision;
    setState(previous => ({ key, client, overview: previous?.key === key && previous.client === client ? previous.overview : null, loading: true, error: null, requestStatus: null,
      logo: previous?.key === key && previous.client === client ? previous.logo : null,
      logoHash: previous?.key === key && previous.client === client ? previous.logoHash : null, directionIds: previous?.key === key && previous.client === client ? previous.directionIds : [] }));
    try {
      const overview = await client.getIdentityDirections({ limit: 50 }, controller.signal); if (!overview || !current()) return;
      if (overview.currentApprovedLogo?.id !== approvedLogoId) throw new AccountRequestError(409);
      const savedStage = directionStageId ? await client.getLogoStageRevision("directions", directionStageId, controller.signal) : null;
      if (!current()) return;
      const directionIds = savedStage?.stage === "directions" ? savedStage.payload.directionIds : [];
      setHistoryState(null);
      // The same owned approved vector remains valid while its metadata is rechecked.
      // A different approval/vector/client gets a different key and is hidden immediately.
      setState(previous => ({ key, client, overview, loading: false, error: null, requestStatus: null,
        logo: previous?.key === key && previous.client === client ? previous.logo : null,
        logoHash: previous?.key === key && previous.client === client ? previous.logoHash : null, directionIds }));
      if (vectorRevisionId) {
        try {
          const detail = await client.readLogoVectorDetail(vectorRevisionId, controller.signal);
          if (detail && current() && detail.revision.id === vectorRevisionId && detail.revision.ownerId === ownerId && detail.revision.projectId === projectId) {
            const logo = validateLogoVectorDocument(detail.document);
            setState(value => value?.key === key && value.client === client ? { ...value,
              logo: value.logo && value.logoHash === detail.revision.documentHash ? value.logo : logo, logoHash: detail.revision.documentHash } : value);
          } else if (current()) setState(value => value?.key === key && value.client === client ? { ...value, logo: null, logoHash: null } : value);
        } catch {
          // A completed failed verification must not keep previously eligible geometry.
          if (current()) setState(value => value?.key === key && value.client === client ? { ...value, logo: null, logoHash: null } : value);
        }
      }
    } catch (error) {
      if (current()) setState(previous => ({ key, client, overview: previous?.key === key && previous.client === client ? previous.overview : null, loading: false,
        error: error instanceof AccountRequestError && error.status === 409 ? "Your saved logo changed. Reload before reviewing directions." : "Saved directions are unavailable right now. Your work is retained.",
        requestStatus: null, logo: null, logoHash: null, directionIds: previous?.key === key && previous.client === client ? previous.directionIds : [] }));
    } finally {
      if (readOperation.current === controller) { readOperation.current = null; if (currentScope()) setState(value => value?.key === key && value.client === client ? { ...value, loading: false } : value); }
    }
  }, [account, approvedLogoId, client, currentScope, directionStageId, key, memory, ownerId, projectId, revision, vectorRevisionId]);
  useEffect(() => {
    if (!approvedLogoId) return;
    const timer = setTimeout(() => { void read(); }, 0);
    return () => { clearTimeout(timer); readOperation.current?.abort(); readOperation.current = null; };
  }, [approvedLogoId, read]);
  const choices = baseline.draft?.directionDraft;
  const chosenPalette = choices?.paletteVersionId ?? visible?.overview?.selection?.paletteVersionId;
  const chosenTypography = choices?.typographyVersionId ?? visible?.overview?.selection?.typographyVersionId;
  const chosenGraphics = choices?.graphicsVersionId ?? visible?.overview?.selection?.graphicsVersionId;
  useEffect(() => {
    const overview = visible?.overview;
    if (!overview || !chosenPalette || !chosenTypography || !chosenGraphics || !currentScope()) return;
    const sequence = ++previewSequence.current; let cancelled = false;
    void previewIdentityMix({ overview, paletteVersionId: chosenPalette, typographyVersionId: chosenTypography, graphicsVersionId: chosenGraphics }).then(draft => {
      if (!cancelled && sequence === previewSequence.current && currentScope()) setPreviewState({ key, client, draft });
    }).catch(() => { if (!cancelled && sequence === previewSequence.current && currentScope()) setPreviewState(null); });
    return () => { cancelled = true; };
  }, [chosenGraphics, chosenPalette, chosenTypography, client, currentScope, key, visible?.overview]);
  const computed = previewState?.key === key && previewState.client === client ? previewState.draft : null;
  const draft = computed && (!choices || (choices.approvedLogoId === computed.approvedLogoId && choices.paletteVersionId === computed.components.paletteVersionId && choices.typographyVersionId === computed.components.typographyVersionId && choices.graphicsVersionId === computed.components.graphicsVersionId)) ? computed : null;
  const preview = async (ids: ComponentIds): Promise<void> => {
    if (!projectId || !approvedLogoId || !visible?.overview || mutationOperation.current || pendingRequestKey || !currentScope()) return;
    const value = memory.get(projectId); if (!value || value.conflict || value.dirty || value.pendingIntent || value.pendingExport || value.pendingMutation || value.vectorDraft) return;
    try { memory.set(projectId, { ...value, directionDraft: { approvedLogoId, ...ids, reviewedConsistencyHash: null } }); }
    catch (error) { updateError(error); }
  };
  const loadHistory = async (direction: "next" | "previous" = "next"): Promise<void> => {
    if (!projectId || !visible?.overview || historyOperation.current || readOperation.current || !currentScope()) return;
    const first = visible.overview, previous = history;
    const index = direction === "previous" ? (previous?.index ?? -1) - 1 : (previous?.index ?? -1) + 1;
    if (index < 0) { setHistoryState(null); return; }
    const cursor = direction === "previous" ? previous?.cursors[index] : previous?.overview ? previous.overview.nextCursor : first.nextCursor;
    if (!cursor) return;
    const controller = new AbortController(); historyOperation.current = controller;
    const current = () => historyOperation.current === controller && !controller.signal.aborted && currentScope()
      && memory.get(projectId)?.workspace?.heads.workspaceRevision === revision;
    setHistoryState({ key, client, overview: previous?.overview ?? null, cursors: previous?.cursors ?? [], index: previous?.index ?? -1, loading: true, error: null });
    try {
      const page = await client.getIdentityDirections({ cursor, limit: 3 }, controller.signal);
      if (!current()) return;
      if (!page || page.currentApprovedLogo?.id !== approvedLogoId || page.selection?.id !== first.selection?.id || page.approval?.id !== first.approval?.id
        || page.nextCursor === cursor || new Set(page.directions.map(row => row.id)).size !== page.directions.length) throw new AccountRequestError(409);
      const cursors = [...(previous?.cursors ?? [])]; cursors[index] = cursor;
      setHistoryState({ key, client, overview: page, cursors, index, loading: false, error: null });
    } catch { if (current()) setHistoryState(value => value?.key === key && value.client === client ? { ...value, loading: false,
      error: "Earlier directions could not be read. Loaded history is kept. Refresh saved work if the current inputs changed." } : value); }
    finally { if (historyOperation.current === controller) historyOperation.current = null; }
  };
  const perform = async (kind: "save" | "approve" | "reconcile" | "retry"): Promise<void> => {
    const recovery = kind === "reconcile" || kind === "retry", overview = visible?.overview;
    if (!projectId || (!recovery && !overview) || mutationOperation.current || !currentScope()) return;
    // Cancel a background read without sharing its controller/lifetime with a POST.
    readOperation.current?.abort(); readOperation.current = null;
    const controller = new AbortController(); mutationOperation.current = controller;
    const context: DirectionActionContext = { client, memory, projectId, signal: controller.signal,
      current: () => mutationOperation.current === controller && currentScope() };
    setMutation({ scope: scopeKey, client, loading: true });
    setState(value => value?.key === key && value.client === client ? { ...value, loading: false, error: null, requestStatus: null }
      : { key, client, overview: null, loading: false, error: null, requestStatus: null, logo: null, logoHash: null, directionIds: [] });
    try {
      const value = memory.get(projectId); if (!value) return;
      const result = kind === "reconcile" ? await reconcileDirectionCommand(context) : kind === "retry" ? await replayDirectionCommand(context)
        : await dispatchDirectionCommand(context, kind === "save" && draft ? buildDirectionSelectionCommand(value, draft, crypto.randomUUID()) : kind === "approve" && overview ? buildDirectionApprovalCommand(value, overview, crypto.randomUUID()) : (() => { throw new AccountRequestError(409); })());
      if (!controller.signal.aborted && context.current()) setState(current => current?.key === key && current.client === client ? { ...current, overview: result ?? current.overview,
        requestStatus: result ? "Saved request verified. Current saved work loaded." : kind === "reconcile" ? "The original request is still retained. No request was resent." : kind === "retry" ? "The original request is still retained. Check it before trying again." : null } : current);
    } catch (error) { if (context.current()) updateError(error); }
    finally { if (mutationOperation.current === controller) { mutationOperation.current = null; if (currentScope()) setMutation({ scope: scopeKey, client, loading: false }); } }
  };
  const reviewWarnings = (reviewed: boolean) => {
    const selection = visible?.overview?.selection, value = projectId ? memory.get(projectId) : null;
    if (!value || value.pendingIntent || value.pendingExport || !selection || !projectId || pendingRequestKey || mutationOperation.current || !currentScope()) return;
    if (value.directionDraft && (value.directionDraft.paletteVersionId !== selection.paletteVersionId || value.directionDraft.typographyVersionId !== selection.typographyVersionId || value.directionDraft.graphicsVersionId !== selection.graphicsVersionId)) return;
    memory.set(projectId, { ...value, directionDraft: { approvedLogoId: selection.approvedLogoId, paletteVersionId: selection.paletteVersionId, typographyVersionId: selection.typographyVersionId, graphicsVersionId: selection.graphicsVersionId, reviewedConsistencyHash: reviewed ? selection.consistency.hash : null } });
  };
  return { generation, pendingGeneration, canDiscardDraft: directionDraftCanBeDiscarded, hasDirectionDraft: !!(active && baseline.draft?.directionDraft), history: { overview: history?.overview ?? null, loading: history?.loading ?? false, error: history?.error ?? null,
    canLoadMore: !!(history?.overview ? history.overview.nextCursor : visible?.overview?.nextCursor), canLoadPrevious: !!history?.overview }, loadHistory, overview: visible?.overview ?? null, draft, pendingRequestKey,
    pendingRequestKind: pendingRequestKey ? pending?.command.method === "approveIdentityDirection" ? "approval" : "save" : null,
    canRetryRequest: !!(active && pendingRequestKey && !mutating && !visible?.loading), loading: !!visible?.loading || !!mutating, error: visible?.error ?? baseline.error,
    canRead: !!active, canSave: !!active && active.capabilities.save.status === "available" && !baseline.draft?.dirty && !baseline.draft?.conflict && !baseline.draft?.vectorDraft && !baseline.draft?.pendingIntent && !baseline.draft?.pendingExport && !baseline.draft?.pendingMutation,
    workspace: active, directionIds: visible?.directionIds ?? [], requestStatus: visible?.requestStatus ?? null, approvedLogoDocument: visible?.logo ?? null,
    reviewedWarnings: !!visible?.overview?.selection && choices?.reviewedConsistencyHash === visible.overview.selection.consistency.hash,
    refresh: async () => {
      if (mutationOperation.current || !currentScope()) return;
      const value = projectId ? memory.get(projectId) : null;
      if (value && !value.dirty && !value.vectorDraft && !value.directionDraft && !value.pendingIntent && !value.pendingExport && !value.pendingMutation && !value.conflict) {
        await baseline.reload(false);
        if (memory.get(projectId!)?.workspace?.heads.workspaceRevision !== revision) return;
      }
      await read();
    }, preview, saveMix: () => perform("save"), approve: () => perform("approve"), reconcile: () => perform("reconcile"), retryOriginal: () => perform("retry"), reviewWarnings,
    discardAndReload: async () => {
      if (!currentScope() || !projectId || mutationOperation.current) return;
      const value = memory.get(projectId);
      // This feature may discard only its own unsent mix. A retained request,
      // brief/vector edit or shared conflict belongs to its original recovery flow.
      if (!value || value.pendingIntent || value.pendingExport || value.pendingMutation || value.dirty || value.vectorDraft || value.conflict) return;
      historyOperation.current?.abort(); historyOperation.current = null;
      setHistoryState(previous => previous?.key === key && previous.client === client ? { ...previous, loading: false } : previous);
      readOperation.current?.abort(); readOperation.current = null;
      if (value.directionDraft) memory.set(projectId, { ...value, directionDraft: null });
      await baseline.reload(false);
    },
  };
}
