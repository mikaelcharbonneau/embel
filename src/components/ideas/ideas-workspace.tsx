"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createIdeaInputSchema, ideaResponseSchema, ideaPageSchema, type IdeaState } from "@/domain/ideas";
import { Icon } from "@/components/ui/icon";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { accountRequest, AccountRequestError } from "@/components/workspace/account-api";
import { emptyIdeaContent, ideaErrorMessage, ideaStateLabels, mergeIdeaPage, sameIdeaId, type IdeaListing } from "./ideas-client";
import "@/styles/ideas.css";

const emptyCapture = () => null;

export function IdeasWorkspace() {
  const { session, ideaDrafts } = useAccountSession();
  return <div className="page ideas-page ideas-home">
    {session.status === "ready" ? <OwnedIdeasWorkspace key={`${session.userId}:${session.generation}`} account={session} /> : <><IdeasHeading /><AccountStatus retainedEdits={ideaDrafts.hasUnsaved()} /></>}
  </div>;
}

function IdeasHeading({ captureOpen = false, onToggleCapture }: { captureOpen?: boolean; onToggleCapture?: () => void }) {
  return <header className="page-heading ideas-heading">
    <div className="ideas-introduction"><h1>Room for your next idea<span>.</span></h1><p>Capture it now. Give it shape when you are ready.</p></div>
    <button className="button primary ideas-add" type="button" disabled={!onToggleCapture} aria-expanded={captureOpen} aria-controls={onToggleCapture ? "idea-capture-panel" : undefined} onClick={onToggleCapture}>{captureOpen ? "Close capture" : "Add idea"}<Icon name={captureOpen ? "close" : "plus"} size={17} /></button>
  </header>;
}

export function IdeasUnavailable() {
  return <div className="availability-note ideas-unavailable"><Icon name="offline" size={18} /><p>AI exploration is unavailable.</p></div>;
}

