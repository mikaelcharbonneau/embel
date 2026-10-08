"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { AccountRequestError } from "@/components/workspace/account-api";
import { accountNamesPageSchema, createBrandFromProjectNameResponseSchema, updateNameRetentionResponseSchema, type AccountNameEntry, type AccountNamesPage } from "@/domain/project-naming";
import { createNamingRequestScope, namingErrorMessage, namingOwned } from "./use-project-naming";
import { NameSymbol } from "./name-candidate-card";

export function AccountNamesLibrary() {
  const { session } = useAccountSession();
  if (session.status !== "ready") return <section className="project-naming-library" aria-label="Account names library"><AccountStatus /></section>;
  return <VerifiedNamesLibrary key={`${session.userId}:${session.generation}`} account={session} />;
}

function VerifiedNamesLibrary({ account }: { account: VerifiedAccount }) {
  const router = useRouter();
  const { isCurrent, expire } = useAccountSession();
  const [scope] = useState(() => createNamingRequestScope(account, isCurrent, expire));
  const [page, setPage] = useState<AccountNamesPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [revision, setRevision] = useState(0);
  const [promotionCandidateId, setPromotionCandidateId] = useState<string | null>(null);
  const [acceptedPromotionFor, setAcceptedPromotionFor] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mutationEpoch = useRef(0);
  const readSequence = useRef(0);
  const promotionIntents = useRef(new Map<string, string>());
  useEffect(() => { scope.activate(); return () => scope.dispose(); }, [scope]);
  useEffect(() => {
    let active = true;
    const epoch = mutationEpoch.current, sequence = ++readSequence.current;
    void scope.request("/api/names?limit=100", accountNamesPageSchema, value => value.ownerId === account.userId).then(reply => { if (active && reply && epoch === mutationEpoch.current && sequence === readSequence.current && !inFlight.current) { setPage(reply); setError(null); } }).catch(cause => { if (active && scope.current() && epoch === mutationEpoch.current && sequence === readSequence.current) setError(namingErrorMessage(cause)); });
    return () => { active = false; };
  }, [account.userId, revision, scope]);
  async function mutate(operation: () => Promise<void>, retentionField?: "favorite" | "saved") {
    if (!scope.current() || inFlight.current) return;
    inFlight.current = true; mutationEpoch.current += 1; setPending(true); setError(null);
    try { await operation(); }
    catch (cause) { if (scope.current()) setError(namingErrorMessage(cause, retentionField)); }
    finally { inFlight.current = false; if (scope.current()) setPending(false); }
  }
  async function retain(entry: AccountNameEntry, field: "favorite" | "saved") {
    await mutate(async () => {
      const body = { candidateId: entry.candidate.id, expectedRevision: entry.retention.revision, favorite: entry.retention.favorite, saved: entry.retention.saved, [field]: !entry.retention[field] };
      const reply = await scope.request(`/api/projects/${entry.project.id}/naming/retention`, updateNameRetentionResponseSchema, value => namingOwned(value.entry.candidate, account.userId, entry.project.id), { method: "PATCH", body });
      if (!reply) return;
      if (reply.entry.candidate.id !== entry.candidate.id || reply.entry.retention.revision !== entry.retention.revision + 1 || reply.entry.retention[field] !== body[field]) throw new AccountRequestError(502);
      setPage(previous => previous ? { ...previous, items: previous.items.map(item => item.candidate.id === entry.candidate.id ? { ...item, ...reply.entry } : item).filter(item => item.currentSelection || item.retention.favorite || item.retention.saved) } : previous);
    }, field);
  }
  function choosePromotion(entry: AccountNameEntry) {
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
      if (!reply) return;
      const origin = reply.currentSelection.candidate.origin;
      if (origin.kind !== "account_copy" || origin.sourceProjectId !== entry.project.id || origin.sourceCandidateId !== entry.candidate.id || reply.project.id === entry.project.id || reply.currentSelection.selection.acceptedEarlierContext !== acceptEarlierContext) throw new AccountRequestError(502);
      if (scope.current()) router.push(`/brands/account/${reply.project.id}`);
    });
  }
  async function loadMore() {
    if (!page?.nextCursor) return;
    const cursor = page.nextCursor;
    await mutate(async () => {
      const params = new URLSearchParams({ limit: "100", cursorId: cursor.id, cursorCreatedAt: cursor.createdAt });
      const reply = await scope.request(`/api/names?${params}`, accountNamesPageSchema, value => value.ownerId === account.userId);
      if (!reply) return;
      setPage(previous => { if (!previous) return reply; const ids = new Set(previous.items.map(item => item.candidate.id)); return { ...reply, items: [...previous.items, ...reply.items.filter(item => !ids.has(item.candidate.id))] }; });
    });
  }
  const projects = [...new Map(page?.items.map(entry => [entry.project.id, entry.project]) ?? []).values()];
  const entries = page?.items.filter(entry => (!projectFilter || entry.project.id === projectFilter) && entry.candidate.value.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  const promotionEntry = page?.items.find(entry => entry.candidate.id === promotionCandidateId);
  const promotionContext = promotionEntry ? `${promotionEntry.candidate.id}:${promotionEntry.project.current_revision}` : null;
  return <section className="project-naming-library" aria-label="Account names library">
    <p className="project-naming-notice">Favorite, saved and selected names from your account projects. Browser names stay in the separate browser library.</p>
    {error ? <div className="project-naming-notice" role="alert"><p>{error}</p><button className="button secondary small" type="button" disabled={pending} onClick={() => setRevision(value => value + 1)}>Check account names</button></div> : null}
    {!page && !error ? <p className="project-naming-muted" role="status">Loading your account names…</p> : null}
    {promotionEntry ? <section className="project-naming-stale-choice" aria-label="Create brand confirmation"><h2 id="project-naming-promote-heading" tabIndex={-1}>Create a brand with {promotionEntry.candidate.value} from an earlier strategy?</h2><p>The new brand will use the current saved context of {promotionEntry.project.title}. This name keeps its earlier origin and transformation history.</p><label><input type="checkbox" disabled={pending} checked={acceptedPromotionFor === promotionContext} onChange={event => setAcceptedPromotionFor(event.target.checked ? promotionContext : null)} />I have reviewed this name against the project&apos;s current context and want to use it.</label><div className="project-naming-actions"><button className="button secondary small" type="button" disabled={pending} onClick={() => { setPromotionCandidateId(null); setAcceptedPromotionFor(null); }}>Keep browsing</button><button className="button primary small" type="button" disabled={pending || acceptedPromotionFor !== promotionContext} onClick={() => void promote(promotionEntry, true)}>Create brand with this name<Icon name="arrow" size={13} /></button></div></section> : null}
    {page ? <><div className="project-naming-toolbar"><label><span className="sr-only">Search account names</span><input type="search" value={query} maxLength={200} placeholder="Search account names" onChange={event => setQuery(event.target.value)} /></label><label><span className="sr-only">Account name project</span><select aria-label="Account name project" value={projectFilter} onChange={event => setProjectFilter(event.target.value)}><option value="">All loaded projects</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label><span>{entries.length} names shown · {page.items.length} loaded</span></div>
      {entries.length ? <div className="project-naming-grid">{entries.map(entry => <article key={entry.candidate.id} className="project-naming-card"><div className="project-naming-card-title"><h3>{entry.candidate.value}</h3><button className="project-naming-favorite" type="button" disabled={pending} aria-pressed={entry.retention.favorite} aria-label={`${entry.retention.favorite ? "Unfavorite" : "Favorite"} ${entry.candidate.value}`} onClick={() => void retain(entry, "favorite")}><NameSymbol name="favorite" /></button></div>
        <div className="project-naming-badges">{entry.currentSelection ? <span className="is-selected">Selected in project</span> : null}{entry.retention.favorite ? <span>Favorite</span> : null}{entry.retention.saved ? <span>Saved</span> : null}{entry.earlierContext ? <span>Earlier strategy</span> : null}</div><p>{entry.candidate.rationale}</p><Link className="text-link" href={`/brands/account/${entry.project.id}/naming`}>{entry.project.title}<Icon name="arrow" size={13} /></Link>
        <div className="project-naming-actions"><button className="button secondary small" type="button" disabled={pending} onClick={() => choosePromotion(entry)}>Create brand<Icon name="arrow" size={13} /></button><button className="text-link" type="button" disabled={pending} aria-pressed={entry.retention.saved} onClick={() => void retain(entry, "saved")}>{entry.retention.saved ? "Unsave" : "Save"}</button></div>
        <details><summary>Context and selection</summary><p>Create brand copies this name and its owned context into a new complete brand. To replace the name in its current project, open the project and choose Use this name.</p></details>
      </article>)}</div> : <div className="project-naming-empty"><h2>{page.items.length ? "No account names in this view" : "Keep the names that matter"}</h2><p>{page.items.length ? "Change the search or project filter to explore your loaded names." : "Names you favorite, save or select in an account project will appear here."}</p><Link className="button secondary small" href="/brands">Open brands<Icon name="arrow" size={14} /></Link></div>}
      {page.nextCursor ? <div className="project-naming-next"><button className="button secondary" type="button" disabled={pending} onClick={() => void loadMore()}>Load more account names</button><p className="project-naming-muted">Search and project filters apply to the names loaded here.</p></div> : null}
    </> : null}
  </section>;
}
