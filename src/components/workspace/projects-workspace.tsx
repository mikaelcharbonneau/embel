"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ProjectScope } from "@/domain/projects";
import { compareProjectCursors } from "@/domain/project-pages";
import { ProjectsArtwork } from "@/components/ui/projects-artwork";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "./account-session";
import { useAccountProjectListing } from "./account-projects";
import { draftTitle, scopeDetails, scopeLabel, useLocalDrafts, type LocalDraft } from "./local-drafts";
import "@/styles/projects.css";

type ProjectCard = { key: string; id: string; title: string; description: string; scope: ProjectScope; stage: string; storage: "browser" | "account"; created: string; updated: string | null; href: string };
type Sort = "updated" | "created" | "alphabetical";
const stageLabels = { description: "Brief", review: "Brief", competitors: "Competitors", audience: "Audience", personality: "Personality", positioning: "Positioning" };

function time(value: string) { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; }
function recent(a: ProjectCard, b: ProjectCard, sort: Sort) {
  // Account timestamps retain their exact microsecond and UUID continuation ordering.
  if (a.storage === "account" && b.storage === "account") return -compareProjectCursors({ createdAt: a.created, id: a.id }, { createdAt: b.created, id: b.id });
  return time(sort === "created" ? b.created : b.updated ?? b.created) - time(sort === "created" ? a.created : a.updated ?? a.created) || b.key.localeCompare(a.key);
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
  const [storage, setStorage] = useState<"all" | "browser" | "account">("all");
  const [sort, setSort] = useState<Sort>("updated");
  return { query, setQuery, scope, setScope, storage, setStorage, sort, setSort };
}

export function ProjectsWorkspace() {
  const local = useLocalDrafts();
  const controls = useProjectControls();
  const { session } = useAccountSession();
  const account = session.status === "ready" ? session : null;
  // Unmount private listing state before a new account/generation can become visible.
  return <ProjectsLibrary key={account ? `${account.userId}:${account.generation}` : "browser"} drafts={local.drafts} loaded={local.loaded} browserStorage={local.storage} account={account} controls={controls} />;
}

