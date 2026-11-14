"use client";

import { useEffect, useRef, useState } from "react";
import { compareProjectCursors } from "@/domain/project-pages";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { Menu } from "@/components/ui/menu";
import { InlineMessage } from "@/components/ui/message";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "./account-session";
import { useAccountProjectListing } from "./account-projects";
import { UnsavedProjectRecovery } from "./unsaved-project-recovery";
import { ProjectCardActions } from "./project-card-actions";
import type { LifecycleProject, ProjectDeletionAction } from "./project-deletion-client";
import { ProjectDeletionStatus } from "./project-deletion-status";
import { ProjectCard, ProjectCardSkeletons } from "./project-card";
import { readViewFromAddress, writeViewToAddress } from "./address-view";
import { SignedOutEmptyState } from "./signed-out-empty-state";
import "@/styles/projects.css";

type Sort = "created" | "alphabetical";
const sorts: { value: Sort; label: string }[] = [
  { value: "created", label: "Recently created" },
  { value: "alphabetical", label: "Alphabetical" },
];

function byRecent(a: LifecycleProject, b: LifecycleProject) {
  return -compareProjectCursors({ createdAt: a.created_at, id: a.id }, { createdAt: b.created_at, id: b.id });
}

/** The title row: the page name, one sentence, and the page's actions. */
function ProjectsHeading({
  deleted,
  showNew,
  heading,
}: {
  deleted: boolean;
  showNew: boolean;
  heading?: React.Ref<HTMLHeadingElement>;
}) {
  return (
    <header className="e-page-header projects-heading">
      <div className="e-stack e-stack--xs">
        <h1 className="text-title-lg" ref={heading} tabIndex={-1}>
          {deleted ? "Deleted projects" : "Projects"}
        </h1>
        <p className="e-muted">
          {deleted
            ? "Restore a project at any time. Restoring won’t restart cancelled AI work."
            : "Every idea, in its own world."}
        </p>
      </div>
      <div className="e-cluster">
        {deleted ? (
          <ButtonLink variant="secondary" href="/brands" icon="arrow-left">
            Back to projects
          </ButtonLink>
        ) : (
          <>
            <ButtonLink variant="quiet" href="/brands?state=deleted">
              Deleted projects
            </ButtonLink>
            {showNew && (
              <ButtonLink variant="primary" href="/" icon="plus">
                New project
              </ButtonLink>
            )}
          </>
        )}
      </div>
    </header>
  );
}

export function ProjectsWorkspace({ state = "active" }: { state?: "active" | "deleted" }) {
  const { session } = useAccountSession();
  const deleted = state === "deleted";
  if (session.status !== "ready")
    return (
      <div className="e-container e-page projects-page">
        <ProjectsHeading deleted={deleted} showNew={false} />
        {session.status === "checking" ? (
          <div className="e-grid-cards projects-grid" aria-busy="true">
            <span className="e-sr" role="status">
              Loading your projects…
            </span>
            <ProjectCardSkeletons count={6} />
          </div>
        ) : (
          <SignedOutEmptyState
            title="Sign in to see your projects"
            text="Every project you start is kept in your account."
            fallback={<AccountStatus signedOut="Sign in to see your projects." />}
          />
        )}
      </div>
    );
  return <ProjectsLibrary key={`${session.userId}:${session.generation}:${state}`} account={session} state={state} />;
}

