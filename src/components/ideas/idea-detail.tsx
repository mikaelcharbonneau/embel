"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { createIdeaBrandInputSchema, ideaBrandResponseSchema, ideaResponseSchema, updateIdeaInputSchema, type IdeaContent, type IdeaRecord } from "@/domain/ideas";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { accountRequest, AccountRequestError } from "@/components/workspace/account-api";
import { ideaDraftChanged, type IdeaWorkspace } from "./ideas-draft-memory";
import { ideaErrorMessage, ideaStateLabels, sameIdeaId } from "./ideas-client";
import { IdeasUnavailable } from "./ideas-workspace";
import "@/styles/ideas.css";
import { AttachIdeaControl } from "@/features/idea-project-attachment/attach-control";

const emptyWorkspace = () => null;
const details: { field: keyof IdeaContent["details"]; label: string; hint?: string }[] = [
  { field: "problem", label: "Problem" },
  { field: "audience", label: "Audience" },
  { field: "solution", label: "Proposed solution" },
  { field: "differentiation", label: "Differentiation" },
  { field: "revenueHypotheses", label: "Revenue hypotheses", hint: "Your hypotheses to test; no revenue research or validation is implied." },
  { field: "validationSteps", label: "Validation steps" },
  { field: "notes", label: "Notes" },
];

export function IdeaDetail({ ideaId }: { ideaId: string }) {
  const { session, ideaDrafts } = useAccountSession();
  if (!z.uuid().safeParse(ideaId).success) return <div className="page ideas-page"><h1>Idea not found</h1><Link href="/ideas" className="text-link">Back to ideas</Link></div>;
  return <div className="page ideas-page idea-detail-page">
    <div className="ideas-back"><Link href="/ideas" className="text-link">Back to ideas</Link></div>
    {session.status === "ready" ? <OwnedIdeaDetail key={`${ideaId}:${session.userId}:${session.generation}`} ideaId={ideaId.toLowerCase()} account={session} /> : <><div className="page-heading ideas-heading"><h1>Account idea</h1></div><AccountStatus retainedEdits={ideaDrafts.hasUnsaved()} /></>}
    <IdeasUnavailable />
  </div>;
}

