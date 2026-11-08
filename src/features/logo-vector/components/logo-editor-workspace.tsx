"use client";

import Link from "next/link";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { AccountRequestError, accountErrorMessage } from "@/components/workspace/account-api";
import { LogoIdentityContinuation } from "@/components/logo-creation/workflow-status";
import { LogoDownloadControls } from "@/components/logo-creation/logo-download-controls";
import { useLogoDraftMemory } from "@/components/identity/logo-draft-memory-context";
import { useLogoWorkspace } from "@/components/identity/use-logo-workspace";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "@/components/identity/account-logo-client";
import type { LogoDraftMemory } from "@/components/identity/logo-draft-memory";
import type { LogoVectorDetail } from "@/domain/logo-deliverables";
import { logoUuidSchema, logoManualEditSchema, type LogoManualEdit } from "@/domain/logo-vector";
import { validateLogoVectorDocument } from "../model/geometry";
import { ComponentControls } from "./component-controls";
import { OwnedTextControls } from "./owned-text-controls";
import { ComponentGrouping } from "./component-grouping";
import { ConversionReviewPresentation, type ConversionReviewReadiness } from "./conversion-review";
import type { LogoHistoryCursor, LogoHistoryPage, LogoStageRevision } from "@/domain/logo-workspace";
import { applyLogoManualEdit } from "../model/edits";
import { cancelVectorMutation, recoverVectorCancellation } from "../client/cancellation";
import { createVectorRecoveryIntent, recoverVectorMutation, submitVectorIntent, type LogoVectorRecoveryIntent } from "../client/recovery";
import { SavedVectorHistory } from "./saved-vector-history";
import type { LogoVectorHistoryItem } from "../model/history";
import styles from "./logo-vector.module.css";
import { VectorProposalPanel } from "./vector-proposal-panel";
import { proposalSessionUnsaved } from "../model/proposal-session";
import type { LogoVectorProposalApplicationResult } from "../client/proposal-application";

const textEditKinds = ["text", "font", "spacing", "replace_outlined_lettering"];

/** Official account entrypoint. Root owns route mounting and the sole draft-memory provider. */
export function LogoEditorWorkspace({ projectId }: { projectId: string }) {
  const { session } = useAccountSession();
  const memory = useLogoDraftMemory();
  const parsed = logoUuidSchema.safeParse(projectId);
  if (!parsed.success) return <section className={`page project-logo-editor ${styles.vectorPage}`}><h1>Logo workspace not found</h1><Link href="/brands">Back to brands</Link></section>;
  return <section className={`page project-logo-editor ${styles.vectorPage}`}>
    <header className={styles.editorHeader}><div><p className={styles.eyebrow}>Identity · Vector logo</p><h1>Review your vector logo</h1></div><Link className={styles.quietLink} href={`/brands/account/${parsed.data}/logo`}>Back to logo</Link></header>
    <AccountStatus retainedEdits={memory.hasUnsaved()} />
    {session.status === "ready" && <OwnedLogoEditor key={`${session.userId}:${session.generation}:${parsed.data}`} projectId={parsed.data} account={session} memory={memory} />}
  </section>;
}