function ProjectsLibrary({ account, state }: { account: VerifiedAccount; state: "active" | "deleted" }) {
  const { listing, error, pending, load, reload, remove, update, rename } = useAccountProjectListing(account, state);
  // Search and sort are kept in the address (D-097); "state=deleted" stays as it is.
  const [query, setQuery] = useState(() => (readViewFromAddress().get("q") ?? "").slice(0, 120));
  const [sort, setSort] = useState<Sort>(() =>
    readViewFromAddress().get("sort") === "alphabetical" ? "alphabetical" : "created",
  );
  useEffect(() => {
    writeViewToAddress({ q: query.trim() || null, sort: sort === "created" ? null : sort });
  }, [query, sort]);
  const [notice, setNotice] = useState<{ project: LifecycleProject; action: ProjectDeletionAction } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const deleted = state === "deleted";
  const projects = listing?.items ?? [];
  const needle = query.trim().toLocaleLowerCase();
  const empty = Boolean(listing) && !projects.length && !listing?.nextCursor && !error;
  // Every loaded card stays mounted; a search only hides the ones it does not match, so clearing it shows them
  // again at once with no new read (D-073).
  const ordered = [...projects].sort(
    (a, b) =>
      (sort === "alphabetical" ? a.title.localeCompare(b.title, "en", { sensitivity: "base", numeric: true }) : 0) ||
      byRecent(a, b),
  );
  const matches = (project: LifecycleProject) => !needle || project.title.toLocaleLowerCase().includes(needle);
  const matching = ordered.filter(matches).length;

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

  const failed = Boolean(error) && !listing;
  return (
    <div className="e-container e-page projects-page">
      <ProjectsHeading deleted={deleted} showNew={!empty} heading={heading} />
      {notice && (
        <InlineMessage
          tone="positive"
          className="project-change-notice"
          actions={
            <>
              <ButtonLink
                size="sm"
                href={notice.action === "delete" ? "/brands?state=deleted" : `/brands/account/${notice.project.id}`}
              >
                {notice.action === "delete" ? "View deleted projects" : "Open project"}
              </ButtonLink>
              {notice.action === "delete" && (
                <ProjectDeletionStatus account={account} project={notice.project} onUpdated={updateNotice} compact />
              )}
            </>
          }
        >
          “{notice.project.title}” {notice.action === "delete" ? "moved to Deleted projects." : "restored."}
          {notice.action === "restore" && " Cancelled AI work won’t restart."}
        </InlineMessage>
      )}
      {!empty && (
        <div className="projects-toolbar">
          <TextField
            className="projects-search"
            label={deleted ? "Search deleted projects" : "Search projects"}
            hideLabel
            type="search"
            name="search"
            autoComplete="off"
            placeholder={deleted ? "Search deleted projects" : "Search projects"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onClear={() => setQuery("")}
          />
          <Menu
            label="Sort projects"
            items={sorts.map((option) => ({
              kind: "choice",
              label: option.label,
              checked: sort === option.value,
              onSelect: () => setSort(option.value),
            }))}
            trigger={(props) => (
              <Button {...props} icon="arrow-up-down" aria-label="Sort projects">
                Sort
              </Button>
            )}
          />
        </div>
      )}
      {empty ? (
        deleted ? (
          <EmptyState
            icon="trash"
            title="No deleted projects"
            text="Projects you delete appear here, with their files and history, ready to restore."
          />
        ) : (
          <EmptyState
            title="Your first project starts with an idea"
            text="Describe your idea on Home and Embel takes it from there. Every project you start is kept here."
            action={
              <ButtonLink variant="primary" href="/" icon="plus">
                New project
              </ButtonLink>
            }
          />
        )
      ) : failed ? (
        <div role="alert">
          <EmptyState
            danger
            icon="circle-alert"
            title={`Your ${deleted ? "deleted " : ""}projects couldn’t be loaded`}
            text="Your work is saved. Check your connection, then try again."
            action={
              <Button variant="primary" icon="rotate-ccw" loading={pending} onClick={() => void load()}>
                Try again
              </Button>
            }
          />
        </div>
      ) : (
        <>
          <section
            className="e-grid-cards projects-grid"
            aria-label={deleted ? "Deleted projects" : "Projects"}
            aria-busy={!listing ? true : undefined}
          >
            {!listing ? (
              <>
                <span className="e-sr" role="status">
                  Loading your {deleted ? "deleted " : ""}projects…
                </span>
                <ProjectCardSkeletons count={6} />
              </>
            ) : (
              ordered.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  account={account}
                  hidden={!matches(project)}
                  actions={(name, card) => (
                    <ProjectCardActions
                      // A rename saves a new revision without closing the menu's place, so the key leaves it out.
                      key={`${project.id}:${project.lifecycle_version}`}
                      project={project}
                      account={account}
                      name={name}
                      onChanged={changed}
                      onReload={refreshProjects}
                      onRenamed={
                        deleted
                          ? undefined
                          : (title, revision) => {
                              card.renamed(title, revision);
                              rename(project.id, title, revision);
                            }
                      }
                    />
                  )}
                  deletionStatus={
                    deleted ? (
                      <ProjectDeletionStatus account={account} project={project} onUpdated={update} />
                    ) : undefined
                  }
                />
              ))
            )}
          </section>
          {listing && !matching && needle && (
            <div role="status">
              <EmptyState
                variant="results"
                icon="search"
                title={`No ${deleted ? "deleted " : ""}projects match “${query.trim()}”`}
                text="Check the spelling, or search for another project name."
                action={<Button onClick={() => setQuery("")}>Clear search</Button>}
              />
            </div>
          )}
        </>
      )}
      {listing && (
        <div className="projects-more">
          {listing.nextCursor && needle && (
            <p className="e-muted">Search covers the projects shown. Load more to include older projects.</p>
          )}
          {error && (
            <InlineMessage
              tone="danger"
              actions={
                <Button size="sm" loading={pending} onClick={() => void load()}>
                  Try again
                </Button>
              }
            >
              Your {deleted ? "deleted " : ""}projects couldn’t be refreshed. The projects shown are still here.
            </InlineMessage>
          )}
          {listing.nextCursor && !error && (
            <Button loading={pending} onClick={() => void load()}>
              Show more projects
            </Button>
          )}
        </div>
      )}
      {!deleted && <UnsavedProjectRecovery />}
    </div>
  );
}
