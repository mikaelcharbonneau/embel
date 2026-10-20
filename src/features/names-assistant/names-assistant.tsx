"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import type { ProjectListing } from "@/components/workspace/account-project-page-state";
import { namesAssistantProjectHref, namesAssistantProjects, readNamesAssistantProjects } from "./projects";
import "./names-assistant.css";

export type NamesAssistantProps = { onOpenAccountLibrary?: () => void };

/** Opening this view can only list projects. Generation stays in the existing saved-project workflow. */
export function NamesAssistant({ onOpenAccountLibrary }: NamesAssistantProps) {
  const { session } = useAccountSession();
  return <section className="names-assistant-bridge" aria-labelledby="names-assistant-heading">
    <div className="names-section-heading"><h2 id="names-assistant-heading">AI naming assistant</h2><span>Saved project context</span></div>
    <p>Choose an account project to review naming preferences and explore its names. Opening the workspace never starts generation.</p>
    {session.status === "ready" ? <AccountProjectChooser key={`${session.userId}:${session.generation}`} account={session} /> : <AccountStatus />}
    <div className="names-assistant-start"><h3>Start with a new brief</h3><p>Create a naming project in your account. Then open Naming to review preferences before generating.</p><Link className="button secondary small" href="/brands/new?scope=naming_only" prefetch={false}>Create naming brief<Icon name="plus" size={14} /></Link></div>
    <div className="names-assistant-library"><p>Favorite, saved and selected project names appear alongside your workshop names in Library.</p>{onOpenAccountLibrary ? <button className="text-link" type="button" onClick={onOpenAccountLibrary}>Open names library<Icon name="arrow" size={14} /></button> : null}</div>
  </section>;
}

function AccountProjectChooser({ account }: { account: VerifiedAccount }) {
  const { isCurrent, expire } = useAccountSession();
  const [listing, setListing] = useState<ProjectListing | null>(null);
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("");
  const [pending, setPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const currentListing = useRef<ProjectListing | null>(null);
  const request = useRef<AbortController | null>(null);
  const retryRefresh = useRef(false);
  const active = useRef(false);
  const load = useCallback(async (refresh = false) => {
    if (!active.current || !isCurrent(account) || request.current) return;
    const controller = new AbortController(); request.current = controller;
    retryRefresh.current = refresh;
    setPending(true); setRefreshing(refresh); setError(false);
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const next = await readNamesAssistantProjects({ account, isCurrent, expire, previous: refresh ? null : currentListing.current, signal: controller.signal });
      if (!active.current || request.current !== controller || !isCurrent(account)) return;
      if (controller.signal.aborted) { setError(true); return; }
      if (next) {
        currentListing.current = next; setListing(next);
        setProjectId(id => next.items.some(project => project.id === id && namesAssistantProjectHref(project, account)) ? id : "");
      }
    } catch {
      if (active.current && request.current === controller && isCurrent(account)) setError(true);
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) {
        request.current = null;
        if (active.current && isCurrent(account)) setPending(false);
      }
    }
  }, [account, isCurrent, expire]);
  useEffect(() => {
    active.current = true;
    const startup = setTimeout(() => void load(), 0);
    return () => { clearTimeout(startup); active.current = false; request.current?.abort(); request.current = null; };
  }, [load]);

  const projects = namesAssistantProjects(listing, account, query);
  const selected = projects.find(project => project.id === projectId);
  const href = selected ? namesAssistantProjectHref(selected, account) : null;
  return <div className="names-assistant-projects" aria-busy={pending}>
    {!listing && !error ? <p role="status">Loading your account projects…</p> : null}
    {listing ? <>
      <div className="names-assistant-fields"><label className="names-field">Search loaded projects<input type="search" value={query} maxLength={160} placeholder="Project title" onChange={event => { setQuery(event.target.value); setProjectId(""); }} /></label>
        <label className="names-field">Account project<select value={selected?.id ?? ""} onChange={event => setProjectId(event.target.value)}><option value="">Choose a project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title} · {project.scope === "naming_only" ? "Naming only" : "Complete brand"} · v{project.current_revision}</option>)}</select></label></div>
      <p className="names-muted">{projects.length} matching projects · {listing.items.length} account projects loaded. Search covers loaded projects with Naming.{listing.nextCursor ? " Load more to include older projects." : " End of this listing."}</p>
      {!projects.length ? <p>{query ? "No matching naming projects in the loaded list." : "No projects with Naming in the loaded list. Create a naming brief below or open your projects."}</p> : null}
      {selected ? <p className="names-assistant-context">{selected.scope === "complete_brand" ? "Naming will check that this brand’s saved Strategy is reviewed." : "Naming will use this project’s saved description and show any missing Strategy."} Saved preferences, results, history and cancellation controls open in the project workspace.</p> : null}
      <div className="names-assistant-actions">{href ? <Link className="button primary small" href={href} prefetch={false} onNavigate={event => { if (!isCurrent(account)) event.preventDefault(); }}>Open project Naming<Icon name="arrow" size={14} /></Link> : <button className="button primary small" type="button" disabled>Choose a project to continue</button>}
        {listing.nextCursor && !error ? <button className="button secondary small" type="button" disabled={pending} onClick={() => void load()}>{pending ? "Loading more projects…" : "Load more projects"}</button> : null}
        <button className="text-link" type="button" disabled={pending} onClick={() => void load(true)}>Refresh project list</button>
      </div>
      <span className="sr-only" role="status">{pending ? refreshing ? "Refreshing your account projects…" : "Loading more account projects…" : ""}</span>
    </> : null}
    {error ? <div className="form-error" role="alert"><p>Account projects could not be loaded.{listing ? " Your loaded projects remain available." : " Check your connection and try again."}</p><button className="button secondary small" type="button" disabled={pending} onClick={() => void load(retryRefresh.current)}>Try loading projects again</button></div> : null}
  </div>;
}