function OwnedIdeasWorkspace({ account }: { account: VerifiedAccount }) {
  const { ideaDrafts } = useAccountSession();
  const [captureOpen, setCaptureOpen] = useState(() => Boolean(ideaDrafts.getCapture(account.userId)));
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState<{ search: string; state: IdeaState | "all" }>({ search: "", state: "all" });
  return <>
    <IdeasHeading captureOpen={captureOpen} onToggleCapture={() => setCaptureOpen(value => !value)} />
    <div id="idea-capture-panel" hidden={!captureOpen}><IdeaCaptureForm account={account} /></div>
    <section className="ideas-library" aria-labelledby="ideas-library-heading">
      <h2 id="ideas-library-heading" className="sr-only">Your ideas</h2>
      <form className="ideas-filters" role="search" onSubmit={event => { event.preventDefault(); setQuery(previous => previous.search === search.trim() ? previous : { ...previous, search: search.trim() }); }}>
        <label className="ideas-field ideas-search"><span className="sr-only">Search ideas</span><input type="search" enterKeyHint="search" aria-describedby="ideas-search-hint" value={search} maxLength={200} onChange={event => setSearch(event.target.value)} placeholder="Search your ideas" /></label>
        <label className="ideas-field ideas-filter-state"><span className="sr-only">Filter by state</span><span className="ideas-state-display" aria-hidden="true">{query.state === "all" ? "All states" : ideaStateLabels[query.state]}<Icon name="chevron" size={17} /></span><select value={query.state} onChange={event => { const state = event.target.value as IdeaState | "all"; setQuery(previous => previous.search === search.trim() && previous.state === state ? previous : { search: search.trim(), state }); }}><option value="all">All states</option>{Object.entries(ideaStateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </form>
      <p id="ideas-search-hint" className="sr-only">Press Enter to search all your saved ideas. State filters also apply across the full library.</p>
      <OwnedIdeaListing account={account} query={query} />
    </section>
  </>;
}

function IdeaCaptureForm({ account }: { account: VerifiedAccount }) {
  const { ideaDrafts, isCurrent, expire } = useAccountSession();
  const readCapture = useCallback(() => ideaDrafts.getCapture(account.userId), [ideaDrafts, account.userId]);
  const capture = useSyncExternalStore(ideaDrafts.subscribe, readCapture, emptyCapture);
  const blank = useMemo(() => emptyIdeaContent(), []);
  const content = capture?.content ?? blank;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const active = useRef(false);
  const router = useRouter();
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; request.current?.abort(); request.current = null; };
  }, []);

  function edit(field: "title" | "description", value: string) {
    // A lost acknowledgement may already have created the idea. Keep its exact
    // request until replay confirms it, including after this form is reopened.
    if (!isCurrent(account) || request.current || ideaDrafts.getCapture(account.userId)?.intent) return;
    ideaDrafts.setCapture({ ownerId: account.userId, generation: account.generation, content: { ...content, [field]: value }, intent: null });
    setError(null);
  }
  async function save() {
    if (!active.current || !isCurrent(account) || request.current) return;
    const before = ideaDrafts.getCapture(account.userId);
    let body;
    try { body = createIdeaInputSchema.parse(before?.intent ?? { requestKey: crypto.randomUUID(), content: before?.content ?? blank }); }
    catch { setError("Add an idea title and check the field lengths. Your text is still here."); return; }
    const controller = new AbortController();
    request.current = controller;
    ideaDrafts.setCapture({ ownerId: account.userId, generation: account.generation, content: before?.content ?? blank, intent: body });
    setBusy(true); setError(null);
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const { idea } = await accountRequest("/api/ideas", ideaResponseSchema, { method: "POST", body, signal: controller.signal, expectedOwnerId: account.userId });
      if (!active.current || controller.signal.aborted || request.current !== controller || !isCurrent(account)) return;
      if (!sameIdeaId(idea.ownerId, account.userId)) { expire(account); return; }
      // A replay may return a head edited later. The original creation is still bound by its request key.
      ideaDrafts.clearCapture(account.userId);
      router.push(`/ideas/${idea.id}`);
    } catch (cause) {
      if (!active.current || request.current !== controller || !isCurrent(account)) return;
      if (cause instanceof AccountRequestError && cause.status === 401) expire(account);
      else {
        // These responses conclusively reject the content, so corrections may
        // use a new request. Transport/server failures keep the original intent.
        if (cause instanceof AccountRequestError && (cause.status === 413 || cause.status === 422)) {
          const current = ideaDrafts.getCapture(account.userId);
          if (current) ideaDrafts.setCapture({ ...current, intent: null });
        }
        setError(ideaErrorMessage(cause, true));
      }
    } finally {
      window.clearTimeout(timeout);
      if (request.current === controller) { request.current = null; if (active.current && isCurrent(account)) setBusy(false); }
    }
  }
  return <section className="ideas-capture" aria-labelledby="idea-capture-heading">
    <h2 id="idea-capture-heading">Capture an idea</h2>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy} className="ideas-fields">
        <label className="ideas-field">Idea title<input value={content.title} readOnly={Boolean(capture?.intent)} aria-describedby={capture?.intent && !busy ? "idea-capture-recovery" : undefined} maxLength={160} onChange={event => edit("title", event.target.value)} placeholder="A working title is enough" required /></label>
        <label className="ideas-field">Description (optional)<textarea value={content.description} readOnly={Boolean(capture?.intent)} aria-describedby={capture?.intent && !busy ? "idea-capture-recovery" : undefined} maxLength={12000} rows={2} onChange={event => edit("description", event.target.value)} placeholder="What sparked the idea?" /></label>
      </fieldset>
      <div className="ideas-capture-actions"><p className="field-hint">Add the details when you’re ready.</p><button className="button primary small" type="submit" disabled={!content.title.trim()} aria-disabled={busy} aria-busy={busy}>{busy ? "Saving idea…" : capture?.intent ? "Retry saving idea" : "Save idea"}<Icon name="arrow" size={15} /></button></div>
      {capture?.intent && !busy && <p id="idea-capture-recovery" className="field-hint" role="status">Retry the pending save before editing. This avoids creating the same idea twice.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  </section>;
}

