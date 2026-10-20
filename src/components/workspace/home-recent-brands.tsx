"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { useAccountProjectListing } from "./account-projects";
import { ProjectCardActions } from "./project-card-actions";
import type { LifecycleProject } from "./project-deletion-client";
import { ProjectDeletionStatus } from "./project-deletion-status";
import { ProjectCard } from "./project-card";

export function HomeRecentBrands() {
  const { session } = useAccountSession();
  if (session.status !== "ready") return null;
  return <HomeAccountRecentBrands key={`${session.userId}:${session.generation}`} account={session} />;
}

function HomeAccountRecentBrands({ account }: { account: VerifiedAccount }) {
  const { listing, error, pending, reload, remove } = useAccountProjectListing(account, "active", 6);
  const [removed, setRemoved] = useState<LifecycleProject | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const brands = [...(listing?.items ?? [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || a.id.localeCompare(b.id)).slice(0, 6);
  function changed(project: LifecycleProject) {
    remove(project.id); setRemoved(project); void reload();
    queueMicrotask(() => heading.current?.focus());
  }

  function updateRemoved(project: LifecycleProject) {
    setRemoved(previous => previous && previous.id === project.id && project.lifecycle_version >= previous.lifecycle_version && project.current_revision >= previous.current_revision ? project.deletion_state === "active" ? null : project : previous);
  }

  async function refreshProjects() {
    const refreshed = await reload();
    if (refreshed) requestAnimationFrame(() => heading.current?.focus());
    return refreshed;
  }

  return <section className="home-recent" aria-labelledby="recent-heading">
    <div className="home-recent-heading"><h2 id="recent-heading" ref={heading} tabIndex={-1}>Pick up where you left off</h2><Link href="/brands" className="text-link">All projects<Icon name="arrow" size={16} /></Link></div>
    {removed && <div className="project-change-notice" role="status"><span>“{removed.title}” moved to Deleted projects.</span><Link className="text-link" href="/brands?state=deleted">View deleted projects</Link><ProjectDeletionStatus account={account} project={removed} onUpdated={updateRemoved} compact /></div>}
    {!listing && !error ? <p className="quiet-empty" role="status">Loading your projects…</p> : !listing && error ? null : brands.length ? <div className="home-brand-grid">
      {brands.map(brand => <ProjectCard key={brand.id} project={brand} account={account} headingLevel={3}
        date={Number.isFinite(Date.parse(brand.created_at)) ? `Created ${new Date(brand.created_at).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" })}` : "Date unavailable"}
        actions={<ProjectCardActions key={`${brand.id}:${brand.current_revision}:${brand.lifecycle_version}`} project={brand} account={account} onChanged={changed} onReload={refreshProjects} />} />)}
    </div> : pending ? <p className="quiet-empty" role="status">Loading your projects…</p> : listing?.nextCursor ? <p className="quiet-empty">More projects are available. <Link className="text-link" href="/brands">View all projects</Link></p> : <div className="home-brands-empty"><Icon name="brands" size={24} /><h3>Your first brand starts here</h3><p>Describe your idea above. Your saved work will appear here.</p></div>}
    {error && <p className="form-error" role="alert">Your projects could not be loaded. <button type="button" className="text-link" disabled={pending} onClick={() => void reload()}>Try again</button></p>}
  </section>;
}
