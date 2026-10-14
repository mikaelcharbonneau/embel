"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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
import { AccountProjectContinuity } from "./account-project-continuity";
import { IdeaSourceBanner } from "@/components/ideas/idea-source-banner";

import { accountDraftChanged as changed, type AccountWorkspace } from "./account-draft-memory";
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
      setWorkspace((previous) => {
        if (previous?.ownerId === session.userId && previous.saved.id === projectId) {
          // A request begun before a successful mutation cannot roll the editor back.
          if (project.current_revision < previous.saved.current_revision) return { ...previous, generation: session.generation };
          if (changed(previous)) return { ...previous, generation: session.generation, conflict: previous.conflict || previous.saved.current_revision !== project.current_revision };
        }
        return { generation: session.generation, ownerId: session.userId, saved: project, draft: accountProjectDraft(project), conflict: false };
      });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !isCurrent(session)) return;
      if (error instanceof AccountRequestError && error.status === 401) expire(session);
      else setLoadError({ generation: session.generation, text: accountErrorMessage(error) });
    });
    return () => controller.abort();
  }, [session, projectId, validId, isCurrent, expire, setWorkspace]);
  useEffect(() => () => mutation.current?.abort(), [session.generation, projectId]);
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
    return false;
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
  async function save(nextDraft?: LocalDraft): Promise<AccountWorkspace | null> {
    const before = drafts.get(projectId);
    if (!isCurrent(account) || busy || !before || before.ownerId !== account.userId || before.generation !== account.generation || before.conflict) return null;
    if (before.pendingGuidedContext && !nextDraft) return saveContext(before.pendingGuidedContext);
    const submittedDraft = nextDraft ?? before.draft;
    let body;
    try { body = updateProjectInputSchema.parse({ expectedRevision: before.saved.current_revision, title: draftTitle(submittedDraft), context: draftContext(submittedDraft, before.saved.context) }); }
    catch { setOperation({ generation: account.generation, projectId, busy: false, error: draftValidationMessage(submittedDraft) }); return null; }
    const controller = begin();
    try {
      const { revision } = await boundedAccountRequest(`/api/projects/${projectId}`, accountRevisionResponseSchema, { method: "PATCH", body, signal: controller.signal });
      if (controller.signal.aborted || !isCurrent(account)) return null;
      if (revision.owner_id !== account.userId || revision.project_id !== projectId) { expire(account); return null; }
      if (revision.revision !== before.saved.current_revision + 1) throw new AccountRequestError(502);
      const previous = drafts.get(projectId);
      if (!previous || previous.ownerId !== account.userId || previous.generation !== account.generation) return null;
      if (previous.saved.current_revision !== before.saved.current_revision) throw new AccountRequestError(409);
      const saved = { ...before.saved, title: body.title ?? before.saved.title, context: revision.context, current_revision: revision.revision };
      const unchanged = JSON.stringify(previous.draft) === JSON.stringify(before.draft) || JSON.stringify(previous.draft) === JSON.stringify(submittedDraft);
      const next = { ...previous, saved, draft: unchanged ? accountProjectDraft(saved) : previous.draft, conflict: false };
      setWorkspace(next);
      setOperation({ generation: account.generation, projectId, busy: false });
      return next;
    } catch (error) { fail(error, controller); return null; }
  }
  async function saveContext(context: ContextSnapshot): Promise<AccountWorkspace | null> {
    const before = drafts.get(projectId);
    if (!isCurrent(account) || busy || !before || before.ownerId !== account.userId || before.generation !== account.generation || before.conflict) return null;
    // A failed automatic save remains owner-bound in session memory. Never replace
    // another unsaved branch just because a new assistant result arrived.
    if (changed(before) && (!before.pendingGuidedContext || JSON.stringify(before.pendingGuidedContext) !== JSON.stringify(context))) return null;
    let body;
    try { body = updateProjectInputSchema.parse({ expectedRevision: before.saved.current_revision, context }); }
    catch { setOperation({ generation: account.generation, projectId, busy: false, error: "This answer could not be saved. Your conversation is kept in this tab." }); return null; }
    const controller = begin();
    setWorkspace({ ...before, pendingGuidedContext: body.context });
    try {
      const { revision } = await boundedAccountRequest(`/api/projects/${projectId}`, accountRevisionResponseSchema, { method: "PATCH", body, signal: controller.signal });
      if (controller.signal.aborted || !isCurrent(account)) return null;
      if (revision.owner_id !== account.userId || revision.project_id !== projectId) { expire(account); return null; }
      if (revision.revision !== before.saved.current_revision + 1) throw new AccountRequestError(502);
      const previous = drafts.get(projectId);
      if (!previous || previous.ownerId !== account.userId || previous.generation !== account.generation) return null;
      if (previous.saved.current_revision !== before.saved.current_revision) throw new AccountRequestError(409);
      const saved = { ...before.saved, context: revision.context, current_revision: revision.revision };
      const edited = JSON.stringify(previous.draft) !== JSON.stringify(before.draft) || JSON.stringify(previous.pendingGuidedContext) !== JSON.stringify(body.context);
      const next = { ...previous, saved, draft: edited ? previous.draft : accountProjectDraft(saved), pendingGuidedContext: edited ? previous.pendingGuidedContext : undefined, conflict: edited };
      setWorkspace(next); setOperation({ generation: account.generation, projectId, busy: false });
      return edited ? null : next;
    } catch (error) { fail(error, controller); return null; }
  }
  async function expand() {
    if (!isCurrent(account) || busy || changed(active) || active.conflict) return;
    const controller = begin();
    try {
      const { project } = await boundedAccountRequest(`/api/projects/${projectId}/expand`, accountProjectResponseSchema, { method: "POST", body: { expectedRevision: active.saved.current_revision }, signal: controller.signal });
      if (controller.signal.aborted || !isCurrent(account)) return;
      if (project.owner_id !== account.userId || project.id !== projectId) { expire(account); return; }
      if (project.scope !== "complete_brand" || project.current_revision !== active.saved.current_revision + 1) throw new AccountRequestError(502);
      setWorkspace((previous) => previous?.ownerId === account.userId && previous.generation === account.generation ? { ...previous, saved: project, draft: previous.draft === active.draft ? accountProjectDraft(project) : { ...previous.draft, scope: project.scope }, conflict: false } : previous);
      setOperation({ generation: account.generation, projectId, busy: false });
    } catch (error) { fail(error, controller); }
  }
  async function loadLatest() {
    if (!isCurrent(account) || busy) return;
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
  }
  function saveBrowserCopy() {
    if (!isCurrent(account) || busy) return;
    const retainedContext = active.pendingGuidedContext ?? active.saved.context;
    const retainedDraft = active.pendingGuidedContext ? accountProjectDraft({ ...active.saved, context: retainedContext }) : active.draft;
    const copy = copyToLocalDraft({ ...retainedDraft, preservedContext: retainedContext });
    if (copy) setBrowserCopy({ generation: account.generation, ...copy });
    else setOperation({ generation: account.generation, projectId, busy: false, error: "This browser has 50 drafts. Remove an unused browser draft before saving a copy." });
  }

  const hasSaveError = operation?.generation === account.generation && operation.projectId === projectId && Boolean(operation.error);
  const showActions = changed(active) || busy || active.conflict || hasSaveError || browserCopy?.generation === account.generation;
  const actions = showActions ? <div className="account-edit-controls">
    {(changed(active) || busy) && <div className="account-actions"><p>Unsaved changes</p><button className="button primary small" type="button" disabled={busy || !changed(active) || active.conflict} onClick={() => void save()}>{busy ? "Saving…" : "Save changes"}</button></div>}
    {operation?.generation === account.generation && operation.projectId === projectId && operation.error && <div><p className="form-error" role="alert">{operation.error}</p>{changed(active) && !active.conflict && <button className="button secondary small" type="button" disabled={busy} onClick={saveBrowserCopy}>Save edits as browser copy</button>}</div>}
    {active.conflict && <div className="account-conflict" role="alert"><strong>A newer version is saved in your account.</strong><p>Your edits are still here. Save them as a browser copy or choose to load the latest account version.</p><div className="account-recovery-actions"><button className="button secondary small" type="button" disabled={busy} onClick={saveBrowserCopy}>Save edits as browser copy</button><button className="button secondary small" type="button" disabled={busy} onClick={() => setConfirmLatest(true)}>Load latest version</button></div>{confirmLatest && <div className="inline-confirm"><p>Replace the edits in this tab with the latest saved version? Save a browser copy first if you want to keep them.</p><button className="button secondary small" type="button" onClick={() => setConfirmLatest(false)}>Keep editing</button><button className="button primary small" type="button" disabled={busy} onClick={() => void loadLatest()}>Replace with latest version</button></div>}</div>}
    {browserCopy?.generation === account.generation && <p className="form-success" role="status">{browserCopy.persisted ? "Your edits were saved as a new draft in this browser." : "Your copy stays in this tab because browser storage is unavailable."} <Link href={`/brands/${browserCopy.id}`}>Open browser copy</Link></p>}
  </div> : null;
  const namingReadiness = getNamingReadiness(active.saved.context, active.saved.scope);
  const namingBlocked = busy || changed(active) || active.conflict || !namingReadiness.ready;
  const namingHint = active.conflict ? "Resolve the saved-version conflict before opening Naming."
    : changed(active) ? "Save your edits before opening Naming."
    : !namingReadiness.ready ? "Finish reviewing your strategy before opening Naming." : null;
  // References come before generation readiness: an incomplete strategy or name
  // must not prevent a saved Identity project from exploring its references.
  const identityBlocked = busy || changed(active) || active.conflict;
  const identityHint = active.conflict ? "Resolve the saved-version conflict before opening Identity."
    : changed(active) ? "Save your edits before opening Identity." : null;
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
  return <AccountGuidedInterview key={`${projectId}:${account.userId}:${account.generation}`} account={account} workspace={active} busy={Boolean(busy)} saveContext={saveContext} storage={{ kind: "account", saveLabel: changed(active) ? "Unsaved changes in this tab" : `Saved to account · version ${active.saved.current_revision}`, onUpdate: update, actions, scopeControl, projectContext, namingSource: active.saved.context.namingSource }} />;
}

function UnavailableProject() {
  return <div className="page"><div className="empty-panel"><h1>Account project not found</h1><p>Check the account project link and try again.</p><Link href="/brands" className="button primary">Back to brands</Link></div></div>;
}