function OwnedIdeaDetail({ account, ideaId }: { account: VerifiedAccount; ideaId: string }) {
  const { ideaDrafts, isCurrent, expire, refresh, lifecycleMemory } = useAccountSession();
  const readWorkspace = useCallback(() => ideaDrafts.get(account.userId, ideaId), [ideaDrafts, account.userId, ideaId]);
  const workspace = useSyncExternalStore(ideaDrafts.subscribe, readWorkspace, emptyWorkspace);
  const [verifiedRead, setVerifiedRead] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "brand" | "load" | null>(null);
  const [confirmLatest, setConfirmLatest] = useState(false);
  const readRequest = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const active = useRef(false);
  const router = useRouter();
  const put = useCallback((next: IdeaWorkspace) => {
    if (!ideaDrafts.set(next)) { setLoadError("This tab holds 20 ideas with unsaved edits. Save one before opening another."); return false; }
    return true;
  }, [ideaDrafts]);
  const owned = useCallback((idea: IdeaRecord) => {
    if (sameIdeaId(idea.ownerId, account.userId) && sameIdeaId(idea.id, ideaId)) return true;
    expire(account); return false;
  }, [account, ideaId, expire]);
  useEffect(() => {
    active.current = true;
    const controller = new AbortController(); readRequest.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    void accountRequest(`/api/ideas/${ideaId}`, ideaResponseSchema, { signal: controller.signal }).then(({ idea }) => {
      if (!active.current || controller.signal.aborted || readRequest.current !== controller || !isCurrent(account) || !owned(idea)) return;
      const previous = ideaDrafts.get(account.userId, ideaId);
      const next = previous && (ideaDraftChanged(previous) || previous.saved.revision > idea.revision) ? {
        ...previous, generation: account.generation, conflict: previous.conflict || idea.revision > previous.saved.revision,
      } : {
        ownerId: account.userId, generation: account.generation, saved: idea, content: idea.content, conflict: false,
        saveIntent: previous?.saveIntent ?? null, brandIntent: previous?.brandIntent ?? null,
      };
      if (put(next)) { setVerifiedRead(true); setLoadError(null); }
    }).catch(cause => {
      if (!active.current || readRequest.current !== controller || !isCurrent(account)) return;
      if (cause instanceof AccountRequestError && cause.status === 401) expire(account);
      else setLoadError(ideaErrorMessage(cause));
    }).finally(() => { window.clearTimeout(timeout); if (readRequest.current === controller) readRequest.current = null; });
    return () => { active.current = false; readRequest.current?.abort(); readRequest.current = null; mutation.current?.abort(); mutation.current = null; };
  }, [account, ideaId, ideaDrafts, isCurrent, expire, owned, put]);

  function edit(next: IdeaContent) {
    if (!active.current || !isCurrent(account) || mutation.current) return;
    const before = ideaDrafts.get(account.userId, ideaId);
    if (!before || before.generation !== account.generation) return;
    put({ ...before, content: next, saveIntent: null, brandIntent: null }); setError(null); setConfirmLatest(false);
  }
  function begin(kind: "save" | "brand" | "load") {
    if (!active.current || !isCurrent(account) || mutation.current) return null;
    const controller = new AbortController(); mutation.current = controller; setBusy(kind); setError(null); return controller;
  }
  function accepts(controller: AbortController) { return active.current && mutation.current === controller && !controller.signal.aborted && isCurrent(account); }
  function fail(cause: unknown, controller: AbortController, write = true) {
    if (!active.current || mutation.current !== controller || !isCurrent(account)) return;
    if (cause instanceof AccountRequestError && cause.status === 401) { expire(account); return; }
    if (cause instanceof AccountRequestError && cause.status === 409) {
      const previous = ideaDrafts.get(account.userId, ideaId);
      if (previous) put({ ...previous, conflict: true });
      setError(null);
    } else setError(ideaErrorMessage(cause, write));
  }
  function finish(controller: AbortController, timeout: number) {
    window.clearTimeout(timeout);
    if (mutation.current === controller) { mutation.current = null; if (active.current && isCurrent(account)) setBusy(null); }
  }
  async function save() {
    const before = ideaDrafts.get(account.userId, ideaId);
    if (!before || before.generation !== account.generation || mutation.current || !isCurrent(account) || (before.conflict && !before.saveIntent)) return;
    let body;
    try { body = updateIdeaInputSchema.parse(before.saveIntent ?? { requestKey: crypto.randomUUID(), expectedRevision: before.saved.revision, content: before.content }); }
    catch { setError("Add an idea title and check the field lengths. Your edits are still here."); return; }
    const controller = begin("save"); if (!controller) return;
    put({ ...before, saveIntent: body, brandIntent: null });
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const { idea } = await accountRequest(`/api/ideas/${ideaId}`, ideaResponseSchema, { method: "PATCH", body, signal: controller.signal });
      if (!accepts(controller) || !owned(idea)) return;
      if (idea.revision !== body.expectedRevision + 1 || JSON.stringify(idea.content) !== JSON.stringify(body.content)) throw new AccountRequestError(502);
      const previous = ideaDrafts.get(account.userId, ideaId);
      if (!previous || previous.generation !== account.generation) return;
      if (previous.saved.revision > idea.revision) throw new AccountRequestError(409);
      const unchanged = JSON.stringify(previous.content) === JSON.stringify(before.content);
      put({ ...previous, saved: idea, content: unchanged ? idea.content : previous.content, conflict: false, saveIntent: null });
    } catch (cause) { fail(cause, controller); }
    finally { finish(controller, timeout); }
  }
  async function createBrand() {
    const before = ideaDrafts.get(account.userId, ideaId);
    if (!before || before.generation !== account.generation || ideaDraftChanged(before) || (before.conflict && !before.brandIntent) || mutation.current || !isCurrent(account)) return;
    const body = createIdeaBrandInputSchema.parse(before.brandIntent ?? { requestKey: crypto.randomUUID(), expectedRevision: before.saved.revision });
    const controller = begin("brand"); if (!controller) return;
    put({ ...before, brandIntent: body });
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const { idea, link } = await accountRequest(`/api/ideas/${ideaId}/brand`, ideaBrandResponseSchema, { method: "POST", body, signal: controller.signal });
      if (!accepts(controller) || !owned(idea)) return;
      if (link.ideaRevision !== body.expectedRevision || !sameIdeaId(link.requestKey, body.requestKey) || !idea.links.some(item => item.id === link.id && item.projectId === link.projectId && item.requestKey === link.requestKey && item.ideaRevision === link.ideaRevision) || idea.revision < body.expectedRevision + 1) throw new AccountRequestError(502);
      const previous = ideaDrafts.get(account.userId, ideaId);
      if (!previous || previous.generation !== account.generation) return;
      put({ ...previous, saved: idea, content: idea.content, conflict: false, saveIntent: null, brandIntent: null });
      router.push(`/brands/account/${link.projectId}`);
    } catch (cause) { fail(cause, controller); }
    finally { finish(controller, timeout); }
  }
  async function loadLatest() {
    const before = ideaDrafts.get(account.userId, ideaId); if (!before) return;
    const controller = begin("load"); if (!controller) return;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const { idea } = await accountRequest(`/api/ideas/${ideaId}`, ideaResponseSchema, { signal: controller.signal });
      if (!accepts(controller) || !owned(idea)) return;
      if (ideaDrafts.get(account.userId, ideaId)?.content !== before.content) throw new AccountRequestError(409);
      put({ ownerId: account.userId, generation: account.generation, saved: idea, content: idea.content, conflict: false, saveIntent: null, brandIntent: null });
      setConfirmLatest(false); setVerifiedRead(true); setLoadError(null);
    } catch (cause) { fail(cause, controller, false); }
    finally { finish(controller, timeout); }
  }

  const current = verifiedRead && workspace?.generation === account.generation && sameIdeaId(workspace.ownerId, account.userId) && sameIdeaId(workspace.saved.id, ideaId) ? workspace : null;
  if (!current) return <><div className="page-heading ideas-heading"><h1>Account idea</h1></div>{loadError ? <div><p className="form-error" role="alert">{loadError}</p><p className="field-hint">Any unsaved idea edits remain in this tab for the same account.</p><button className="button secondary small idea-read-retry" type="button" onClick={() => { if (isCurrent(account)) refresh(); }}>Try loading idea again</button></div> : <p className="quiet-empty" role="status">Loading your idea…</p>}</>;
  const dirty = ideaDraftChanged(current);
  const converted = current.saved.content.state === "used" && current.saved.links.some(link => link.ideaRevision === current.saved.revision - 1);
  return <>
    <div className="page-heading ideas-heading"><h1>{current.content.title || "Untitled idea"}</h1><span className="small-badge">Account idea</span></div>
    <form className="idea-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset className="ideas-fields" disabled={Boolean(busy)}>
        <label className="ideas-field">Idea title<input value={current.content.title} maxLength={160} required onChange={event => edit({ ...current.content, title: event.target.value })} /></label>
        <label className="ideas-field">Description (optional)<textarea value={current.content.description} maxLength={12000} rows={4} onChange={event => edit({ ...current.content, description: event.target.value })} /></label>
        <div className="idea-metadata-fields"><label className="ideas-field">Idea state<select value={current.content.state} onChange={event => edit({ ...current.content, state: event.target.value as IdeaContent["state"] })}>{Object.entries(ideaStateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="ideas-field">Theme (optional)<input value={current.content.theme} maxLength={120} onChange={event => edit({ ...current.content, theme: event.target.value })} /></label></div>
        <details className="idea-development"><summary>Develop this idea</summary><p className="field-hint">Optional notes you write and refine. No research or strategy approval is implied.</p><div className="idea-development-fields">{details.map(({ field, label, hint }) => <label key={field} className="ideas-field">{label}{hint && <span className="field-hint">{hint}</span>}<textarea aria-label={label} value={current.content.details[field]} maxLength={2000} rows={3} onChange={event => edit({ ...current.content, details: { ...current.content.details, [field]: event.target.value } })} /></label>)}</div></details>
      </fieldset>
      <div className="idea-save-actions"><p className="field-hint" role="status">{dirty ? "Your edits stay in this tab until you save." : `Saved to account · version ${current.saved.revision}.`}</p><button className="button primary small" type="submit" disabled={Boolean(busy) || (!dirty && !current.saveIntent) || (current.conflict && !current.saveIntent)}>{busy === "save" ? "Saving…" : current.saveIntent ? "Retry save" : "Save changes"}</button></div>
    </form>
    {current.conflict && <div className="account-conflict idea-recovery" role="alert"><strong>A newer version is saved in your account.</strong><p>Your edits are still here. Retry the original save or explicitly load the latest version.</p></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {(error || current.conflict || current.saveIntent || current.brandIntent) && <div className="idea-recovery"><button className="button secondary small" type="button" disabled={Boolean(busy)} onClick={() => setConfirmLatest(true)}>Load latest version</button>{confirmLatest && <div className="inline-confirm"><p>Replace the edits in this tab with the latest saved version? This also discards the pending retry.</p><button className="button secondary small" type="button" disabled={Boolean(busy)} onClick={() => setConfirmLatest(false)}>Keep editing</button><button className="button primary small" type="button" disabled={Boolean(busy)} onClick={() => void loadLatest()}>Replace with latest version</button></div>}</div>}
    <section className="idea-brand-section" aria-labelledby="idea-brand-heading"><div><h2 id="idea-brand-heading">Continue as a brand</h2><p>Use the saved title, description, solution and audience. Your original idea version stays linked to the new brand.</p></div><button className="button secondary small" type="button" disabled={Boolean(busy) || dirty || (current.conflict && !current.brandIntent) || (converted && !current.brandIntent)} onClick={() => void createBrand()}>{busy === "brand" ? "Creating brand…" : current.brandIntent ? "Retry creating brand" : "Create brand"}</button>{dirty && <p className="field-hint">Save your edits before creating a brand.</p>}{converted && !current.brandIntent && <p className="field-hint">This saved version has already been used to create a brand.</p>}</section>
    <AttachIdeaControl account={account} idea={current.saved} dirty={dirty || current.conflict} pending={Boolean(busy || current.saveIntent || current.brandIntent)} memory={lifecycleMemory} />
    {current.saved.links.length > 0 && <section className="idea-brand-links" aria-labelledby="idea-brand-links-heading"><h2 id="idea-brand-links-heading">Created brands</h2>{current.saved.links.map(link => <div key={link.id}><Link className="text-link" href={`/brands/account/${link.projectId}`}>Open created brand</Link><span className="field-hint">From idea version {link.ideaRevision}</span></div>)}</section>}
  </>;
}
