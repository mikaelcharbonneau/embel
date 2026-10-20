"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { AccountRequestError } from "@/components/workspace/account-api";
import { accountNamesPageSchema, createBrandFromProjectNameResponseSchema, updateNameRetentionResponseSchema, type AccountNameEntry, type AccountNamesPage } from "@/domain/project-naming";
import { createNamingRequestScope, namingErrorMessage, namingOwned } from "./use-project-naming";
import { NameSymbol } from "./name-candidate-card";
import type { AccountNamesLibraryClient, AccountNamesLibrarySnapshot } from "./account-names-library-snapshot";
import "./names-library.css";

export type ProjectNamesFilter = "all" | "favorite" | "saved" | "selected";
type LibraryPresentation = { filter?: ProjectNamesFilter; onFilterChange?: (value: ProjectNamesFilter) => void };
export function AccountNamesLibrary({ snapshot, filter, onFilterChange }: { snapshot: AccountNamesLibrarySnapshot } & LibraryPresentation) {
  const { session, namesDrafts, isCurrent, expire } = useAccountSession();
  const client = useMemo(() => ({ namesDrafts, isCurrent, expire }), [namesDrafts, isCurrent, expire]);
  if (session.status !== "ready") return <section className="project-naming-library" aria-label="Account names library"><AccountStatus /></section>;
  if (!snapshot.matches(session, client)) return <section className="project-naming-library" aria-label="Account names library"><p role="status">Loading your account names…</p></section>;
  return <VerifiedNamesLibrary key={`${session.userId}:${session.generation}:${snapshot.key}`} account={session} client={client} snapshot={snapshot} filter={filter} onFilterChange={onFilterChange} />;
}

