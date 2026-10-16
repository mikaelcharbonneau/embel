"use client";

import Link from "next/link";
import { useCallback, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { accountProjectResponseSchema, accountRevisionResponseSchema, updateProjectInputSchema } from "@/domain/project-api";
import type { ContextSnapshot } from "@/domain/projects";
import { accountErrorMessage, AccountRequestError } from "./account-api";
import { boundedAccountRequest } from "./bounded-account-request";
import { AccountStatus, useAccountSession } from "./account-session";
import { accountProjectDraft, draftContext, draftValidationMessage } from "./project-draft-adapter";
import { copyToLocalDraft, draftTitle, scopeLabel, type LocalDraft } from "./local-drafts";
import { type DraftPatch } from "./project-editor";
import { AccountGuidedInterview } from "./account-guided-interview";
import { getNamingReadiness } from "@/domain/project-naming";
import { getProjectHandoff } from "@/domain/project-handoff";
import { AccountProjectContinuity } from "./account-project-continuity";
import { IdeaSourceBanner } from "@/components/ideas/idea-source-banner";

import { accountDraftChanged as changed, reconcileAccountWorkspace, reconcilePendingDraftSave, type AccountWorkspace, type GuidedInterviewInput } from "./account-draft-memory";
const emptyWorkspace = () => null;

export function AccountProjectEditor({ projectId }: { projectId: string }) {
  const { session, isCurrent, expire, refresh, drafts } = useAccountSession();
  const readWorkspace = useCallback(() => drafts.get(projectId), [drafts, projectId]);
  const workspace = useSyncExternalStore(drafts.subscribe, readWorkspace, emptyWorkspace);
  const [loadError, setLoadError] = useState<{ generation: number; text: string } | null>(null);
  const setWorkspace = useCallback((value: AccountWorkspace | ((previous: AccountWorkspace | null) => AccountWorkspace | null)) => {
    const next = typeof value === "function" ? value(drafts.get(projectId)) : value;
    if (next && !drafts.set(next)) setLoadError({ generation: next.generation, text: "This tab has 20 account projects with unsaved edits. Save one before opening another project." });
  }, [drafts, projectId]);
  const [operation, setOperation] = useState<{ generation: number; projectId: string; busy: boolean; error?: string } | null>(null);
  const [confirmLatest, setConfirmLatest] = useState(false);
  const [browserCopy, setBrowserCopy] = useState<{ generation: number; id: string; persisted: boolean } | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const validId = z.uuid().safeParse(projectId).success;

  useEffect(() => {
    if (session.status !== "ready" || !validId) return;
    const controller = new AbortController();
    void boundedAccountRequest(`/api/projects/${projectId}`, accountProjectResponseSchema, { signal: controller.signal }).then(({ project }) => {
      if (controller.signal.aborted || !isCurrent(session)) return;
      if (project.owner_id !== session.userId || project.id !== projectId) { expire(session); return; }
      setLoadError(null);
      setWorkspace(previous => reconcileAccountWorkspace(previous, project, session.generation));
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !isCurrent(session)) return;
      if (error instanceof AccountRequestError && error.status === 401) expire(session);
      else setLoadError({ generation: session.generation, text: accountErrorMessage(error) });
    });
    return () => controller.abort();
  }, [session, projectId, validId, isCurrent, expire, setWorkspace]);
  useEffect(() => () => { mutation.current?.abort(); mutation.current = null; }, [session.generation, projectId]);
  const dirty = Boolean(workspace && changed(workspace));
  if (!validId) return <UnavailableProject />;
  if (session.status !== "ready") return <div className="page"><h1>Account project</h1><AccountStatus retainedEdits={dirty} /><Link href="/brands" className="text-link">Back to brands</Link></div>;
  if (loadError?.generation === session.generation) return <div className="page"><h1>Account project</h1><p className="form-error" role="alert">{loadError.text}</p>{dirty && workspace?.ownerId === session.userId && <p className="account-notice">Unsaved account edits remain in this tab. Check your account and retry to recover them.</p>}<div className="account-recovery-actions"><button className="button secondary small" type="button" onClick={refresh}>Check account and retry</button><Link href="/brands" className="text-link">Back to brands</Link></div></div>;
  const current = workspace?.ownerId === session.userId && workspace.generation === session.generation && workspace.saved.id === projectId ? workspace : null;
  if (!current) return <div className="page"><h1>Account project</h1><p className="quiet-empty">Loading your account project…</p><Link href="/brands" className="text-link">Back to brands</Link></div>;
  const account = session;
  const active = current;
  const busy = operation?.generation === account.generation && operation.projectId === projectId && operation.busy;

  function update(patch: DraftPatch) {
    if (!isCurrent(account)) return false;
    setWorkspace((previous) => previous?.ownerId === account.userId && previous.generation === account.generation ? { ...previous, draft: { ...previous.draft, ...patch } } : previous);
    if (!mutation.current) setOperation(null);
    return false;
  }
  function updateGuidedInput(update: (input: GuidedInterviewInput) => GuidedInterviewInput) {
    if (!isCurrent(account)) return;
    setWorkspace(previous => previous?.ownerId === account.userId && previous.generation === account.generation
      ? { ...previous, guidedInput: update(previous.guidedInput ?? { prompt: "", selection: null }) } : previous);
  }
  function fail(error: unknown, controller: AbortController) {
    if (controller.signal.aborted || !isCurrent(account)) return;
    if (error instanceof AccountRequestError && error.status === 401) { expire(account); return; }
    if (error instanceof AccountRequestError && error.status === 409) {
      setWorkspace((previous) => previous?.ownerId === account.userId && previous.generation === account.generation ? { ...previous, conflict: true } : previous);
      setOperation({ generation: account.generation, projectId, busy: false });
    } else setOperation({ generation: account.generation, projectId, busy: false, error: accountErrorMessage(error) });
  }
  function begin() {
    const controller = new AbortController();
    mutation.current?.abort(); mutation.current = controller;
    setOperation({ generation: account.generation, projectId, busy: true });
    return controller;
  }
  async function save(nextDraft?: LocalDraft, guidedContext?: ContextSnapshot, submittedInput?: Partial<GuidedInterviewInput>): Promise<AccountWorkspace | null> {
    const before = drafts.get(projectId);
    if (!isCurrent(account) || busy || mutation.current || !before || before.ownerId !== account.userId || before.generation !== account.generation || before.conflict) return null;
    const context = guidedContext ?? (!nextDraft ? before.pendingGuidedContext : undefined);
    const submittedDraft = before.pendingDraftSave?.draft ?? nextDraft ?? before.draft;
    let body: z.infer<typeof updateProjectInputSchema>;
    try { body = before.pendingDraftSave?.body ?? updateProjectInputSchema.parse({ expectedRevision: before.saved.current_revision, ...(context ? {} : { title: draftTitle(submittedDraft) }), context: context ?? draftContext(submittedDraft, before.saved.context) }); }
    catch { setOperation({ generation: account.generation, projectId, busy: false, error: context ? "This answer could not be saved. Your conversation is kept in this tab." : draftValidationMessage(submittedDraft) }); return null; }
    const controller = begin();
    const pending = before.pendingDraftSave ?? { body: structuredClone(body), draft: structuredClone(submittedDraft), submittedInput: submittedInput ? structuredClone(submittedInput) : undefined };
    setWorkspace({ ...before, pendingDraftSave: pending, ...(context ? { pendingGuidedContext: body.context } : {}) });
    async function checkOutcome(): Promise<AccountWorkspace | null | false> {
      const { project } = await boundedAccountRequest(`/api/projects/${projectId}`, accountProjectResponseSchema, { signal: controller.signal });
      if (controller.signal.aborted || !isCurrent(account)) return null;
      if (project.owner_id !== account.userId || project.id !== projectId) { expire(account); return null; }
      const previous = drafts.get(projectId);
      if (!previous || previous.ownerId !== account.userId || previous.generation !== account.generation) return null;
      const confirmed = reconcilePendingDraftSave(previous, project);
      if (confirmed) { setWorkspace(confirmed); setOperation({ generation: account.generation, projectId, busy: false }); return confirmed; }
      if (project.current_revision !== body.expectedRevision) throw new AccountRequestError(409);
      return false;
    }
    try {
      // A lost response remains a dirty, frozen intent even if the current text
      // was reverted. Read its owned head before any explicit retry append.
      if (before.pendingDraftSave) { const outcome = await checkOutcome(); if (outcome !== false) return outcome; }
      const { revision } = await boundedAccountRequest(`/api/projects/${projectId}`, accountRevisionResponseSchema, { method: "PATCH", body, signal: controller.signal });
      if (controller.signal.aborted || !isCurrent(account)) return null;
      if (revision.owner_id !== account.userId || revision.project_id !== projectId) { expire(account); return null; }
      if (revision.revision !== body.expectedRevision + 1 || JSON.stringify(revision.context) !== JSON.stringify(body.context)) throw new AccountRequestError(502);
      const previous = drafts.get(projectId);
      if (!previous || previous.ownerId !== account.userId || previous.generation !== account.generation) return null;
      if (previous.saved.current_revision !== body.expectedRevision) {
        if (!previous.pendingDraftSave && previous.saved.current_revision === revision.revision && JSON.stringify(previous.saved.context) === JSON.stringify(body.context)) { setOperation({ generation: account.generation, projectId, busy: false }); return previous; }
        throw new AccountRequestError(409);
      }
      const saved = { ...before.saved, title: body.title ?? before.saved.title, context: revision.context, current_revision: revision.revision };
      const next = reconcilePendingDraftSave(previous, saved);
      if (!next) throw new AccountRequestError(409);
      setWorkspace(next);
      setOperation({ generation: account.generation, projectId, busy: false });
      return next;
    } catch (error) {
      if (error instanceof AccountRequestError && error.status === 409 && !controller.signal.aborted && isCurrent(account)) {
        try { const outcome = await checkOutcome(); if (outcome) return outcome; }
        catch (recoveryError) { fail(recoveryError, controller); return null; }
      }
      // Ordinary rejected edits can be corrected before the next save. A guided
      // answer keeps its exact submission, including the input to clear on ack.
      if (!context && error instanceof AccountRequestError && [400, 413, 422, 429].includes(error.status) && !controller.signal.aborted && isCurrent(account)) setWorkspace(previous => previous?.pendingDraftSave === pending ? { ...previous, pendingDraftSave: undefined } : previous);
      fail(error, controller); return null;
    }
    finally { if (mutation.current === controller) mutation.current = null; }
  }
  async function saveContext(context: ContextSnapshot, submittedInput?: Partial<GuidedInterviewInput>): Promise<AccountWorkspace | null> {
    const before = drafts.get(projectId);
    if (!isCurrent(account) || busy || mutation.current || !before || before.ownerId !== account.userId || before.generation !== account.generation || before.conflict) return null;
    // A failed automatic save remains owner-bound in session memory. Never replace
    // another unsaved branch just because a new assistant result arrived.
    if (changed(before) && (!before.pendingGuidedContext || JSON.stringify(before.pendingGuidedContext) !== JSON.stringify(context))) return null;
    return save(undefined, context, submittedInput);
  }
  async function expand() {
    if (!isCurrent(account) || busy || mutation.current || changed(active) || active.conflict) return;
    const controller = begin();
    try {
      const { project } = await boundedAccountRequest(`/api/projects/${projectId}/expand`, accountProjectResponseSchema, { method: "POST", body: { expectedRevision: active.saved.current_revision }, signal: controller.signal });
      if (controller.signal.aborted || !isCurrent(account)) return;
      if (project.owner_id !== account.userId || project.id !== projectId) { expire(account); return; }
      if (project.scope !== "complete_brand" || project.current_revision !== active.saved.current_revision + 1) throw new AccountRequestError(502);
      setWorkspace((previous) => previous?.ownerId === account.userId && previous.generation === account.generation ? { ...previous, saved: project, draft: previous.draft === active.draft ? accountProjectDraft(project) : { ...previous.draft, scope: project.scope }, conflict: false } : previous);
      setOperation({ generation: account.generation, projectId, busy: false });
    } catch (error) { fail(error, controller); }
    finally { if (mutation.current === controller) mutation.current = null; }
  }
  async function loadLatest() {
    if (!isCurrent(account) || busy || mutation.current) return;
    const controller = begin();
    try {
      const { project } = await boundedAccountRequest(`/api/projects/${projectId}`, accountProjectResponseSchema, { signal: controller.signal });
      if (controller.signal.aborted || !isCurrent(account)) return;
      if (project.owner_id !== account.userId || project.id !== projectId) { expire(account); return; }
      if (drafts.get(projectId)?.draft !== active.draft) {
        setOperation({ generation: account.generation, projectId, busy: false, error: "Your edits changed while the latest version was loading. Review them before replacing this draft." });
        setConfirmLatest(false); return;
      }
      setWorkspace({ generation: account.generation, ownerId: account.userId, saved: project, draft: accountProjectDraft(project), conflict: false });
      setOperation({ generation: account.generation, projectId, busy: false }); setConfirmLatest(false);
    } catch (error) { fail(error, controller); }
    finally { if (mutation.current === controller) mutation.current = null; }
  }
  function saveBrowserCopy() {
    if (!isCurrent(account) || busy) return;
    const retainedContext = active.pendingGuidedContext ?? active.saved.context;
    const retainedDraft = active.pendingGuidedContext ? accountProjectDraft({ ...active.saved, context: retainedContext }) : active.draft;
    const copy = copyToLocalDraft({ ...retainedDraft, ownerId: account.userId, accountProjectId: undefined, preservedContext: retainedContext });
    if (copy) setBrowserCopy({ generation: account.generation, ...copy });
    else setOperation({ generation: account.generation, projectId, busy: false, error: "This device has 50 unsaved projects. Recover one from Projects to make room for this backup. Your edits are still kept in this tab." });
  }

  const hasSaveError = operation?.generation === account.generation && operation.projectId === projectId && Boolean(operation.error);
  const showActions = changed(active) || busy || active.conflict || hasSaveError || browserCopy?.generation === account.generation;
  const actions = showActions ? <div className="account-edit-controls">
    {(changed(active) || busy) && <div className="account-actions"><p role="status">{busy ? "Saving…" : hasSaveError || active.conflict || active.pendingGuidedContext || active.pendingDraftSave ? "Changes not saved" : "Saving changes…"}</p>{(hasSaveError || active.pendingGuidedContext || active.pendingDraftSave) && !active.conflict && <button className="button primary small" type="button" disabled={busy || !changed(active)} onClick={() => void save()}>{busy ? "Saving…" : "Retry save"}</button>}</div>}
    {operation?.generation === account.generation && operation.projectId === projectId && operation.error && <div><p className="form-error" role="alert">{operation.error}</p>{changed(active) && !active.conflict && <button className="button secondary small" type="button" disabled={busy} onClick={saveBrowserCopy}>Keep a recovery copy</button>}</div>}
    {active.conflict && <div className="account-conflict" role="alert"><strong>A newer version is saved in your account.</strong><p>Your edits are still here. Keep a recovery copy on this device or choose to load the latest account version.</p><div className="account-recovery-actions"><button className="button secondary small" type="button" disabled={busy} onClick={saveBrowserCopy}>Keep a recovery copy</button><button className="button secondary small" type="button" disabled={busy} onClick={() => setConfirmLatest(true)}>Load latest version</button></div>{confirmLatest && <div className="inline-confirm"><p>Replace the edits in this tab with the latest saved version? Keep a recovery copy first if you want to preserve these edits.</p><button className="button secondary small" type="button" onClick={() => setConfirmLatest(false)}>Keep editing</button><button className="button primary small" type="button" disabled={busy} onClick={() => void loadLatest()}>Replace with latest version</button></div>}</div>}
    {browserCopy?.generation === account.generation && <p className="form-success" role="status">{browserCopy.persisted ? "Your edits were kept for recovery on this device." : "Your recovery copy is kept in this tab only."} <Link href={`/brands/${browserCopy.id}`}>Open recovery</Link></p>}
  </div> : null;
  const namingReadiness = getNamingReadiness(active.saved.context, active.saved.scope);
  const namingBlocked = busy || changed(active) || active.conflict || !namingReadiness.ready;
  const namingHint = active.conflict ? "Resolve the saved-version conflict before opening Naming."
    : changed(active) ? "Your edits are saving. Naming will be available when they are saved."
    : !namingReadiness.ready ? "Finish reviewing your strategy before opening Naming." : null;
  // References come before generation readiness: an incomplete strategy or name
  // must not prevent a saved Identity project from exploring its references.
  const identityBlocked = busy || changed(active) || active.conflict;
  const identityHint = active.conflict ? "Resolve the saved-version conflict before opening Identity."
    : changed(active) ? "Your edits are saving. Identity will be available when they are saved." : null;
  const scopeControl = <div className="account-scope"><strong>{scopeLabel(active.saved.scope)}</strong>{active.saved.scope !== "visual_identity_only" && <>
    {namingBlocked ? <button className="button secondary small" type="button" disabled>Open Naming</button> : <Link className="button secondary small" href={`/brands/account/${projectId}/naming`}>Open Naming</Link>}
    {namingHint && <p className="field-hint">{namingHint}</p>}
  </>}{active.saved.scope !== "naming_only" && <>
    {identityBlocked ? <button className="button secondary small" type="button" disabled>Open logo workspace</button> : <Link className="button secondary small" href={`/brands/account/${projectId}/logo`}>Open logo workspace</Link>}
    {identityBlocked ? <button className="button secondary small" type="button" disabled>Open Inspiration</button> : <Link className="button secondary small" href={`/brands/account/${projectId}/inspiration`}>Open Inspiration</Link>}
    {identityBlocked ? <button className="button secondary small" type="button" disabled>Saved references and systems</button> : <Link className="text-link" href={`/brands/account/${projectId}/identity`}>Saved references and systems</Link>}
    {identityHint && <p className="field-hint">{identityHint}</p>}
  </>}</div>;
  const projectContext = <><div className="idea-source-wrap"><IdeaSourceBanner key={`${projectId}:${account.userId}:${account.generation}`} account={account} projectId={projectId} /></div><AccountProjectContinuity key={`continuity:${projectId}:${account.userId}:${account.generation}`} account={account} project={active.saved} dirty={changed(active)} conflicted={active.conflict} expanding={Boolean(busy)} onExpand={expand} /></>;
  const handoff = getProjectHandoff(active.saved);
  const continuation = handoff.next.stage !== "strategy" ? handoff.next : null;
  const continuationBlocked = busy || changed(active) || active.conflict;
  const resultNavigation = (continuation || active.saved.scope !== "complete_brand") && <nav className="account-actions" aria-label="Continue project">
    {continuation && (continuationBlocked ? <button type="button" className="button primary small" disabled>{continuation.label}</button> : <Link className="button primary small" href={continuation.href}>{continuation.label}</Link>)}
    {active.saved.scope !== "complete_brand" && <button type="button" className="button secondary small" disabled={Boolean(continuationBlocked)} onClick={() => void expand()}>Expand to complete brand</button>}
  </nav>;
  return <><AccountDraftAutosave workspace={active} blocked={Boolean(busy || hasSaveError)} save={save} /><AccountGuidedInterview key={`${projectId}:${account.userId}:${account.generation}`} account={account} workspace={active} busy={Boolean(busy)} saveContext={saveContext} onInputChange={updateGuidedInput} storage={{ kind: "account", saveLabel: busy ? "Saving…" : changed(active) ? hasSaveError || active.conflict || active.pendingDraftSave ? "Changes not saved" : "Saving…" : "Saved", onUpdate: update, actions, scopeControl, projectContext, resultNavigation, namingSource: active.saved.context.namingSource }} /></>;
}

function AccountDraftAutosave({ workspace, blocked, save }: { workspace: AccountWorkspace; blocked: boolean; save: () => Promise<AccountWorkspace | null> }) {
  const saveCurrent = useEffectEvent(() => void save());
  useEffect(() => {
    if (blocked || workspace.conflict || workspace.pendingGuidedContext || workspace.pendingDraftSave || !changed(workspace)) return;
    const timer = setTimeout(saveCurrent, 650);
    return () => clearTimeout(timer);
  }, [workspace, blocked]);
  return null;
}

function UnavailableProject() {
  return <div className="page"><div className="empty-panel"><h1>Account project not found</h1><p>Check the account project link and try again.</p><Link href="/brands" className="button primary">Back to brands</Link></div></div>;
}
