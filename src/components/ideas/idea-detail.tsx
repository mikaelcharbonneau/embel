"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { createIdeaBrandInputSchema, ideaBrandResponseSchema, ideaResponseSchema, updateIdeaInputSchema, type IdeaContent, type IdeaRecord } from "@/domain/ideas";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { accountRequest, AccountRequestError } from "@/components/workspace/account-api";
import { ideaDraftChanged, type IdeaWorkspace } from "./ideas-draft-memory";
import { ideaErrorMessage, ideaStateLabels, sameIdeaId } from "./ideas-client";
import { Icon } from "@/components/ui/icon";
import "@/styles/ideas.css";
import { AttachIdeaControl } from "@/features/idea-project-attachment/attach-control";

const emptyWorkspace = () => null;
export const IDEA_AUTOSAVE_DELAY_MS = 600;
const details: { field: keyof IdeaContent["details"]; label: string; hint?: string }[] = [
  { field: "problem", label: "Problem" },
  { field: "solution", label: "Solution" },
  { field: "audience", label: "Audience" },
  { field: "differentiation", label: "Differentiation" },
  { field: "revenueHypotheses", label: "Revenue hypotheses", hint: "Your hypotheses to test; no revenue research or validation is implied." },
  { field: "validationSteps", label: "Validation steps" },
  { field: "notes", label: "Notes" },
];

