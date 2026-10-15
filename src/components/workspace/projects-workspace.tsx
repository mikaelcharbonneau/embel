"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ProjectScope } from "@/domain/projects";
import { compareProjectCursors } from "@/domain/project-pages";
import { ProjectsArtwork } from "@/components/ui/projects-artwork";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "./account-session";
import { useAccountProjectListing } from "./account-projects";
import { scopeDetails, scopeLabel } from "./local-drafts";
import { UnsavedProjectRecovery } from "./unsaved-project-recovery";
import "@/styles/projects.css";

type ProjectCard = { key: string; id: string; title: string; scope: ProjectScope; created: string; updated: string | null; href: string };
type Sort = "updated" | "created" | "alphabetical";

function recent(a: ProjectCard, b: ProjectCard) {
  return -compareProjectCursors({ createdAt: a.created, id: a.id }, { createdAt: b.created, id: b.id });
}
function dateLabel(project: ProjectCard, now: number | null) {
  const date = project.updated ?? project.created, timestamp = Date.parse(date), prefix = project.updated ? "Updated" : "Created";
  if (!Number.isFinite(timestamp)) return "Date unavailable";
  if (now === null) return `${prefix} ${new Date(timestamp).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" })}`;
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 60) return `${prefix} ${minutes < 1 ? "just now" : `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`}`;
  const hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  return `${prefix} ${hours < 24 ? `${hours} ${hours === 1 ? "hour" : "hours"} ago` : days === 1 ? "yesterday" : days < 7 ? `${days} days ago` : new Date(timestamp).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" })}`;
}

function ProjectControl({ kind, active, children }: { kind: "Filter" | "Sort"; active?: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false; };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return <details className="projects-control" ref={ref} onKeyDown={event => {
    if (event.key === "Escape" && ref.current) { ref.current.open = false; ref.current.querySelector("summary")?.focus(); }
  }}><summary aria-label={`${kind} projects`} className={active ? "has-selection" : undefined}><ProjectsArtwork name={kind === "Filter" ? "filter" : "sort"} />{kind}{active && <span className="projects-filter-dot" aria-hidden="true" />}</summary><div className="projects-control-panel">{children}</div></details>;
}

function useProjectControls() {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ProjectScope | "all">("all");
  const [sort, setSort] = useState<Sort>("created");
  return { query, setQuery, scope, setScope, sort, setSort };
}

export function ProjectsWorkspace() {
  const controls = useProjectControls();
  const { session } = useAccountSession();
  if (session.status !== "ready") return <div className="projects-page"><div className="projects-heading"><div><h1>Your projects<span>.</span></h1><p>Sign in to save your work and continue from any device.</p></div></div><AccountStatus /></div>;
  return <ProjectsLibrary key={`${session.userId}:${session.generation}`} account={session} controls={controls} />;
}

function ProjectsLibrary({ account, controls }: { account: VerifiedAccount; controls: ReturnType<typeof useProjectControls> }) {
  const { listing, error, pending, load } = useAccountProjectListing(account);
  const { query, setQuery, scope, setScope, sort, setSort } = controls;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const projects: ProjectCard[] = (listing?.items ?? []).map(project => ({ key: project.id, id: project.id, title: project.title, scope: project.scope, created: project.created_at, updated: null, href: `/brands/account/${project.id}` }));
  const filtering = Boolean(query.trim()) || scope !== "all";
  const empty = Boolean(listing) && !projects.length && !error;
  const matching = projects.map((project, index) => ({ ...project, preview: ["neutral", "inverse", "neutral", "pink", "neutral", "inverse"][index % 6] })).filter(project =>
    (scope === "all" || project.scope === scope) && project.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  ).sort((a, b) => (sort === "alphabetical" ? a.title.localeCompare(b.title, "en", { sensitivity: "base", numeric: true }) : 0) || recent(a, b));

  return <div className={`projects-page ${empty ? "projects-empty" : ""}`}>
    <div className="projects-heading"><div><h1>{empty ? "Your projects" : "Projects"}<span>.</span></h1><p>Every idea, in its own world.</p></div>{!empty && <Link className="projects-primary" href="/brands/new">New project<ProjectsArtwork name="plus" /></Link>}</div>
    {!empty && <div className="projects-toolbar"><label className="projects-search"><span className="sr-only">Search projects</span><input type="search" placeholder="Search projects" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <ProjectControl kind="Filter" active={scope !== "all"}><label>Scope<select aria-label="Filter projects by scope" value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="all">All scopes</option>{scopeDetails.map(detail => <option key={detail.value} value={detail.value}>{detail.label}</option>)}</select></label></ProjectControl>
      <ProjectControl kind="Sort"><label>Order<select aria-label="Sort projects" value={sort} onChange={event => setSort(event.target.value as Sort)}><option value="created">Recently created</option><option value="alphabetical">Alphabetical</option></select></label></ProjectControl>
    </div>}
    {empty ? <section className="projects-empty-panel" aria-labelledby="first-project-heading"><ProjectsArtwork name="empty-projects" /><h2 id="first-project-heading">Your first project starts with an idea</h2><p>Start with a complete brand, a name, or a visual identity. Your work will be waiting here.</p><Link className="projects-primary" href="/brands/new">Create a project<ProjectsArtwork name="create" /></Link></section> : <>
      {!listing && !error && <p className="projects-notice" role="status">Loading your projects…</p>}
      <section className="projects-grid" aria-label="Projects">{matching.map(project => <Link className="project-card" key={project.key} href={project.href} data-storage="account" aria-label={`Continue ${project.title}`}>
        <div className={`project-preview project-preview--${project.preview}`} aria-hidden="true"><span>{project.title}</span></div>
        <div className="project-details"><div className="project-card-identity"><h2 title={project.title}>{project.title}</h2><span>{scopeLabel(project.scope)}</span></div><div className="project-footer"><span title={project.created}>{dateLabel(project, now)}</span><span className="project-continue">Continue<ProjectsArtwork name="continue" /></span></div></div>
      </Link>)}</section>
      {!matching.length && (projects.length > 0 || filtering) && <div className="projects-no-matches" role="status"><h2>No matching projects</h2><p>Try a different scope or project name.</p><button type="button" className="button secondary" onClick={() => { setQuery(""); setScope("all"); }}>Clear filters</button></div>}
    </>}
    <div className="projects-account-status">{listing && listing.nextCursor && <p>Search, filters and sorting apply to loaded projects. Load more to include older projects.</p>}{error && <div className="form-error" role="alert"><p>Your projects could not be loaded.{listing ? " Your loaded projects are still shown." : ""}</p><button className="button secondary small" type="button" disabled={pending} onClick={() => void load()}>Try loading projects again</button></div>}{listing?.nextCursor && !error && <button className="button secondary small" type="button" disabled={pending} onClick={() => void load()}>{pending ? "Loading more projects…" : "Load more projects"}</button>}</div>
    <UnsavedProjectRecovery />
  </div>;
}