type Preview = NonNullable<Awaited<ReturnType<AccountLogoClient["previewAsset"]>>>;
type DetailRead = { source: string; requestScope: string; requestedId: string | null | undefined; client: AccountLogoClient; detail: LogoVectorDetail | null; preview: Preview | null; error: string | null; restoration?: LogoStageRevision | null };
function OwnedLogoEditor({ projectId, account, memory }: { projectId: string; account: VerifiedAccount; memory: LogoDraftMemory }) {
  const { isCurrent } = useAccountSession(), state = useLogoWorkspace({ projectId, memory }), { client } = state;
  const [read, setRead] = useState<DetailRead | null>(null), [selectedId, setSelectedId] = useState<string | null>(null);
  const [historical, setHistorical] = useState<LogoStageRevision | null>(null), [historyVector, setHistoryVector] = useState<LogoVectorHistoryItem | null>(null), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [readAttempt, setReadAttempt] = useState(0), [historyAttempt, setHistoryAttempt] = useState(0), [acknowledgement, setAcknowledgement] = useState<{ source: string; checked: boolean } | null>(null);
  const [appliedVectorId, setAppliedVectorId] = useState<string | null>(null);
  const proposalSession = useSyncExternalStore(memory.subscribe, () => memory.getVectorProposal(projectId), () => null);
  const [cancelNotice, setCancelNotice] = useState<string | null>(null);
  const [comparison, setComparison] = useState<ConversionReviewReadiness | null>(null);
  const operation = useRef<AbortController | null>(null);
  const currentClient = client !== null && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId);
  const activeClient = useCallback(() => client !== null && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId), [account, client, isCurrent, projectId]);
  const workspace = state.workspace?.ownerId === account.userId && state.workspace.projectId === projectId ? state.workspace : null;
  const draft = currentClient ? state.draft : null;
  const historicalVectorId = historical && "vectorRevisionId" in historical.payload ? historical.payload.vectorRevisionId : null;
  const wantedId = draft?.vectorDraft?.baseVectorRevisionId ?? appliedVectorId ?? historicalVectorId ?? historyVector?.vectorRevisionId;
  const requestScope = workspace ? `${workspace.heads.workspaceRevision}:${historical?.id ?? ""}:${readAttempt}` : null;
  // Pinning the already resolved current revision for the first local edit is
  // not a new read identity. Keep its verified detail/URL, but never reuse it
  // across a changed head, client, requested vector or explicit reload.
  const resolvedRead = read && read.requestScope === requestScope && read.client === client && read.detail
    && (wantedId ? wantedId === read.detail.revision.id : !read.requestedId) ? read : null;
  const source = requestScope ? resolvedRead ? resolvedRead.source : `${requestScope}:${wantedId ?? "current"}` : null;
  // A real transition disposes the effect's URL. Forget that read immediately,
  // including while its replacement is pending, so A/B/A cannot expose it again.
  if (read && (!currentClient || read.client !== client || read.source !== source)) setRead(null);
  const readWantedId = useEffectEvent(() => wantedId);
  useEffect(() => () => { operation.current?.abort(); operation.current = null; }, []);
  useEffect(() => {
    if (!client || !currentClient || !source || !requestScope) return;
    const controller = new AbortController(), requestedId = readWantedId(); let preview: Preview | null = null;
    const current = () => !controller.signal.aborted && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId);
    void (async () => {
      const id = requestedId ?? await client.readLogoCurrentVectorRevisionId(controller.signal); if (!current()) return;
      if (!id) { setRead({ source, requestScope, requestedId, client, detail: null, preview: null, error: null }); return; }
      const detail = await client.readLogoVectorDetail(id, controller.signal); if (!current()) return;
      if (!detail || detail.revision.id !== id || detail.revision.ownerId !== account.userId || detail.revision.projectId !== projectId) throw new AccountRequestError(502);
      const document = validateLogoVectorDocument(detail.document);
      let restoration: LogoStageRevision | null = null;
      if (historyVector?.stageRevision) {
        const ref = historyVector.stageRevision;
        restoration = await client.getLogoStageRevision(ref.stage, ref.id, controller.signal); if (!current()) return;
        if (!restoration || restoration.revision !== ref.revision || !("vectorRevisionId" in restoration.payload) || restoration.payload.vectorRevisionId !== id) throw new AccountRequestError(502);
      }
      try { preview = await client.previewAsset(detail.sourcePreview, controller.signal); }
      catch { if (current()) setRead({ source, requestScope, requestedId, client, detail: { ...detail, document }, preview: null, error: "The original preview could not be verified. Reload it before accepting or restoring." }); return; }
      if (!current()) { preview?.release(); return; }
      setRead({ source, requestScope, requestedId, client, detail: { ...detail, document }, preview, restoration, error: preview ? null : "The original preview is unavailable." });
    })().catch(() => { if (current()) setRead({ source, requestScope, requestedId, client, detail: null, preview: null, error: "The saved vector could not be verified and remains hidden." }); });
    return () => { controller.abort(); preview?.release(); };
  }, [account, client, currentClient, isCurrent, projectId, requestScope, source, historyVector]);
  const visible = currentClient && read?.source === source && read.client === client ? read : null, detail = visible?.detail ?? null;
  const vectorDraft = draft?.vectorDraft;
  const document = useMemo(() => {
    const base = detail?.document ?? null;
    if (base && vectorDraft && vectorDraft.baseVectorRevisionId === detail?.revision.id) {
      if (textEditKinds.includes(vectorDraft.edit.kind)) return base;
      try { return applyLogoManualEdit(base, vectorDraft.edit); } catch { /* Preserve the authoritative document when an unsupported command is retained. */ }
    }
    return base;
  }, [detail, vectorDraft]);
  const selectedComponent = document?.components.find(component => component.id === selectedId) ?? document?.components[0] ?? null;
  const conflict = draft?.conflict ?? false, pendingCommand = draft?.pendingMutation?.command;
  const pending = pendingCommand && ["saveLogoEdit", "acceptLogoVector", "restoreLogoStage"].includes(pendingCommand.method);
  const inspecting = Boolean(historical || historyVector), restoration = historical ?? visible?.restoration;
  const approved = Boolean(detail && workspace?.approvedLogo?.vectorRevisionId === detail.revision.id);
  const earlier = Boolean(detail && workspace && detail.revision.inputRevisions.some(input => workspace.stages[input.stage]?.id !== input.id));
  const acceptedEarlier = source !== null && acknowledgement?.source === source && acknowledgement.checked;
  const baseCanMutate = Boolean(currentClient && workspace?.capabilities.save.status === "available" && !busy && !state.pending && !conflict && !draft?.dirty && !draft?.directionDraft);
  const canMutate = baseCanMutate && !proposalSessionUnsaved(proposalSession);
  const comparisonReady = Boolean(comparison?.ready && comparison.document === document && comparison.originalUrl === visible?.preview?.url && comparison.scopeKey === source);
  const actionReady = canMutate && comparisonReady && Boolean(detail && visible?.preview) && (!earlier || acceptedEarlier);
  async function perform(intent: LogoVectorRecoveryIntent | "check" | "retry" | "cancel") {
    if (!client || !currentClient || operation.current) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError(null); setCancelNotice(null);
    const current = () => !controller.signal.aborted && isCurrent(account) && isAccountLogoClientCurrent(client, account, projectId);
    try {
      const context = { account, client, memory, projectId, signal: controller.signal, isCurrent: current };
      let saved = false;
      if (intent === "cancel" || typeof intent === "string" && pendingCommand?.method === "saveLogoEdit") {
        const result = intent === "cancel" ? await cancelVectorMutation(context) : await recoverVectorCancellation(context);
        if (result?.status === "cancelled") {
          if (current()) setCancelNotice(`Original edit request cancelled. Your ${draft?.vectorDraft && textEditKinds.includes(draft.vectorDraft.edit.kind) ? "lettering" : "vector"} draft is still here.`);
          return;
        }
        saved = result?.status === "succeeded";
        if (!result && intent === "retry") saved = Boolean(await recoverVectorMutation(context, true));
      } else saved = Boolean(typeof intent === "string" ? await recoverVectorMutation(context, intent === "retry") : await submitVectorIntent(context, intent));
      if (saved && current()) { setAppliedVectorId(null); setHistorical(null); setHistoryVector(null); await state.reload(false); }
    } catch (cause) {
      const textSave = typeof intent !== "string" ? intent.kind === "edit" && textEditKinds.includes(intent.request.edit.kind) : intent === "retry" && draft?.vectorDraft && textEditKinds.includes(draft.vectorDraft.edit.kind);
      if (current()) setError(intent === "cancel" ? "The edit request could not be cancelled yet. Its original request and draft are retained; check the original request before trying again."
        : cause instanceof AccountRequestError && cause.status === 422 && textSave ? "This lettering change could not be shaped with the selected font, layout or rights. The saved version and original request are retained." : accountErrorMessage(cause));
    }
    finally { if (operation.current === controller) { operation.current = null; if (current()) setBusy(false); } }
  }
  function edit(raw: LogoManualEdit) {
    if (!canMutate || !detail || inspecting || !draft || draft.vectorDraft) return;
    try { const edit = logoManualEditSchema.parse(raw); if (!textEditKinds.includes(edit.kind)) applyLogoManualEdit(detail.document, edit); memory.set(projectId, { ...draft, vectorDraft: { baseVectorRevisionId: detail.revision.id, edit } }); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "This change is unavailable."); }
  }
  function review(revision: LogoStageRevision) {
    if (!currentClient || busy || state.pending || state.dirty) { setError("Save or discard your current change before reviewing another version."); return; }
    setAppliedVectorId(null); setHistorical(revision); setHistoryVector(null); setReadAttempt(value => value + 1); setError(null);
  }
  function reviewVector(item: LogoVectorHistoryItem) {
    if (!currentClient || busy || state.pending || state.dirty) { setError("Save or discard your current change before reviewing another version."); return; }
    setAppliedVectorId(null); setHistorical(null); setHistoryVector(item); setReadAttempt(value => value + 1); setError(null);
  }
  function backToCurrent() { setAppliedVectorId(null); setHistorical(null); setHistoryVector(null); setReadAttempt(value => value + 1); setError(null); }
  const reloadProposalWorkspace = state.reload;
  const onProposalApplied = useCallback(async (result: Extract<LogoVectorProposalApplicationResult, { status: "succeeded" }>) => {
    if (!activeClient()) return;
    const revision = result.receipt.revision;
    if (revision.stage !== "refinements" || !revision.payload.vectorRevisionId || revision.payload.approvalId !== null) throw new AccountRequestError(502);
    const refreshed = await reloadProposalWorkspace(false); if (!activeClient()) return;
    if (refreshed !== "reloaded") { setError("The unapproved candidate is saved. Resolve your current edit, then review it in saved vector history."); return; }
    setHistorical(null); setHistoryVector(null); setAppliedVectorId(revision.payload.vectorRevisionId); setReadAttempt(value => value + 1); setHistoryAttempt(value => value + 1);
  }, [activeClient, reloadProposalWorkspace]);
  const common = () => ({ requestKey: crypto.randomUUID(), expected: draft!.base! });
  return <section className={styles.editor} aria-label="Account logo editor">
    {state.status === "loading" && <p role="status">Loading your logo…</p>}
    {(error || state.error) && <div className={styles.notice} role="alert"><p>{error ?? state.error}</p></div>}
    {workspace && workspace.staleStages.length > 0 && <div className={styles.notice} role="status"><strong>Some earlier choices changed</strong><p>This logo was made with earlier choices. Compare it with your current brief before accepting it.</p></div>}
    {client && currentClient && workspace && <VectorProposalPanel account={account} projectId={projectId} client={client} memory={memory} isCurrent={activeClient} onApplied={onProposalApplied}
      context={detail && visible?.preview ? { workspace, detail, targetId: selectedComponent?.id ?? detail.document.components[0]!.id,
        ready: baseCanMutate && comparisonReady && !inspecting && !draft?.vectorDraft && (!earlier || acceptedEarlier) } : null} />}
    {conflict && <div className={styles.notice} role="alert"><strong>Revision conflict</strong><p>Your vector change and original request remain in this tab.</p><button type="button" disabled={busy || Boolean(pending)} onClick={() => { if (!busy && !pending) { backToCurrent(); void state.reload(true); } }}>Discard change and load latest</button></div>}
    {cancelNotice && <p role="status">{cancelNotice}</p>}
    {draft?.vectorDraft && <p role="status">Unsaved vector change</p>}
    {vectorDraft && textEditKinds.includes(vectorDraft.edit.kind) && <p role="status">Pending lettering change. The preview shows the saved version until Save edit creates its shaped candidate.</p>}
    {pending && <div className={styles.notice} role="status"><p>The original request is retained until its saved result can be confirmed.</p><div className={styles.actions}>
      <button type="button" disabled={busy} onClick={() => void perform("check")}>Check original request</button>
      <button type="button" disabled={busy || conflict} onClick={() => void perform("retry")}>Retry unchanged request</button>
      {pendingCommand?.method === "saveLogoEdit" && <button type="button" disabled={busy} onClick={() => void perform("cancel")}>Cancel original edit request</button>}
    </div></div>}
    {currentClient && source && !visible && <p role="status">Loading the saved vector candidate…</p>}
    {visible?.error && <p role="status">{visible.error}</p>}
    {!detail && visible && !visible.error && <div className={styles.notice} role="status"><strong>No vector ready for approval</strong><p>Your logo is an image for now. To turn it into a vector, go to the Logo step, open Logo brief and history, then Saved versions and options, and choose Convert to vector. You can review the vector here before accepting it.</p><Link href={`/brands/account/${projectId}/logo`}>Open Logo</Link></div>}
    {detail && document && <>
      <div className={styles.headingRow}><h2>{historical ? "Historical vector" : historyVector ? "Saved vector for review" : approved ? "Approved logo" : "Review required"}</h2><span className={styles.badge}>{historical ? `Saved version ${historical.revision}` : "Saved vector"}</span></div>
      <p className={styles.caption}>{detail.revision.source.kind === "concept" ? "Made from your logo concept" : "Made from your refined logo"}{detail.revision.locks.length > 0 ? ` · ${detail.revision.locks.length} locked ${detail.revision.locks.length === 1 ? "part" : "parts"}` : ""}</p>
      <ConversionReviewPresentation document={document} originalUrl={visible?.preview?.url} scopeKey={source ?? undefined} onReadinessChange={setComparison} />
      {client && <LogoDownloadControls client={client} account={account} projectId={projectId}
        vectorRevisionId={detail.revision.id} original={detail.sourcePreview}
        disabled={busy || Boolean(pending)} unsavedChanges={Boolean(draft?.vectorDraft) || proposalSessionUnsaved(proposalSession)} />}
      <div className={styles.editLayout}><nav className={styles.componentList} aria-label="Saved logo components"><h3>Components</h3>{document.components.map(component => <button key={component.id} type="button" aria-pressed={selectedComponent?.id === component.id} onClick={() => setSelectedId(component.id)}>{component.role.replaceAll("_", " ")}</button>)}</nav>
        <div><ComponentControls showTextPlaceholder={false} document={document} componentId={selectedComponent?.id ?? ""} lockedComponentIds={detail.revision.locks.map(lock => lock.componentId)}
          disabledReason={inspecting ? "Return to the current vector to edit. Accept or restore this saved vector explicitly to select it." : draft?.vectorDraft ? "Save or discard this change before editing again." : !canMutate ? "Editing is unavailable while a request or conflict is unresolved." : undefined} onEdit={edit} />
          {client && <OwnedTextControls key={detail.revision.id} account={account} client={client} revision={detail.revision} document={detail.document} componentId={selectedComponent?.id ?? ""} lockedComponentIds={detail.revision.locks.map(lock => lock.componentId)} isCurrent={activeClient}
            disabledReason={inspecting ? "Return to the current vector to edit." : draft?.vectorDraft ? "Save or discard this change before editing again." : !canMutate ? "Editing is unavailable while a request or conflict is unresolved." : undefined} onEdit={edit} />}</div></div>
      <ComponentGrouping key={detail.revision.id} document={document} lockedComponentIds={detail.revision.locks.map(lock => lock.componentId)}
        disabledReason={inspecting ? "Return to the current vector to edit. Accept or restore this saved vector explicitly to select it." : draft?.vectorDraft ? "Save or discard this change before editing again." : !canMutate ? "Editing is unavailable while a request or conflict is unresolved." : undefined} onEdit={edit} />
      {earlier && <label><input type="checkbox" checked={acceptedEarlier} disabled={busy || Boolean(pending)} onChange={event => setAcknowledgement({ source: source!, checked: event.currentTarget.checked })} /> I reviewed this vector’s earlier input versions.</label>}
      <div className={styles.actions} aria-label="Saved vector actions">
        <button type="button" disabled={!canMutate || !comparisonReady || !draft?.vectorDraft || inspecting} onClick={() => { if (canMutate && comparisonReady && !inspecting && draft?.vectorDraft) void perform(createVectorRecoveryIntent({ kind: "edit", request: { ...common(), ...draft.vectorDraft } })); }}>Save edit</button>
        {draft?.vectorDraft && !pending && <button type="button" disabled={busy} onClick={() => { if (draft) memory.set(projectId, { ...draft, vectorDraft: null }); }}>Discard edit</button>}
        {!historical && <button type="button" disabled={!actionReady || Boolean(draft?.vectorDraft) || approved} onClick={() => { if (actionReady && !draft?.vectorDraft && !approved) void perform(createVectorRecoveryIntent({ kind: "accept", request: { ...common(), vectorRevisionId: detail.revision.id, acceptEarlierBasis: acceptedEarlier } })); }}>Accept this vector</button>}
        {restoration && <button type="button" disabled={!actionReady} onClick={() => { if (actionReady) void perform(createVectorRecoveryIntent({ kind: "restore", request: { ...common(), stage: restoration.stage, revisionId: restoration.id, acceptEarlierBasis: acceptedEarlier } })); }}>Restore this version</button>}
      </div>
      {workspace && <LogoIdentityContinuation workspace={workspace} blocked={!canMutate || Boolean(draft?.vectorDraft) || state.pending} hasSelection={Boolean(state.stagePayloads?.concepts?.payload.selected)} />}
    </>}
    <div className={styles.actions}>{(inspecting || appliedVectorId !== null) && <button type="button" disabled={busy || Boolean(pending)} onClick={backToCurrent}>Back to current vector</button>}<button type="button" disabled={!currentClient || busy || state.pending || state.dirty} onClick={() => { setReadAttempt(value => value + 1); setHistoryAttempt(value => value + 1); void state.reload(false); }}>Refresh</button><Link className={styles.quietLink} href={`/brands/account/${projectId}/logo`}>Back to logo</Link></div>
    {client && currentClient && workspace && <><SavedVectorHistory key={`all-vectors:${workspace.heads.workspaceRevision}:${historyAttempt}`} client={client} workspaceRevision={workspace.heads.workspaceRevision} current={activeClient} disabled={busy || state.pending || state.dirty} onReview={reviewVector} />{(["vector", "refinements"] as const).map(stage => <SavedHistory key={`${stage}:${workspace.heads.workspaceRevision}`} client={client} stage={stage} current={activeClient} disabled={busy || state.pending || state.dirty} onReview={review} />)}</>}
  </section>;
}

