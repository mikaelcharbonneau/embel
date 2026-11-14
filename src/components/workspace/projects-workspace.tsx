"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { compareProjectCursors } from "@/domain/project-pages";
import { Icon } from "@/components/ui/icon";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "./account-session";
import { useAccountProjectListing } from "./account-projects";
import { UnsavedProjectRecovery } from "./unsaved-project-recovery";
import { ProjectCardActions } from "./project-card-actions";
import type { LifecycleProject, ProjectDeletionAction } from "./project-deletion-client";
import { ProjectDeletionStatus } from "./project-deletion-status";
import { ProjectCard as SavedProjectCard, ProjectCardSkeletons } from "./project-card";
import "@/styles/projects.css";

type ProjectCard = {
  key: string;
  id: string;
  title: string;
  created: string;
  href: string;
  saved: LifecycleProject;
};
type Sort = "updated" | "created" | "alphabetical";

function recent(a: ProjectCard, b: ProjectCard) {
  return -compareProjectCursors({ createdAt: a.created, id: a.id }, { createdAt: b.created, id: b.id });
}
function ProjectControl({ kind, children }: { kind: "Sort"; children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return (
    <details
      className="projects-control"
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === "Escape" && ref.current) {
          ref.current.open = false;
          ref.current.querySelector("summary")?.focus();
        }
      }}
    >
      <summary aria-label={`${kind} projects`}>
        <Icon name="arrow-up-down" size="sm" />
        {kind}
      </summary>
      <div className="projects-control-panel">{children}</div>
    </details>
  );
}

function useProjectControls() {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("created");
  return { query, setQuery, sort, setSort };
}

export function ProjectsWorkspace({ state = "active" }: { state?: "active" | "deleted" }) {
  const controls = useProjectControls();
  const { session } = useAccountSession();
  if (session.status !== "ready")
    return (
      <div className="projects-page">
        <div className="projects-heading">
          <div>
            <h1>
              Your projects<span>.</span>
            </h1>
          </div>
        </div>
        <AccountStatus signedOut="Sign in to see your projects." />
      </div>
    );
  return (
    <ProjectsLibrary
      key={`${session.userId}:${session.generation}:${state}`}
      account={session}
      controls={controls}
      state={state}
    />
  );
}