export function IdeaDetail({ ideaId }: { ideaId: string }) {
  const { session, ideaDrafts } = useAccountSession();
  if (!z.uuid().safeParse(ideaId).success) return <div className="page ideas-page idea-detail-page"><h1>Idea not found</h1><Link href="/ideas" className="text-link">Back to ideas</Link></div>;
  return <div className="page ideas-page idea-detail-page">
    {session.status === "ready" ? <OwnedIdeaDetail key={`${ideaId}:${session.userId}:${session.generation}`} ideaId={ideaId.toLowerCase()} account={session} /> : <><div className="page-heading ideas-heading"><h1>Account idea</h1></div><AccountStatus retainedEdits={ideaDrafts.hasUnsaved()} /></>}
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
  const mutationKind = useRef<"save" | "brand" | "load" | null>(null);
  const saveAction = useRef<() => Promise<void>>(async () => {});
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
      const next = previous && (ideaDraftChanged(previous) || previous.saveIntent || previous.brandIntent || previous.saved.revision > idea.revision) ? {
        ...previous, generation: account.generation, conflict: previous.conflict || idea.revision > previous.saved.revision,
      } : {
        ownerId: account.userId, generation: account.generation, saved: idea, content: idea.content, conflict: false,
        saveIntent: previous?.saveIntent ?? null, brandIntent: previous?.brandIntent ?? null,
      };
      if (put(next)) {
        setVerifiedRead(true); setLoadError(null);
        if (next.saveIntent) setError("An earlier save is not confirmed. Retry it to continue saving your edits.");
      }
    }).catch(cause => {
      if (!active.current || readRequest.current !== controller || !isCurrent(account)) return;
      if (cause instanceof AccountRequestError && cause.status === 401) expire(account);
      else setLoadError(ideaErrorMessage(cause));
    }).finally(() => { window.clearTimeout(timeout); if (readRequest.current === controller) readRequest.current = null; });
    return () => { active.current = false; readRequest.current?.abort(); readRequest.current = null; mutation.current?.abort(); mutation.current = null; mutationKind.current = null; };
  }, [account, ideaId, ideaDrafts, isCurrent, expire, owned, put]);

  function edit(next: IdeaContent) {
    if (!active.current || !isCurrent(account) || (mutation.current && mutationKind.current !== "save")) return;
    const before = ideaDrafts.get(account.userId, ideaId);
    if (!before || before.generation !== account.generation) return;
    // A delayed or lost acknowledgement still belongs to its exact original
    // request. New typing is a separate branch until that request is confirmed.
    put({ ...before, content: next });
    if (!before.saveIntent && !before.brandIntent) setError(null);
    setConfirmLatest(false);
  }
  function begin(kind: "save" | "brand" | "load") {
    if (!active.current || !isCurrent(account) || mutation.current) return null;
    const controller = new AbortController(); mutation.current = controller; mutationKind.current = kind; setBusy(kind); setError(null); return controller;
  }
  function accepts(controller: AbortController) { return active.current && mutation.current === controller && !controller.signal.aborted && isCurrent(account); }
  function fail(cause: unknown, controller: AbortController, write = true) {
    if (!active.current || mutation.current !== controller || !isCurrent(account)) return;
    if (cause instanceof AccountRequestError && cause.status === 401) { expire(account); return; }
    if (cause instanceof AccountRequestError && cause.status === 409) {
      const previous = ideaDrafts.get(account.userId, ideaId);
      if (previous) put({ ...previous, conflict: true });
      setError(null);
    } else {
      // These responses conclusively reject the submitted content. A corrected
      // edit may create a new request; unknown transport/server outcomes may not.
      if (mutationKind.current === "save" && cause instanceof AccountRequestError && (cause.status === 413 || cause.status === 422)) {
        const previous = ideaDrafts.get(account.userId, ideaId);
        if (previous) put({ ...previous, saveIntent: null });
      }
      setError(ideaErrorMessage(cause, write));
    }
  }
  function finish(controller: AbortController, timeout: number) {
    window.clearTimeout(timeout);
    if (mutation.current === controller) { mutation.current = null; mutationKind.current = null; if (active.current && isCurrent(account)) setBusy(null); }
  }
  async function save() {
    const before = ideaDrafts.get(account.userId, ideaId);
    if (!before || before.generation !== account.generation || mutation.current || !isCurrent(account) || before.brandIntent || (before.conflict && !before.saveIntent) || (!ideaDraftChanged(before) && !before.saveIntent)) return;
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
      const latest = updateIdeaInputSchema.safeParse({ ...body, content: previous.content });
      const unchanged = latest.success && JSON.stringify(latest.data.content) === JSON.stringify(body.content);
      put({ ...previous, saved: idea, content: unchanged ? idea.content : previous.content, conflict: false, saveIntent: null });
    } catch (cause) { fail(cause, controller); }
    finally { finish(controller, timeout); }
  }
  useLayoutEffect(() => { saveAction.current = save; });
  useEffect(() => {
    if (!verifiedRead || !workspace || workspace.generation !== account.generation || !sameIdeaId(workspace.ownerId, account.userId) ||
        !isCurrent(account) || busy || error || workspace.conflict || workspace.saveIntent || workspace.brandIntent || !ideaDraftChanged(workspace)) return;
    const timer = window.setTimeout(() => { void saveAction.current(); }, IDEA_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [account, workspace, verifiedRead, busy, error, isCurrent]);

  async function createBrand() {
    const before = ideaDrafts.get(account.userId, ideaId);
    if (!before || before.generation !== account.generation || before.saveIntent || (ideaDraftChanged(before) && !before.brandIntent) || (before.conflict && !before.brandIntent) || mutation.current || !isCurrent(account)) return;
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
      put({ ...previous, saved: idea, content: ideaDraftChanged(previous) ? previous.content : idea.content, conflict: false, saveIntent: null, brandIntent: null });
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
  const saveDisabled = Boolean(busy) || Boolean(current.brandIntent) || (!dirty && !current.saveIntent) || (current.conflict && !current.saveIntent);
  const saveProblem = Boolean(error || current.conflict || (current.saveIntent && busy !== "save"));
  const saving = busy === "save" || (dirty && !saveProblem && !current.brandIntent);
  const brandDisabled = Boolean(busy || current.saveIntent) || (dirty && !current.brandIntent) || (current.conflict && !current.brandIntent) || (converted && !current.brandIntent);
  return <>
    <header className="page-heading idea-detail-heading">
      <div><h1>{current.content.title || "Untitled idea"}<span>.</span></h1><p>{current.content.state === "developing" ? "An idea in development." : current.content.state === "used" ? "An idea taking shape as a brand." : "An idea worth exploring."}</p></div>
      <div className="idea-detail-save" role="status" aria-label="Save status"><span>{saving ? "Saving…" : saveProblem ? "Not saved" : dirty ? "Unsaved changes" : "Saved"}</span>{saveProblem && (dirty || current.saveIntent) && <button className="button secondary small" type="button" disabled={saveDisabled} onClick={() => void save()}>Retry</button>}</div>
    </header>
    <div className="idea-detail-columns">
      <div className="idea-detail-main">
        <form id="idea-detail-form" className="idea-detail-form" onSubmit={event => { event.preventDefault(); if (!error && !current.saveIntent && !current.conflict) void save(); }}>
          <fieldset className="ideas-fields idea-detail-panel" disabled={busy === "brand" || busy === "load"}>
            <label className="ideas-field">Idea title<input value={current.content.title} maxLength={160} required onChange={event => edit({ ...current.content, title: event.target.value })} /></label>
            <label className="ideas-field">Description<textarea aria-label="Description (optional)" className="idea-description" value={current.content.description} maxLength={12000} rows={4} onChange={event => edit({ ...current.content, description: event.target.value })} /></label>
            <div className="idea-metadata-fields"><label className="ideas-field">Idea state<select value={current.content.state} onChange={event => edit({ ...current.content, state: event.target.value as IdeaContent["state"] })}>{Object.entries(ideaStateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="ideas-field">Theme<input aria-label="Theme (optional)" value={current.content.theme} maxLength={120} onChange={event => edit({ ...current.content, theme: event.target.value })} /></label></div>
          </fieldset>
          <fieldset className="ideas-fields idea-detail-panel" disabled={busy === "brand" || busy === "load"}>
            <legend className="sr-only">Develop this idea</legend>
            <h2 aria-hidden="true">Develop this idea</h2>
            {details.slice(0, 3).map(({ field, label }) => <IdeaNoteField key={field} label={label} accessibleLabel={field === "solution" ? "Proposed solution" : label} value={current.content.details[field]} onChange={value => edit({ ...current.content, details: { ...current.content.details, [field]: value } })} />)}
            <details className="idea-extra-details"><summary>More details</summary><p className="field-hint">Optional notes you write and refine.</p><div className="ideas-fields">{details.slice(3).map(({ field, label, hint }) => <IdeaNoteField key={field} label={label} hint={hint} value={current.content.details[field]} onChange={value => edit({ ...current.content, details: { ...current.content.details, [field]: value } })} />)}</div></details>
          </fieldset>
        </form>
        <p className="idea-detail-save-state" role="status">{saving ? "Saving to account…" : saveProblem ? "Your edits are retained until account saving is confirmed." : dirty ? "Your edits are waiting to save." : `Saved to account · version ${current.saved.revision}.`}</p>
        {current.conflict && <div className="account-conflict idea-recovery" role="alert"><strong>A newer version is saved in your account.</strong><p>Your edits are still here. Retry the original save or explicitly load the latest version.</p></div>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {(error || current.conflict || current.saveIntent || current.brandIntent) && <div className="idea-recovery"><button className="button secondary small" type="button" disabled={Boolean(busy)} onClick={() => setConfirmLatest(true)}>Load latest version</button>{confirmLatest && <div className="inline-confirm"><p>Replace the edits in this tab with the latest saved version? This also discards the pending retry.</p><button className="button secondary small" type="button" disabled={Boolean(busy)} onClick={() => setConfirmLatest(false)}>Keep editing</button><button className="button primary small" type="button" disabled={Boolean(busy)} onClick={() => void loadLatest()}>Replace with latest version</button></div>}</div>}
      </div>
      <aside className="idea-detail-aside" aria-label="Idea context">
        <section className="idea-detail-panel idea-brand-next" aria-labelledby="idea-brand-heading">
          <Icon name="brands" size={24} />
          <h2 id="idea-brand-heading">Continue as a brand</h2>
          <p>Use this idea as the starting point for your strategy, name, and visual identity.</p>
          <button className="button secondary" type="button" disabled={brandDisabled} onClick={() => void createBrand()}>{busy === "brand" ? "Creating brand…" : current.brandIntent ? "Retry creating brand" : "Create brand"}<Icon name="arrow" size={17} /></button>
          <p className="idea-detail-caption">Your original idea stays linked.</p>
          {dirty && <p className="field-hint">Your edits must finish saving before creating a brand.</p>}
          {converted && !current.brandIntent && <p className="field-hint">This saved version has already been used to create a brand.</p>}
        </section>
        <section className="idea-detail-panel idea-detail-metadata" aria-labelledby="idea-details-heading"><h2 id="idea-details-heading">Details</h2><dl><div><dt>State</dt><dd>{ideaStateLabels[current.content.state]}</dd></div><div><dt>Version</dt><dd>{current.saved.revision}</dd></div><div><dt>Storage</dt><dd>Account idea</dd></div></dl></section>
        {current.saved.links.length > 0 && <section className="idea-detail-panel idea-created-brands" aria-labelledby="idea-brand-links-heading"><h2 id="idea-brand-links-heading">Created brands</h2>{current.saved.links.map(link => <div key={link.id}><Link className="text-link" href={`/brands/account/${link.projectId}`}>Open created brand<Icon name="arrow" size={16} /></Link><span className="field-hint">From idea version {link.ideaRevision}</span></div>)}</section>}
      </aside>
    </div>
    <div className="idea-detail-attachment"><AttachIdeaControl account={account} idea={current.saved} dirty={dirty || current.conflict} pending={Boolean(busy || current.saveIntent || current.brandIntent)} memory={lifecycleMemory} /></div>
  </>;
}

function IdeaNoteField({ label, accessibleLabel = label, hint, value, onChange }: { label: string; accessibleLabel?: string; hint?: string; value: string; onChange: (value: string) => void }) {
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    let width = -1;
    const resize = () => {
      if (!element.getClientRects().length) return;
      width = element.clientWidth;
      element.style.height = "auto";
      element.style.height = `${Math.max(44, Math.min(360, element.scrollHeight + 2))}px`;
    };
    resize();
    const observer = new ResizeObserver(() => { if (element.clientWidth !== width) resize(); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [value]);
  return <label className="ideas-field">{label}{hint && <span className="field-hint">{hint}</span>}<textarea ref={input} aria-label={accessibleLabel} value={value} maxLength={2000} rows={1} onChange={event => onChange(event.target.value)} /></label>;
}
