"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { accountProjectResponseSchema } from "@/domain/project-api";
import type { ProjectScope } from "@/domain/projects";
import { accountProjectPageSchema, compareProjectCursors, projectCursor } from "@/domain/project-pages";
import { mergeProjectPage, type ProjectListing } from "./account-project-page-state";
import { Icon } from "@/components/ui/icon";
import { accountErrorMessage, accountRequest, AccountRequestError } from "./account-api";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "./account-session";
import { createAccountInput, draftValidationMessage } from "./project-draft-adapter";
import { scopeLabel, type LocalDraft } from "./local-drafts";

export function AccountCopyControl({ draft }: { draft: LocalDraft }) {
  const { session, isCurrent, expire } = useAccountSession();
  const [operation, setOperation] = useState<{ generation: number; busy: boolean; error?: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  const router = useRouter();
  useEffect(() => () => request.current?.abort(), [session.generation]);
  const busy = operation?.generation === session.generation && operation.busy;

  async function copy() {
    if (session.status !== "ready" || !isCurrent(session) || busy) return;
    let input;
    try { input = createAccountInput(draft); }
    catch { setOperation({ generation: session.generation, busy: false, error: draftValidationMessage(draft) }); return; }
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setOperation({ generation: session.generation, busy: true });
    try {
      const { project } = await accountRequest("/api/projects", accountProjectResponseSchema, { method: "POST", body: input, signal: controller.signal });
      if (controller.signal.aborted || !isCurrent(session)) return;
      if (project.owner_id !== session.userId) { expire(session); return; }
      router.push(`/brands/account/${project.id}`);
    } catch (error) {
      if (controller.signal.aborted || !isCurrent(session)) return;
      if (error instanceof AccountRequestError && error.status === 401) expire(session);
      else setOperation({ generation: session.generation, busy: false, error: accountErrorMessage(error) });
    }
  }

  return <div className="account-copy-control"><div><strong>Keep a copy in your account</strong><p>{session.status === "ready" ? "Your browser draft stays here when you save an account copy." : session.status === "checking" ? "Checking your account…" : "Account saving is unavailable until a verified session is connected."}</p>{operation?.generation === session.generation && operation.error && <p className="form-error" role="alert">{operation.error}</p>}</div><button className="button secondary small" type="button" disabled={session.status !== "ready" || busy} onClick={() => void copy()}>{busy ? "Saving copy…" : "Save to account"}<Icon name="arrow" size={15} /></button></div>;
}

export function AccountProjects({ query, scope = "all" }: { query: string; scope?: ProjectScope | "all" }) {
  const { session } = useAccountSession();
  return <section className="account-library" aria-labelledby="account-brands-heading">
    {session.status === "ready" ? <OwnedAccountProjects key={`${session.userId}:${session.generation}`} account={session} query={query} scope={scope} /> :
      <><div className="section-heading"><h2 id="account-brands-heading">Account brands</h2><span className="secondary-text">Private to your account</span></div><AccountStatus /></>}
  </section>;
}

function OwnedAccountProjects({ account, query, scope }: { account: VerifiedAccount; query: string; scope: ProjectScope | "all" }) {
  const { isCurrent, expire } = useAccountSession();
  const [sort, setSort] = useState<"created" | "alphabetical">("created");
  const [listing, setListing] = useState<ProjectListing | null>(null);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const currentListing = useRef<ProjectListing | null>(null);
  const request = useRef<AbortController | null>(null);
  const active = useRef(false);
  const load = useCallback(async () => {
    if (!active.current || !isCurrent(account) || request.current) return;
    const previous = currentListing.current;
    const cursor = previous?.nextCursor ?? null;
    if (previous && !cursor) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true); setError(false);
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const params = new URLSearchParams({ limit: "50" });
    if (cursor) { params.set("cursorCreatedAt", cursor.createdAt); params.set("cursorId", cursor.id); }
    try {
      const page = await accountRequest(`/api/projects/page?${params}`, accountProjectPageSchema, { signal: controller.signal });
      if (!active.current || controller.signal.aborted || request.current !== controller || !isCurrent(account)) return;
      if (page.ownerId !== account.userId) { expire(account); return; }
      const next = mergeProjectPage(currentListing.current, page, cursor);
      currentListing.current = next; setListing(next);
    } catch (cause) {
      if (!active.current || request.current !== controller || !isCurrent(account)) return;
      if (cause instanceof AccountRequestError && cause.status === 401) { expire(account); return; }
      setError(true);
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) {
        request.current = null;
        if (active.current && isCurrent(account)) setPending(false);
      }
    }
  }, [account, expire, isCurrent]);
  useEffect(() => {
    active.current = true; void load();
    return () => { active.current = false; request.current?.abort(); request.current = null; };
  }, [load]);
  // Presentation order never mutates the server-ordered listing or its continuation anchor.
  const matching = listing?.items.filter(project => (scope === "all" || project.scope === scope) && project.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  if (sort === "alphabetical") matching?.sort((a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base", numeric: true }) ||
    -compareProjectCursors(projectCursor(a), projectCursor(b)));
  return <>
    <div className="section-heading"><h2 id="account-brands-heading">Account brands</h2><span className="secondary-text">{listing ? `${listing.items.length} loaded` : "Private to your account"}</span></div>
    {listing && <p className="field-hint">Search applies to loaded account brands. Scope filters and sorting also use loaded account brands.{listing.nextCursor ? " Load more to include older projects." : " End of this listing."}</p>}
    {listing && <label className="brand-list-control brand-list-sort">Sort loaded account brands<select value={sort} onChange={event => setSort(event.target.value as typeof sort)}><option value="created">Recently created</option><option value="alphabetical">Alphabetical</option></select></label>}
    {!listing && !error && <p className="quiet-empty" role="status">Loading account brands…</p>}
    {listing && (matching?.length ? <div className="draft-grid">{matching.map(project => <Link key={project.id} href={`/brands/account/${project.id}`} className="draft-card"><div className="draft-preview" aria-hidden="true">{project.title}</div><div className="draft-card-top"><span className="small-badge">Account project</span></div><h3>{project.title}</h3><div className="draft-card-footer"><span>{scopeLabel(project.scope)}</span><span>Version {project.current_revision}<Icon name="chevron" size={13} /></span></div></Link>)}</div> :
      <p className="quiet-empty">{query || scope !== "all" ? "No matches among loaded account brands." : "No account brands yet. Open a browser draft and choose Save to account."}</p>)}
    {error && <div className="form-error" role="alert"><p>Account brands could not be loaded.{listing ? " Your loaded projects are still shown." : ""}</p><button className="button secondary small" type="button" disabled={pending} onClick={() => void load()}>Try loading account brands again</button></div>}
    {listing?.nextCursor && !error && <button className="button secondary small" type="button" disabled={pending} onClick={() => void load()}>{pending ? "Loading more account brands…" : "Load more account brands"}</button>}
  </>;
}