function ProjectsLibrary({
  account,
  controls,
  state,
}: {
  account: VerifiedAccount;
  controls: ReturnType<typeof useProjectControls>;
  state: "active" | "deleted";
}) {
  const { listing, error, pending, load, reload, remove, update } = useAccountProjectListing(account, state);
  const { query, setQuery, sort, setSort } = controls;
  const [notice, setNotice] = useState<{ project: LifecycleProject; action: ProjectDeletionAction } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const deleted = state === "deleted";
  const projects: ProjectCard[] = (listing?.items ?? []).map((project) => ({
    key: project.id,
    id: project.id,
    title: project.title,
    created: project.created_at,
    href: `/brands/account/${project.id}`,
    saved: project,
  }));
  const filtering = Boolean(query.trim());
  const empty = Boolean(listing) && !projects.length && !listing?.nextCursor && !error;
  const matching = projects
    .filter((project) => project.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort(
      (a, b) =>
        (sort === "alphabetical" ? a.title.localeCompare(b.title, "en", { sensitivity: "base", numeric: true }) : 0) ||
        recent(a, b),
    );
  function changed(project: LifecycleProject, action: ProjectDeletionAction) {
    remove(project.id);
    setNotice({ project, action });
    queueMicrotask(() => heading.current?.focus());
  }

  function updateNotice(project: LifecycleProject) {
    // Status reads return the saved title; keep the name the card showed.
    setNotice((previous) =>
      previous &&
      previous.project.id === project.id &&
      project.lifecycle_version >= previous.project.lifecycle_version &&
      project.current_revision >= previous.project.current_revision
        ? {
            action: project.deletion_state === "active" ? "restore" : "delete",
            project: { ...project, title: previous.project.title },
          }
        : previous,
    );
  }

  async function refreshProjects() {
    const refreshed = await reload();
    if (refreshed) requestAnimationFrame(() => heading.current?.focus());
    return refreshed;
  }

  return (
    <div className={`projects-page ${empty && !deleted ? "projects-empty" : ""}`}>
      <div className="projects-heading">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            {deleted ? "Deleted projects" : empty ? "Your projects" : "Projects"}
            <span>.</span>
          </h1>
          <p>
            {deleted
              ? "Restore a project at any time. Restoring won’t restart cancelled AI work."
              : "Every idea, in its own world."}
          </p>
        </div>
        <div className="projects-heading-actions">
          {deleted ? (
            <Link className="button secondary" href="/brands">
              Back to projects
            </Link>
          ) : (
            <>
              <Link className="text-link projects-deleted-link" href="/brands?state=deleted">
                Deleted projects
              </Link>
              {!empty && (
                <Link className="button primary" href="/">
                  New project
                  <Icon name="plus" size={16} />
                </Link>
              )}
            </>
          )}
        </div>
      </div>
      {notice && (
        <div className="project-change-notice" role="status">
          <span>
            “{notice.project.title}” {notice.action === "delete" ? "moved to Deleted projects." : "restored."}
          </span>
          <Link
            className="text-link"
            href={notice.action === "delete" ? "/brands?state=deleted" : `/brands/account/${notice.project.id}`}
          >
            {notice.action === "delete" ? "View deleted projects" : "Open project"}
          </Link>
          {notice.action === "delete" && (
            <ProjectDeletionStatus account={account} project={notice.project} onUpdated={updateNotice} compact />
          )}
          {notice.action === "restore" && <span>Cancelled AI work won’t restart.</span>}
        </div>
      )}
      {!empty && (
        <div className="projects-toolbar">
          <label className="projects-search">
            <span className="sr-only">{deleted ? "Search deleted projects" : "Search projects"}</span>
            <input
              type="search"
              placeholder={deleted ? "Search deleted projects" : "Search projects"}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <ProjectControl kind="Sort">
            <label>
              Order
              <select aria-label="Sort projects" value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
                <option value="created">Recently created</option>
                <option value="alphabetical">Alphabetical</option>
              </select>
            </label>
          </ProjectControl>
        </div>
      )}
      {empty ? (
        deleted ? (
          <section className="projects-deleted-empty" aria-labelledby="deleted-empty-heading">
            <h2 id="deleted-empty-heading">No deleted projects</h2>
            <p>Projects you delete will appear here. Their assets and history stay intact and available to restore.</p>
            <Link className="text-link" href="/brands">
              Back to projects
            </Link>
          </section>
        ) : (
          <section className="projects-empty-panel" aria-labelledby="first-project-heading">
            <Icon name="folder" size="lg" />
            <h2 id="first-project-heading">Your first project starts with an idea</h2>
            <p>Start with a complete brand, a name, or a visual identity. Your work will be waiting here.</p>
            <Link className="button primary" href="/">
              Create a project
              <Icon name="arrow" size={16} />
            </Link>
          </section>
        )
      ) : (
        <>
          <section
            className="projects-grid"
            aria-label={deleted ? "Deleted projects" : "Projects"}
            aria-busy={!listing && !error ? true : undefined}
          >
            {!listing && !error ? (
              <>
                <span className="sr-only" role="status">
                  Loading your {deleted ? "deleted " : ""}projects…
                </span>
                <ProjectCardSkeletons count={8} />
              </>
            ) : (
              matching.map((project) => {
                const actions = (name: string) => (
                  <ProjectCardActions
                    key={`${project.id}:${project.saved.current_revision}:${project.saved.lifecycle_version}`}
                    project={project.saved}
                    account={account}
                    name={name}
                    onChanged={changed}
                    onReload={refreshProjects}
                  />
                );
                return (
                  <SavedProjectCard
                    key={project.key}
                    project={project.saved}
                    account={account}
                    actions={actions}
                    deletionStatus={
                      deleted ? (
                        <ProjectDeletionStatus account={account} project={project.saved} onUpdated={update} />
                      ) : undefined
                    }
                  />
                );
              })
            )}
          </section>
          {!matching.length && (projects.length > 0 || filtering) && (
            <div className="projects-no-matches" role="status">
              <h2>No matching projects</h2>
              <p>Try a different project name.</p>
              <button type="button" className="button secondary" onClick={() => setQuery("")}>
                Clear search
              </button>
            </div>
          )}
        </>
      )}
      <div className="projects-account-status">
        {listing && listing.nextCursor && (
          <p>Search and sorting apply to loaded projects. Load more to include older projects.</p>
        )}
        {error && (
          <div className="form-error" role="alert">
            <p>
              Your {deleted ? "deleted " : ""}projects could not be loaded.
              {listing ? " Your loaded projects are still shown." : ""}
            </p>
            <button className="button secondary small" type="button" disabled={pending} onClick={() => void load()}>
              Try loading projects again
            </button>
          </div>
        )}
        {listing?.nextCursor && !error && (
          <button className="button secondary small" type="button" disabled={pending} onClick={() => void load()}>
            {pending ? "Loading more projects…" : "Load more projects"}
          </button>
        )}
      </div>
      {!deleted && <UnsavedProjectRecovery />}
    </div>
  );
}