function SavedHistory({ client, stage, current, disabled, onReview }: { client: AccountLogoClient; stage: "vector" | "refinements"; current(): boolean; disabled: boolean; onReview(revision: LogoStageRevision): void }) {
  const [page, setPage] = useState<LogoHistoryPage | null>(null), [cursor, setCursor] = useState<LogoHistoryCursor | undefined>();
  const [error, setError] = useState(false), [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted && current()) setLoading(true); });
    void client.listLogoStageHistory(stage, { cursor, limit: 20 }, controller.signal).then(result => { if (!controller.signal.aborted && current()) { setPage(result); setError(false); setLoading(false); } }).catch(() => { if (!controller.signal.aborted && current()) { setError(true); setLoading(false); } });
    return () => controller.abort();
  }, [client, current, cursor, stage]);
  return <section className={styles.history} aria-label={`${stage === "vector" ? "Vector" : "Refinement"} history`}><h3>{stage === "vector" ? "Vector" : "Refinement"} history</h3>
    {loading && <p role="status">Loading saved versions…</p>}{error && <p role="status">Saved history could not be loaded.</p>}
    {page?.items.length === 0 && <p>No saved versions.</p>}<ol>{page?.items.map(revision => <li key={revision.id}><div><strong>{stage === "vector" ? "Vector" : "Refinement"} version {revision.revision}</strong><time dateTime={revision.createdAt}>{revision.createdAt}</time></div>
      <button type="button" disabled={disabled || loading || !("vectorRevisionId" in revision.payload) || !revision.payload.vectorRevisionId} onClick={() => onReview(revision)}>Review {stage === "vector" ? "vector" : "refinement"} version {revision.revision}</button></li>)}</ol>
    {page?.nextCursor && <button type="button" disabled={disabled || loading} onClick={() => setCursor(page.nextCursor!)}>Earlier versions</button>}{cursor && <button type="button" disabled={disabled || loading} onClick={() => setCursor(undefined)}>Latest versions</button>}
  </section>;
}
