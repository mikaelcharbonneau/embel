"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/ui/icon";
import { draftTitle, scopeLabel, useLocalDrafts, scopeDetails, type LocalDraft } from "./local-drafts";
import { NewProjectForm } from "./project-editor";
import { AccountProjects } from "./account-projects";
import type { ProjectScope } from "@/domain/projects";
import "@/styles/brand-list-controls.css";

function DraftCard({ draft }: { draft: LocalDraft }) {
  return <Link href={`/brands/${draft.id}`} className="draft-card">
    <div className="draft-preview" aria-hidden="true">{draftTitle(draft)}</div><div className="draft-card-top"><span className="small-badge">Browser draft</span></div>
    <h3>{draftTitle(draft)}</h3><p className="draft-excerpt">{draft.description}</p>
    <div className="draft-card-footer"><span>{scopeLabel(draft.scope)}</span><span className="draft-stage">{draft.stage === "positioning" ? "Positioning" : draft.stage === "personality" ? "Personality" : draft.audienceReviewedAt ? <><Icon name="check" size={13} />Audience reviewed</> : draft.stage === "audience" ? "Audience" : draft.stage === "competitors" ? "Competitors" : "Brief"}<Icon name="chevron" size={13} /></span></div>
  </Link>;
}

export function HomeWorkspace() {
  const { drafts, loaded } = useLocalDrafts();
  const recent = [...drafts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);
  return <div className="page home-page"><NewProjectForm initialScope="complete_brand" home />
    <section className="recent-section" aria-labelledby="recent-heading"><div className="section-heading"><h2 id="recent-heading">Recent brands</h2><Link href="/brands" className="text-link">All brands<Icon name="arrow" size={16} /></Link></div>
      {!loaded ? <div className="quiet-empty">Loading local drafts…</div> : recent.length ? <div className="draft-grid">{recent.map((draft) => <DraftCard key={draft.id} draft={draft} />)}</div> : <div className="recent-empty"><span className="empty-icon"><Icon name="file" size={22} /></span><div><h3>Your first brief starts here</h3><p>Describe your project above. Your draft will stay in this browser.</p></div></div>}
    </section>
    <div className="workspace-note"><Icon name="device" size={17} /><p>Browser drafts stay on this device. Account copies are saved separately.</p><Link href="/settings">Details<Icon name="chevron" size={13} /></Link></div>
  </div>;
}

export function BrandsWorkspace() {
  const { drafts, loaded } = useLocalDrafts();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ProjectScope | "all">("all");
  const [sort, setSort] = useState<"updated" | "created" | "alphabetical">("updated");
  const filtering = Boolean(query) || scope !== "all";
  const matching = [...drafts].filter(draft => (scope === "all" || draft.scope === scope) &&
    `${draft.title} ${draft.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => {
      const alphabetical = sort === "alphabetical" ? draftTitle(a).localeCompare(draftTitle(b), "en", { sensitivity: "base", numeric: true }) : 0;
      const time = sort === "created" ? Date.parse(b.createdAt) - Date.parse(a.createdAt) : Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      return alphabetical || time || b.id.localeCompare(a.id);
    });
  return <div className="page brands-page"><div className="page-heading"><h1>Brands</h1><div className="brands-heading-actions"><Link className="button secondary" href="/brands/logo/new">Create a logo</Link><Link className="button primary" href="/brands/new">New brand<Icon name="plus" size={17} /></Link></div></div>
    <div className="library-toolbar"><label className="search-field"><span className="sr-only">Search brands</span><Icon name="search" size={18} /><input type="search" placeholder="Search loaded brands" value={query} onChange={(event) => setQuery(event.target.value)} /></label><label className="brand-list-control">Scope<select aria-label="Filter brands by scope" value={scope} onChange={event => setScope(event.target.value as ProjectScope | "all")}><option value="all">All scopes</option>{scopeDetails.map(detail => <option key={detail.value} value={detail.value}>{detail.label}</option>)}</select></label><span className="secondary-text">{drafts.length} local {drafts.length === 1 ? "draft" : "drafts"}</span></div>
    <AccountProjects query={query} scope={scope} />
    <section className="browser-library" aria-labelledby="browser-drafts-heading"><div className="section-heading"><h2 id="browser-drafts-heading">Browser drafts</h2><span className="secondary-text">On this device</span></div><label className="brand-list-control brand-list-sort">Sort browser drafts<select value={sort} onChange={event => setSort(event.target.value as typeof sort)}><option value="updated">Recently updated</option><option value="created">Recently created</option><option value="alphabetical">Alphabetical</option></select></label>
    {!loaded ? <div className="quiet-empty">Loading local drafts…</div> : matching.length ? <div className="draft-grid">{matching.map((draft) => <DraftCard key={draft.id} draft={draft} />)}</div> : <div className="empty-panel"><span className="empty-icon large"><Icon name={filtering ? "file" : "brands"} size={25} /></span><h2>{filtering ? "No matching drafts" : "No brand drafts yet"}</h2><p>{filtering ? "Try a different scope, project name or word from the brief." : "Start with a complete brand, a name, or a visual identity."}</p>{!filtering && <Link href="/brands/new" className="button primary"><Icon name="plus" size={17} />Create a brand draft</Link>}</div>}
    <p className="library-footnote"><Icon name="device" size={15} />Browser drafts stay on this device. Saving an account copy leaves the browser draft here.</p></section>
  </div>;
}