function VerifiedNamesLibrary({ account, client, snapshot, filter, onFilterChange }: { account: VerifiedAccount; client: AccountNamesLibraryClient; snapshot: AccountNamesLibrarySnapshot } & LibraryPresentation) {
  const router = useRouter();
  const [scope] = useState(() => createNamingRequestScope(account, client.isCurrent, client.expire));
  const [retained] = useState(() => snapshot.read(account, client));
  // Retained rows never populate this authoritative page or its continuation cursor.
  const [page, setPage] = useState<AccountNamesPage | null>(null);
  const currentPage = useRef<AccountNamesPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(true);
  const [query, setQuery] = useState(retained?.query ?? "");
  const [projectFilter, setProjectFilter] = useState(retained?.projectFilter ?? "");
  const [localFilter, setLocalFilter] = useState<ProjectNamesFilter>("all");
  const statusFilter = filter ?? localFilter;
  const currentView = useRef({ query, projectFilter });
  const [revision, setRevision] = useState(0);
  const [promotionCandidateId, setPromotionCandidateId] = useState<string | null>(null);
  const [acceptedPromotionFor, setAcceptedPromotionFor] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mutationEpoch = useRef(0);
  const readSequence = useRef(0);
  const promotionIntents = useRef(new Map<string, string>());
  useLayoutEffect(() => { scope.activate(); return () => scope.dispose(); }, [scope]);
  useEffect(() => {
    let active = true;
    const epoch = mutationEpoch.current, sequence = ++readSequence.current;
    void scope.request("/api/names?limit=100", accountNamesPageSchema, value => value.ownerId === account.userId).then(reply => {
      if (active && scope.current() && reply && epoch === mutationEpoch.current && sequence === readSequence.current && !inFlight.current) {
        currentPage.current = reply; setPage(reply); setError(null);
        snapshot.remember(account, client, { items: reply.items, hasMore: Boolean(reply.nextCursor), ...currentView.current });
      }
    }).catch(cause => { if (active && scope.current() && epoch === mutationEpoch.current && sequence === readSequence.current) setError(namingErrorMessage(cause)); })
      .finally(() => { if (active && scope.current() && sequence === readSequence.current) setChecking(false); });
    return () => { active = false; };
  }, [account, client, revision, scope, snapshot]);
  function checkNames() { if (scope.current()) { setChecking(true); setRevision(value => value + 1); } }
  function changeView(patch: Partial<{ query: string; projectFilter: string }>) {
    currentView.current = { ...currentView.current, ...patch };
    setQuery(currentView.current.query); setProjectFilter(currentView.current.projectFilter);
    snapshot.rememberView(account, client, currentView.current);
  }
  async function mutate(operation: () => Promise<void>, retentionField?: "favorite" | "saved") {
    if (!currentPage.current || !scope.current() || inFlight.current) return;
    snapshot.invalidate();
    inFlight.current = true; mutationEpoch.current += 1; setPending(true); setError(null);
    try { await operation(); }
    catch (cause) { if (scope.current()) setError(namingErrorMessage(cause, retentionField)); }
    finally { inFlight.current = false; if (scope.current()) setPending(false); }
  }
  async function retain(entry: AccountNameEntry, field: "favorite" | "saved") {
    await mutate(async () => {
      const body = { candidateId: entry.candidate.id, expectedRevision: entry.retention.revision, favorite: entry.retention.favorite, saved: entry.retention.saved, [field]: !entry.retention[field] };
      const reply = await scope.request(`/api/projects/${entry.project.id}/naming/retention`, updateNameRetentionResponseSchema, value => namingOwned(value.entry.candidate, account.userId, entry.project.id), { method: "PATCH", body });
      if (!reply || !scope.current()) return;
      if (reply.entry.candidate.id !== entry.candidate.id || reply.entry.retention.revision !== entry.retention.revision + 1 || reply.entry.retention[field] !== body[field]) throw new AccountRequestError(502);
      const previous = currentPage.current;
      if (previous) { const next = { ...previous, items: previous.items.map(item => item.candidate.id === entry.candidate.id ? { ...item, ...reply.entry } : item).filter(item => item.currentSelection || item.retention.favorite || item.retention.saved) }; currentPage.current = next; setPage(next); }
    }, field);
  }
  function choosePromotion(entry: AccountNameEntry) {
    if (!currentPage.current || !scope.current() || inFlight.current) return;
    if (!entry.earlierContext) { void promote(entry, false); return; }
    setPromotionCandidateId(entry.candidate.id); setAcceptedPromotionFor(null);
    requestAnimationFrame(() => document.getElementById("project-naming-promote-heading")?.focus());
  }
  async function promote(entry: AccountNameEntry, acceptEarlierContext: boolean) {
    if (entry.earlierContext && !acceptEarlierContext) return;
    await mutate(async () => {
      const intentKey = `${entry.candidate.id}:${entry.project.current_revision}:${acceptEarlierContext}`;
      let idempotencyKey = promotionIntents.current.get(intentKey);
      if (!idempotencyKey) { idempotencyKey = crypto.randomUUID(); promotionIntents.current.set(intentKey, idempotencyKey); }
      const reply = await scope.request(`/api/projects/${entry.project.id}/naming/promote`, createBrandFromProjectNameResponseSchema, value => value.project.owner_id === account.userId, { method: "POST", body: { sourceProjectId: entry.project.id, sourceCandidateId: entry.candidate.id, expectedSourceProjectRevision: entry.project.current_revision, title: entry.candidate.value, acceptEarlierContext, idempotencyKey } });
      if (!reply || !scope.current()) return;
      const origin = reply.currentSelection.candidate.origin;
      if (origin.kind !== "account_copy" || origin.sourceProjectId !== entry.project.id || origin.sourceCandidateId !== entry.candidate.id || reply.project.id === entry.project.id || reply.currentSelection.selection.acceptedEarlierContext !== acceptEarlierContext) throw new AccountRequestError(502);
      if (scope.current()) router.push(`/brands/account/${reply.project.id}`);
    });
  }
  async function loadMore() {
    const cursor = currentPage.current?.nextCursor;
    if (!cursor) return;
    await mutate(async () => {
      const params = new URLSearchParams({ limit: "100", cursorId: cursor.id, cursorCreatedAt: cursor.createdAt });
      const reply = await scope.request(`/api/names?${params}`, accountNamesPageSchema, value => value.ownerId === account.userId);
      if (!reply || !scope.current()) return;
      const previous = currentPage.current, ids = new Set(previous?.items.map(item => item.candidate.id));
      const next = { ...reply, items: [...(previous?.items ?? []), ...reply.items.filter(item => !ids.has(item.candidate.id))] };
      currentPage.current = next; setPage(next);
      snapshot.remember(account, client, { items: next.items, hasMore: Boolean(next.nextCursor), ...currentView.current });
    });
  }
  const shownItems = page?.items ?? retained?.items;
  const projects = [...new Map(shownItems?.map(entry => [entry.project.id, entry.project]) ?? []).values()];
  const entries = shownItems?.filter(entry => {
    const statusMatches = statusFilter === "all" || (statusFilter === "selected" ? entry.currentSelection : entry.retention[statusFilter]);
    return statusMatches && (!projectFilter || entry.project.id === projectFilter) && entry.candidate.value.toLowerCase().includes(query.trim().toLowerCase());
  }) ?? [];
  const actionsBlocked = pending || !page;
  const hasMore = page ? Boolean(page.nextCursor) : retained?.hasMore;
  const promotionEntry = page?.items.find(entry => entry.candidate.id === promotionCandidateId);
  const promotionContext = promotionEntry ? `${promotionEntry.candidate.id}:${promotionEntry.project.current_revision}` : null;
  return <section className="project-naming-library" aria-label="Account names library">
    <p className="project-naming-notice">Favorite, saved and selected names from your projects.</p>
    <p className="names-project-source-note">Project titles identify source history. This view does not show whether a source project is active.</p>
    {error ? <div className="project-naming-notice" role="alert"><p>{error}</p><button className="button secondary small" type="button" disabled={pending} onClick={checkNames}>Check account names</button></div> : null}
    {checking && shownItems ? <p className="project-naming-muted" role="status">Checking saved account names…</p> : !shownItems && !error ? <p className="project-naming-muted" role="status">Loading your account names…</p> : !page && shownItems ? <p className="project-naming-muted" role="status">Showing your last checked account names. Check account names before making changes.</p> : null}
    {promotionEntry ? <section className="project-naming-stale-choice" aria-label="Create brand confirmation"><h2 id="project-naming-promote-heading" tabIndex={-1}>Create a brand with {promotionEntry.candidate.value} from an earlier strategy?</h2><p>The new brand will use the current saved context of {promotionEntry.project.title}. This name keeps its earlier origin and transformation history.</p><label><input type="checkbox" disabled={pending} checked={acceptedPromotionFor === promotionContext} onChange={event => setAcceptedPromotionFor(event.target.checked ? promotionContext : null)} />I have reviewed this name against the project&apos;s current context and want to use it.</label><div className="project-naming-actions"><button className="button secondary small" type="button" disabled={pending} onClick={() => { setPromotionCandidateId(null); setAcceptedPromotionFor(null); }}>Keep browsing</button><button className="button primary small" type="button" disabled={pending || acceptedPromotionFor !== promotionContext} onClick={() => void promote(promotionEntry, true)}>Create brand with this name<Icon name="arrow" size={13} /></button></div></section> : null}
    {shownItems ? <><div className="project-naming-toolbar names-project-library-toolbar"><label><span className="sr-only">Search account names</span><input type="search" aria-describedby="names-library-scope-hint" value={query} maxLength={200} placeholder="Search loaded project names" onChange={event => changeView({ query: event.target.value })} /></label><label><span className="sr-only">Account name project</span><select aria-label="Account name project" value={projectFilter} onChange={event => changeView({ projectFilter: event.target.value })}><option value="">All source projects</option>{projects.map(project => {
      const selectedName = shownItems.find(entry => entry.project.id === project.id && entry.currentSelection)?.candidate.value;
      return <option key={project.id} value={project.id}>{project.title}{selectedName ? ` · ${selectedName}` : ""}</option>;
    })}</select></label><label><span className="sr-only">Filter project names</span><select aria-label="Filter project names" value={statusFilter} onChange={event => { const next = event.target.value as ProjectNamesFilter; setLocalFilter(next); onFilterChange?.(next); }}><option value="all">All kept project names</option><option value="favorite">Favorites</option><option value="saved">Saved</option><option value="selected">Selected in project</option></select></label><span>{entries.length} names shown · {shownItems.length} {page ? "loaded" : "last checked"}</span></div>
      {entries.length ? <div className="project-naming-grid" aria-busy={checking}>{entries.map(entry => <article key={entry.candidate.id} className="project-naming-card"><div className="project-naming-card-title"><h3 title={entry.candidate.value}>{entry.candidate.value}</h3><button className="project-naming-favorite" type="button" disabled={actionsBlocked} aria-pressed={entry.retention.favorite} aria-label={`${entry.retention.favorite ? "Unfavorite" : "Favorite"} ${entry.candidate.value}`} onClick={() => void retain(entry, "favorite")}><NameSymbol name="favorite" /></button></div>
        <div className="project-naming-badges">{entry.currentSelection ? <span className="is-selected">Selected in project</span> : null}{entry.retention.favorite ? <span>Favorite</span> : null}{entry.retention.saved ? <span>Saved</span> : null}{entry.earlierContext ? <span>Earlier strategy</span> : null}</div><p>{entry.candidate.rationale}</p><p className="names-project-source" title={entry.project.title}><span>Source project</span><Link className="text-link" href={`/brands/account/${entry.project.id}/naming`} aria-label={`Open source project: ${entry.project.title}`}>{entry.project.title}</Link></p>
        <div className="project-naming-actions"><button className="button secondary small" type="button" disabled={actionsBlocked} onClick={() => choosePromotion(entry)}>Create brand<Icon name="arrow" size={13} /></button><button className="text-link" type="button" disabled={actionsBlocked} aria-pressed={entry.retention.saved} onClick={() => void retain(entry, "saved")}>{entry.retention.saved ? "Unsave" : "Save"}</button></div>
        <details><summary>Context and selection</summary>{entry.candidate.value.length > 60 && <p className="names-full-value"><strong>Full name</strong>{entry.candidate.value}</p>}<p>Create brand copies this name and its owned context into a new complete brand. It does not restore or reopen the source project. Selecting a name in an active project is a separate action in Projects.</p></details>
      </article>)}</div> : <div className="project-naming-empty" aria-busy={checking}><h2>{shownItems.length ? "No account names in this view" : "Keep the names that matter"}</h2><p>{shownItems.length ? "Change the search, source project or status filter to explore your loaded names." : "Names you favorite, save or select in an account project will appear here."}</p><Link className="button secondary small" href="/brands">Open projects<Icon name="arrow" size={14} /></Link></div>}
      {hasMore ? <div className="project-naming-next"><button className="button secondary" type="button" disabled={actionsBlocked} onClick={() => void loadMore()}>Load more account names</button><p className="project-naming-muted">Search and project filters apply to the names loaded here.</p></div> : null}
    </> : null}
  </section>;
}