function ProjectsLibrary({ drafts, loaded, browserStorage, account, controls }: { drafts: LocalDraft[]; loaded: boolean; browserStorage: ReturnType<typeof useLocalDrafts>["storage"]; account: VerifiedAccount | null; controls: ReturnType<typeof useProjectControls> }) {
  const { session } = useAccountSession();
  const { listing, error, pending, load } = useAccountProjectListing(account);
  const { query, setQuery, scope, setScope, storage, setStorage, sort, setSort } = controls;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const projects: ProjectCard[] = [
    ...drafts.map(draft => ({ key: `browser:${draft.id}`, id: draft.id, title: draftTitle(draft), description: draft.description, scope: draft.scope, stage: stageLabels[draft.stage], storage: "browser" as const, created: draft.createdAt, updated: draft.updatedAt, href: `/brands/${draft.id}` })),
    ...(listing?.items ?? []).map(project => ({ key: `account:${project.id}`, id: project.id, title: project.title, description: "Account copy · brief available when opened", scope: project.scope, stage: "Unavailable", storage: "account" as const, created: project.created_at, updated: null, href: `/brands/account/${project.id}` })),
  ];
  const filtering = Boolean(query.trim()) || scope !== "all" || storage !== "all";
  const empty = loaded && browserStorage === "available" && !projects.length && (session.status === "signed_out" || Boolean(account && listing)) && !error;
  const matching = projects.map((project, index) => ({ ...project, preview: ["neutral", "inverse", "neutral", "pink", "neutral", "inverse"][index % 6] })).filter(project =>
    (scope === "all" || project.scope === scope) && (storage === "all" || project.storage === storage) && `${project.title} ${project.storage === "browser" ? project.description : ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  ).sort((a, b) => (sort === "alphabetical" ? a.title.localeCompare(b.title, "en", { sensitivity: "base", numeric: true }) : 0) || recent(a, b, sort));

  return <div className={`projects-page ${empty ? "projects-empty" : ""}`}>
    <div className="projects-heading"><div><h1>{empty ? "Your projects" : "Projects"}<span>.</span></h1><p>Every idea, in its own world.</p></div>{!empty && <Link className="projects-primary" href="/brands/new">New project<ProjectsArtwork name="plus" /></Link>}</div>
    {!empty && <div className="projects-toolbar"><label className="projects-search"><span className="sr-only">Search projects</span><input type="search" placeholder="Search projects" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <ProjectControl kind="Filter" active={scope !== "all" || storage !== "all"}><label>Scope<select aria-label="Filter projects by scope" value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="all">All scopes</option>{scopeDetails.map(detail => <option key={detail.value} value={detail.value}>{detail.label}</option>)}</select></label><label>Storage<select aria-label="Filter projects by storage" value={storage} onChange={event => setStorage(event.target.value as typeof storage)}><option value="all">All projects</option><option value="browser">Browser drafts</option><option value="account">Account copies</option></select></label></ProjectControl>
      <ProjectControl kind="Sort"><label>Order<select aria-label="Sort projects" value={sort} onChange={event => setSort(event.target.value as Sort)}><option value="updated">Recently updated</option><option value="created">Recently created</option><option value="alphabetical">Alphabetical</option></select></label><p>Account copies use their creation date. Last update dates are unavailable in the listing.</p></ProjectControl>
    </div>}
    {empty ? <section className="projects-empty-panel" aria-labelledby="first-project-heading"><ProjectsArtwork name="empty-projects" /><h2 id="first-project-heading">Your first project starts with an idea</h2><p>Start with a complete brand, a name, or a visual identity. Your work will be waiting here.</p><Link className="projects-primary" href="/brands/new">Create a brand draft<ProjectsArtwork name="create" /></Link></section> : <>
      {!loaded && <p className="projects-notice" role="status">Loading browser drafts…</p>}
      <section className="projects-grid" aria-label="Projects">{matching.map(project => <Link className="project-card" key={project.key} href={project.href} data-storage={project.storage} aria-label={`Continue ${project.title} (${project.storage === "browser" ? "browser draft" : "account copy"})`}>
        <div className={`project-preview project-preview--${project.preview}`} aria-hidden="true"><span>{project.title}</span></div>
        <div className="project-details"><div className="project-card-identity"><h2 title={project.title}>{project.title}</h2><span>{scopeLabel(project.scope)}</span></div><p className="project-description" title={project.description}>{project.description || "No brief yet"}</p><div className="project-stage"><span>Stage</span><strong>{project.stage}</strong></div><div className="project-footer"><span title={`${project.storage === "browser" ? "Browser draft" : "Account copy"} · ${project.updated ?? project.created}`}>{dateLabel(project, now)}</span><span className="project-continue">Continue<ProjectsArtwork name="continue" /></span></div></div>
      </Link>)}</section>
      {loaded && !matching.length && (projects.length > 0 || filtering) && <div className="projects-no-matches" role="status"><h2>No matching projects</h2><p>Try a different scope, storage location, project name or word from a browser brief.</p><button type="button" className="button secondary" onClick={() => { setQuery(""); setScope("all"); setStorage("all"); }}>Clear filters</button></div>}
    </>}
    <p className="projects-storage-note"><ProjectsArtwork name="device" />Browser drafts stay on this device. Account copies are saved separately.</p>
    {account && <div className="projects-account-status">{!listing && !error && <p role="status">Loading account projects…</p>}{listing && <p>{listing.items.length} account {listing.items.length === 1 ? "project" : "projects"} loaded. Search, filters and sorting apply to loaded projects.{listing.nextCursor ? " Load more to include older account copies." : " End of account listing."}</p>}{error && <div className="form-error" role="alert"><p>Account projects could not be loaded.{listing ? " Your loaded projects are still shown." : ""}</p><button className="button secondary small" type="button" disabled={pending} onClick={() => void load()}>Try loading account projects again</button></div>}{listing?.nextCursor && !error && <button className="button secondary small" type="button" disabled={pending} onClick={() => void load()}>{pending ? "Loading more account projects…" : "Load more account projects"}</button>}</div>}
    {(session.status === "unavailable" || session.status === "error") && <div className="projects-account-status"><AccountStatus /></div>}
  </div>;
}
