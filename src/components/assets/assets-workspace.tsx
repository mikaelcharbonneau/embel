"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AssetsArtwork } from "@/components/ui/assets-artwork";
import { Icon } from "@/components/ui/icon";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { assetFileTypeSchema, type AssetLibraryItem } from "@/domain/asset-library";
import { AssetDetailDialog } from "./asset-detail";
import { AssetPreview } from "./asset-preview";
import { useAssetLibrary } from "./use-asset-library";

export function AssetsWorkspace() {
  const { session } = useAccountSession();
  return <div className="assets-page assets-guided"><header className="assets-heading"><div><h1 tabIndex={-1} id="assets-heading">Your visual library<span>.</span></h1><p>All the pieces of your projects, in one place.</p></div></header>{session.status === "ready" ? <OwnedAssetLibrary key={`${session.userId}:${session.generation}`} account={session} /> : <AccountStatus />}</div>;
}

function OwnedAssetLibrary({ account }: { account: VerifiedAccount }) {
  const library = useAssetLibrary(account);
  const section = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // A retention write temporarily disables its button and can move focus to
    // the document. Escape must still dismiss this owner's open action menu.
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      section.current?.querySelectorAll<HTMLDetailsElement>(".assets-card-options[open]").forEach(menu => {
        const containedFocus = menu.contains(document.activeElement);
        menu.open = false;
        if (containedFocus) menu.querySelector("summary")?.focus();
      });
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, []);
  const [search, setSearch] = useState("");
  const [opened, setOpened] = useState<AssetLibraryItem | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  function close() {
    setOpened(null);
    requestAnimationFrame(() => { (returnFocus.current?.isConnected ? returnFocus.current : document.getElementById("assets-heading"))?.focus(); });
  }
  const needle = search.trim().toLocaleLowerCase();
  const visible = library.page?.items.filter(item => !needle || `${item.asset.kind} ${item.project.title} ${item.displayedVersion?.format ?? ""}`.toLocaleLowerCase().includes(needle)) ?? [];
  return <section ref={section} aria-label="Account asset library">
    <div className="assets-toolbar"><div className="assets-tabs" role="tablist" aria-label="Asset views">{(["my_selection", "all_generations"] as const).map(tab => <button id={`assets-tab-${tab}`} key={tab} type="button" role="tab" aria-controls="assets-results" aria-selected={library.query.tab === tab} tabIndex={library.query.tab === tab ? 0 : -1} disabled={library.busy} onClick={() => library.changeQuery({ ...library.query, tab })} onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const next = event.key === "Home" ? "my_selection" : event.key === "End" ? "all_generations" : tab === "my_selection" ? "all_generations" : "my_selection";
      library.changeQuery({ ...library.query, tab: next }); document.getElementById(`assets-tab-${next}`)?.focus();
    }}>{tab === "my_selection" ? "My selection" : "All generations"}</button>)}</div>
    </div>
    <div className="assets-guided-filters"><label className="assets-search"><span className="sr-only">Search assets</span><input type="search" placeholder="Search assets" maxLength={120} value={search} onChange={event => setSearch(event.target.value)} aria-describedby={needle && library.page?.nextCursor ? "assets-search-note" : undefined} /></label>
      <AssetFilter label="Project" value={library.query.projectId ?? ""} disabled={library.busy} onChange={value => library.changeQuery({ ...library.query, projectId: value || undefined })} options={[{ value: "", label: "All projects" }, ...library.projects.map(project => ({ value: project.id, label: project.title }))]} />
      <AssetFilter label="File type" value={library.query.format ?? ""} disabled={library.busy} onChange={value => library.changeQuery({ ...library.query, format: value ? assetFileTypeSchema.parse(value) : undefined })} options={[{ value: "", label: "All formats" }, ...assetFileTypeSchema.options.map(format => ({ value: format, label: format === "other" ? "Other files" : format.toUpperCase() }))]} />
    </div>
    {needle && library.page?.nextCursor && <p id="assets-search-note" className="assets-muted">Search covers loaded assets. Load more to search the rest of this view.</p>}
    {library.facetUnavailable && <p className="assets-muted">The project list could not be loaded. Projects from the loaded assets remain available in the filter.</p>}
    {library.facetLimited && <p className="assets-muted">The project filter includes the 100 most recent projects and other projects from assets loaded below.</p>}
    {library.error && <div role="alert" className="assets-notice"><p>{library.error}</p><button type="button" className="button secondary small" disabled={library.busy} onClick={library.refresh}>Check assets again</button></div>}
    <div role="tabpanel" id="assets-results" aria-labelledby={`assets-tab-${library.query.tab}`} aria-busy={library.status === "loading"}>
      {library.status === "loading" && <p className="assets-muted assets-loading" role="status">Loading assets…</p>}
      {library.page && <>
        {visible.length > 0 ? <><div className="assets-grid">{visible.map(item => <article className="assets-card" key={item.asset.id} aria-label={`${item.asset.kind} · ${item.project.title}`}>
          <button type="button" className="assets-open" aria-label={`Open ${item.asset.kind} from ${item.project.title}`} onClick={event => { returnFocus.current = event.currentTarget; setOpened(item); }}><AssetPreview version={item.displayedVersion} client={library.client} retryable={false} label={`${item.asset.kind} preview`} /></button>
          <div className="assets-card-body"><div className="assets-card-title"><h2>{item.asset.kind}</h2><span>{item.displayedVersion?.format.toUpperCase() ?? "—"}</span></div>
            <div className="assets-card-context"><Link className="assets-brand" href={`/brands/account/${item.project.id}`}>{item.project.title}</Link><span aria-hidden="true"> · </span><span>{item.asset.usage.active ? "Used in brand" : item.asset.usage.legacy ? "Legacy use" : item.asset.currentSelection ? `Selected v${item.selectedVersion!.versionNumber}` : item.asset.saved ? "Saved" : item.asset.liked ? "Liked" : "Not selected"}</span><button type="button" className="assets-open-detail" aria-label={`View details of ${item.asset.kind} from ${item.project.title}`} onClick={event => { returnFocus.current = event.currentTarget; setOpened(item); }}><AssetsArtwork name="open" /></button></div>
          </div>
          <details className="assets-card-options" name="asset-card-actions"><summary aria-label={`Actions for ${item.asset.kind} from ${item.project.title}`}>···</summary><div className="assets-card-options-panel"><div className="assets-badges">{item.asset.currentSelection && (item.asset.usage.active || item.asset.usage.legacy) && <span>Selected v{item.selectedVersion!.versionNumber}</span>}{item.displayedVersion && item.displayedVersion.versionId !== item.selectedVersion?.versionId && <span>Preview v{item.displayedVersion.versionNumber}</span>}</div><p>{item.asset.versionCount} {item.asset.versionCount === 1 ? "version" : "versions"}{library.query.format ? ` · ${item.matchingVersions.totalCount} ${library.query.format.toUpperCase()}` : ""}</p><div><button type="button" className="assets-retain" disabled={library.busy || library.needsCheck} aria-pressed={item.asset.liked} aria-label={`${item.asset.liked ? "Unlike" : "Like"} ${item.asset.kind} from ${item.project.title}`} onClick={() => void library.retain(item, "liked")}><svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill={item.asset.liked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5"><path d="M20.4 4.6a5.5 5.5 0 0 0-7.8 0L12 5.2l-.6-.6a5.5 5.5 0 0 0-7.8 7.8L12 21l8.4-8.6a5.5 5.5 0 0 0 0-7.8Z" /></svg></button><button type="button" className="assets-retain" disabled={library.busy || library.needsCheck} aria-pressed={item.asset.saved} aria-label={`${item.asset.saved ? "Unsave" : "Save"} ${item.asset.kind} from ${item.project.title}`} onClick={() => void library.retain(item, "saved")}><svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill={item.asset.saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5"><path d="M6 3h12v18l-6-4-6 4Z" /></svg></button></div></div></details>
        </article>)}</div></> : library.status !== "loading" && <div className="assets-empty"><span><Icon name="assets" size={29} /></span><h2>{needle || library.query.projectId || library.query.format ? "No assets match these filters" : library.query.tab === "my_selection" ? "No selected assets yet" : "No saved assets yet"}</h2><p>{needle || library.query.projectId || library.query.format ? "Change the search, project or format to explore more assets." : library.query.tab === "my_selection" ? "Like or save an asset to bring it here. Assets used in a brand appear here too." : "Your account's visual assets and every saved version will appear here."}</p>{library.query.tab === "my_selection" && !needle && !library.query.projectId && !library.query.format ? <button className="button secondary small" type="button" onClick={() => library.changeQuery({ tab: "all_generations" })}>Browse all generations<Icon name="arrow" size={14} /></button> : <Link className="button secondary small" href="/brands">Open projects<Icon name="arrow" size={14} /></Link>}</div>}
        <div className="assets-pagination"><span>{needle ? `${visible.length} matches in ${library.page.items.length} loaded assets` : `${library.page.items.length} assets loaded`}</span><span>Versions stay in your library when a new selection is made.</span>{library.page.nextCursor && <button className="button secondary small" type="button" disabled={library.busy || library.status !== "ready"} onClick={() => void library.loadMore()}>Load more assets</button>}</div>
      </>}
    </div>
    <div className="assets-library-notes"><button type="button" className="text-link" disabled={library.busy || library.status === "loading"} onClick={library.refresh}>Check assets</button><p className="assets-generation-note">Image generation is not connected. This library shows files and versions already saved in your account.</p></div>
    {opened && <AssetDetailDialog key={opened.asset.id} item={opened} client={library.client} onClose={close} onSelected={library.refresh} />}
  </section>;
}

function AssetFilter({ label, value, options, disabled, onChange }: { label: string; value: string; options: { value: string; label: string }[]; disabled: boolean; onChange: (value: string) => void }) {
  return <label className="assets-filter"><span className="sr-only">{label}</span><select aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><AssetsArtwork name="filter" /></label>;
}
