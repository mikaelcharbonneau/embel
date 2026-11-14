"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/feedback";
import { InlineMessage } from "@/components/ui/message";
import { useBillingSummary, creditsLeft } from "@/components/billing/use-billing-summary";
import { HomeCreditsLine, HomeExamples } from "./home-examples";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { useAccountProjectListing } from "./account-projects";
import { ProjectCardActions } from "./project-card-actions";
import type { LifecycleProject } from "./project-deletion-client";
import { ProjectDeletionStatus } from "./project-deletion-status";
import { ProjectCard, ProjectCardSkeletons } from "./project-card";

/** Below the prompt. Signed out: the free start and three brands Embel made. Signed in: recent projects, or for an
 * account with none yet, its credits and what it will get. While the account is checked, a neutral frame. */
export function HomeRecentBrands() {
  const { session } = useAccountSession();
  if (session.status === "signed_out")
    return (
      <>
        <HomeCreditsLine credits="signed_out" />
        <HomeExamples title="Made with Embel" text="Each brand started as a short description of an idea." />
      </>
    );
  if (session.status !== "ready") return session.status === "checking" ? <HomeRecentSkeleton /> : null;
  return <HomeAccountRecentBrands key={`${session.userId}:${session.generation}`} account={session} />;
}

function HomeRecentSkeleton() {
  return (
    <section className="home-section" aria-busy="true">
      <span className="e-sr" role="status">
        Loading your projects…
      </span>
      <Skeleton shape="title" width={25} />
      <div className="home-project-grid">
        <ProjectCardSkeletons count={3} />
      </div>
    </section>
  );
}

function NewAccountHome() {
  const billing = useBillingSummary();
  return (
    <>
      {billing.status === "ready" && <HomeCreditsLine credits={creditsLeft(billing.summary)} />}
      <HomeExamples
        title="What you will get"
        text="A logo, colours, type and example uses, built from your idea. These brands were made with Embel."
      />
    </>
  );
}

function HomeAccountRecentBrands({ account }: { account: VerifiedAccount }) {
  const { listing, error, pending, reload, remove, rename } = useAccountProjectListing(account, "active", 6);
  const [removed, setRemoved] = useState<LifecycleProject | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const brands = [...(listing?.items ?? [])]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || a.id.localeCompare(b.id))
    .slice(0, 3);
  function changed(project: LifecycleProject) {
    remove(project.id);
    setRemoved(project);
    void reload();
    queueMicrotask(() => heading.current?.focus());
  }

  function updateRemoved(project: LifecycleProject) {
    // Status reads return the saved title; keep the name the card showed.
    setRemoved((previous) =>
      previous &&
      previous.id === project.id &&
      project.lifecycle_version >= previous.lifecycle_version &&
      project.current_revision >= previous.current_revision
        ? project.deletion_state === "active"
          ? null
          : { ...project, title: previous.title }
        : previous,
    );
  }

  async function refreshProjects() {
    const refreshed = await reload();
    if (refreshed) requestAnimationFrame(() => heading.current?.focus());
    return refreshed;
  }

  const loading = (!listing && !error) || (!brands.length && pending);
  if (!loading && listing && !brands.length && !listing.nextCursor && !removed && !error) return <NewAccountHome />;
  return (
    <section className="home-section" aria-labelledby="recent-heading">
      <div className="home-section__head">
        <h2 className="home-section__title" id="recent-heading" ref={heading} tabIndex={-1}>
          Recent projects
        </h2>
        <Link href="/brands" className="e-link e-link--standalone">
          All projects
          <Icon name="arrow-right" size="sm" />
        </Link>
      </div>
      {removed && (
        <InlineMessage
          actions={
            <>
              <Link className="e-button e-button--secondary e-button--sm" href="/brands?state=deleted">
                View deleted projects
              </Link>
              <ProjectDeletionStatus account={account} project={removed} onUpdated={updateRemoved} compact />
            </>
          }
        >
          “{removed.title}” moved to Deleted projects.
        </InlineMessage>
      )}
      {loading ? (
        <div className="home-project-grid" aria-busy="true">
          <span className="e-sr" role="status">
            Loading your projects…
          </span>
          <ProjectCardSkeletons count={3} />
        </div>
      ) : !listing ? null : brands.length ? (
        <div className="home-project-grid">
          {brands.map((brand) => (
            <ProjectCard
              key={brand.id}
              project={brand}
              account={account}
              headingLevel={3}
              actions={(name, card) => (
                <ProjectCardActions
                  // A rename saves a new revision without closing the menu's place, so the key leaves it out.
                  key={`${brand.id}:${brand.lifecycle_version}`}
                  project={brand}
                  account={account}
                  name={name}
                  onChanged={changed}
                  onReload={refreshProjects}
                  onRenamed={(title, revision) => {
                    card.renamed(title, revision);
                    rename(brand.id, title, revision);
                  }}
                />
              )}
            />
          ))}
        </div>
      ) : listing.nextCursor ? (
        <p className="e-muted">
          More projects are available.{" "}
          <Link className="e-link" href="/brands">
            View all projects
          </Link>
        </p>
      ) : null}
      {error && (
        <InlineMessage
          tone="danger"
          actions={
            <Button size="sm" loading={pending} onClick={() => void reload()}>
              Try again
            </Button>
          }
        >
          Your projects couldn’t be loaded.
        </InlineMessage>
      )}
    </section>
  );
}