function OwnedIdeaListing({ account, query }: { account: VerifiedAccount; query: { search: string; state: IdeaState | "all" } }) {
  const { isCurrent, expire } = useAccountSession();
  const queryKey = JSON.stringify(query);
  const [snapshot, setSnapshot] = useState<{ queryKey: string; listing: IdeaListing } | null>(null);
  const listing = snapshot?.listing ?? null;
  const changingQuery = Boolean(snapshot && snapshot.queryKey !== queryKey);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loaded = useRef<{ queryKey: string; listing: IdeaListing } | null>(null);
  const request = useRef<AbortController | null>(null);
  const active = useRef(false);
  const activeQuery = useRef<string | null>(null);
  const load = useCallback(async () => {
    if (!active.current || activeQuery.current !== queryKey || !isCurrent(account) || request.current) return;
    // Keep the previous verified grid visible, but never reuse its cursor for
    // another filter or merge responses belonging to different queries.
    const previous = loaded.current?.queryKey === queryKey ? loaded.current.listing : null;
    const cursor = previous?.nextCursor ?? null;
    if (previous && !cursor) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(null);
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    const params = new URLSearchParams({ limit: "25", search: query.search });
    if (query.state !== "all") params.set("state", query.state);
    if (cursor) { params.set("cursorCreatedAt", cursor.createdAt); params.set("cursorId", cursor.id); }
    try {
      const page = await accountRequest(`/api/ideas?${params}`, ideaPageSchema, { signal: controller.signal });
      if (!active.current || activeQuery.current !== queryKey || controller.signal.aborted || request.current !== controller || !isCurrent(account)) return;
      if (!sameIdeaId(page.ownerId, account.userId)) { expire(account); return; }
      const next = { queryKey, listing: mergeIdeaPage(previous, page, cursor) };
      loaded.current = next; setSnapshot(next);
    } catch (cause) {
      if (!active.current || activeQuery.current !== queryKey || request.current !== controller || !isCurrent(account)) return;
      if (cause instanceof AccountRequestError && cause.status === 401) expire(account);
      else setError("Your account ideas could not be loaded. Try again.");
    } finally {
      window.clearTimeout(timeout);
      if (request.current === controller) { request.current = null; if (active.current && isCurrent(account)) setBusy(false); }
    }
  }, [account, queryKey, query.search, query.state, isCurrent, expire]);
  useEffect(() => {
    active.current = true; activeQuery.current = queryKey; loaded.current = null; void load();
    return () => { active.current = false; activeQuery.current = null; request.current?.abort(); request.current = null; };
  }, [load, queryKey]);
  return <div className="ideas-results" aria-busy={busy || changingQuery && !error}>
    <p className="ideas-load-status" role="status">{!error && (!listing ? "Loading your ideas…" : busy || changingQuery ? "Updating ideas… Previous results remain visible." : "")}</p>
    {listing && (listing.items.length ? <div className="ideas-grid">{listing.items.map(idea => <Link key={idea.id} href={`/ideas/${idea.id}`} className="idea-card">
      <div className="idea-card-top"><Icon name="ideas" size={18} /><span>{ideaStateLabels[idea.state]}</span></div>
      <h3>{idea.title}</h3>{idea.description && <p>{idea.description}</p>}
      <div className="idea-card-footer"><span className="idea-theme">{idea.theme || "Idea"}</span><Icon name="arrow" size={16} /></div>
    </Link>)}</div> : !changingQuery && <p className="quiet-empty">{query.search || query.state !== "all" ? "No saved ideas match these filters." : "No saved ideas yet. Choose Add idea to capture your first idea."}</p>)}
    {error && <div className="ideas-load-error"><p className="form-error" role="alert">{error}{changingQuery && " Previous results are still shown."}</p><button className="button secondary small" type="button" disabled={busy} onClick={() => void load()}>Try loading ideas again</button></div>}
    {listing?.nextCursor && !changingQuery && !error && <button className="button secondary small ideas-load-more" type="button" disabled={busy} onClick={() => void load()}>{busy ? "Loading more ideas…" : "Load more ideas"}</button>}
    {listing && !changingQuery && <p className="sr-only" role="status">{listing.items.length} {listing.items.length === 1 ? "idea" : "ideas"} loaded.{!listing.nextCursor && " End of this listing."}</p>}
  </div>;
}
