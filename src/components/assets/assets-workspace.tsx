"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { assetFileTypeSchema, type AssetLibraryItem } from "@/domain/asset-library";
import { AssetDetailDialog } from "./asset-detail";
import { AssetPreview } from "./asset-preview";
import { useAssetLibrary } from "./use-asset-library";

export function AssetsWorkspace() {
  const { session } = useAccountSession();
  return <div className="page assets-page"><header className="assets-heading"><div><h1 tabIndex={-1} id="assets-heading">Assets</h1><p>Your visual work, across brands.</p></div></header>{session.status === "ready" ? <OwnedAssetLibrary key={`${session.userId}:${session.generation}`} account={session} /> : <AccountStatus />}</div>;
}

function OwnedAssetLibrary({ account }: { account: VerifiedAccount }) {
  const library = useAssetLibrary(account);
  const [opened, setOpened] = useState<AssetLibraryItem | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  function close() {
    setOpened(null);
    requestAnimationFrame(() => { (returnFocus.current?.isConnected ? returnFocus.current : document.getElementById("assets-heading"))?.focus(); });
  }
  return <section aria-label="Account asset library">
    <div className="assets-toolbar"><div className="assets-tabs" role="tablist" aria-label="Asset views">{(["my_selection", "all_generations"] as const).map(tab => <button id={`assets-tab-${tab}`} key={tab} type="button" role="tab" aria-controls="assets-results" aria-selected={library.query.tab === tab} tabIndex={library.query.tab === tab ? 0 : -1} disabled={library.busy} onClick={() => library.changeQuery({ ...library.query, tab })} onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const next = event.key === "Home" ? "my_selection" : event.key === "End" ? "all_generations" : tab === "my_selection" ? "all_generations" : "my_selection";
      library.changeQuery({ ...library.query, tab: next }); document.getElementById(`assets-tab-${next}`)?.focus();
    }}>{tab === "my_selection" ? "My selection" : "All generations"}</button>)}</div>
      <div className="assets-filters"><label><span className="sr-only">Brand</span><select aria-label="Brand" value={library.query.projectId ?? ""} disabled={library.busy} onChange={event => library.changeQuery({ tab: library.query.tab, ...(event.target.value ? { projectId: event.target.value } : {}), ...(library.query.format ? { format: library.query.format } : {}) })}><option value="">All brands</option>{library.projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label><label><span className="sr-only">File type</span><select aria-label="File type" value={library.query.format ?? ""} disabled={library.busy} onChange={event => library.changeQuery({ tab: library.query.tab, ...(library.query.projectId ? { projectId: library.query.projectId } : {}), ...(event.target.value ? { format: assetFileTypeSchema.parse(event.target.value) } : {}) })}><option value="">All file types</option>{assetFileTypeSchema.options.map(format => <option value={format} key={format}>{format === "other" ? "Other files" : format.toUpperCase()}</option>)}</select></label></div>
    </div>
    <div className="assets-view-note"><p>{library.query.tab === "my_selection" ? "Liked, saved or used in a brand. Each asset appears once." : "Every asset and its version history."}</p><button type="button" className="text-link" disabled={library.busy || library.status === "loading"} onClick={library.refresh}>Check assets</button></div>
    {library.facetUnavailable && <p className="assets-muted">The brand list could not be loaded. Brands from the loaded assets remain available in the filter.</p>}
    {library.facetLimited && <p className="assets-muted">The brand filter includes the 100 most recent brands and other brands from assets loaded below.</p>}
    {library.error && <div role="alert" className="assets-notice"><p>{library.error}</p><button type="button" className="button secondary small" disabled={library.busy} onClick={library.refresh}>Check assets again</button></div>}
    <div role="tabpanel" id="assets-results" aria-labelledby={`assets-tab-${library.query.tab}`} aria-busy={library.status === "loading"}>
      {library.status === "loading" && <p className="assets-muted assets-loading" role="status">Loading assets…</p>}
      {library.page && <>
        {library.page.items.length > 0 ? <><div className="assets-grid">{library.page.items.map(item => <article className="assets-card" key={item.asset.id} aria-label={`${item.asset.kind} · ${item.project.title}`}>
          <button type="button" className="assets-open" aria-label={`Open ${item.asset.kind} from ${item.project.title}`} onClick={event => { returnFocus.current = event.currentTarget; setOpened(item); }}><AssetPreview version={item.displayedVersion} client={library.client} retryable={false} label={`${item.asset.kind} preview`} /></button>
          <div className="assets-card-body"><div className="assets-card-title"><h2>{item.asset.kind}</h2><span>{item.displayedVersion?.format.toUpperCase() ?? "—"}</span></div><Link className="assets-brand" href={`/brands/account/${item.project.id}`}>{item.project.title}</Link><div className="assets-badges">{item.asset.usage.active && <span className="is-used">Used in brand</span>}{item.asset.usage.legacy && <span>Legacy use</span>}{item.asset.currentSelection && <span>Selected v{item.selectedVersion!.versionNumber}</span>}{item.displayedVersion && item.displayedVersion.versionId !== item.selectedVersion?.versionId && <span>Preview v{item.displayedVersion.versionNumber}</span>}</div>
            <div className="assets-card-footer"><span>{item.asset.versionCount} {item.asset.versionCount === 1 ? "version" : "versions"}{library.query.format ? ` · ${item.matchingVersions.totalCount} ${library.query.format.toUpperCase()}` : ""}</span><div><button type="button" className="assets-retain" disabled={library.busy || library.needsCheck} aria-pressed={item.asset.liked} aria-label={`${item.asset.liked ? "Unlike" : "Like"} ${item.asset.kind} from ${item.project.title}`} onClick={() => void library.retain(item, "liked")}><svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill={item.asset.liked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5"><path d="M20.4 4.6a5.5 5.5 0 0 0-7.8 0L12 5.2l-.6-.6a5.5 5.5 0 0 0-7.8 7.8L12 21l8.4-8.6a5.5 5.5 0 0 0 0-7.8Z" /></svg></button><button type="button" className="assets-retain" disabled={library.busy || library.needsCheck} aria-pressed={item.asset.saved} aria-label={`${item.asset.saved ? "Unsave" : "Save"} ${item.asset.kind} from ${item.project.title}`} onClick={() => void library.retain(item, "saved")}><svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill={item.asset.saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5"><path d="M6 3h12v18l-6-4-6 4Z" /></svg></button></div></div>
          </div>
        </article>)}</div><div className="assets-pagination"><span>{library.page.items.length} assets loaded</span>{library.page.nextCursor && <button className="button secondary small" type="button" disabled={library.busy || library.status !== "ready"} onClick={() => void library.loadMore()}>Load more assets</button>}</div></> : library.status !== "loading" && <div className="assets-empty"><span><Icon name="assets" size={29} /></span><h2>{library.query.projectId || library.query.format ? "No assets match these filters" : library.query.tab === "my_selection" ? "No selected assets yet" : "No saved assets yet"}</h2><p>{library.query.projectId || library.query.format ? "Change the brand or file type to explore more assets." : library.query.tab === "my_selection" ? "Like or save an asset to bring it here. Assets used in a brand appear here too." : "Your account's visual assets and every saved version will appear here."}</p>{library.query.tab === "my_selection" && !library.query.projectId && !library.query.format ? <button className="button secondary small" type="button" onClick={() => library.changeQuery({ tab: "all_generations" })}>Browse all generations<Icon name="arrow" size={14} /></button> : <Link className="button secondary small" href="/brands">Open brands<Icon name="arrow" size={14} /></Link>}</div>}
      </>}
    </div>
    <p className="assets-generation-note">Image generation is not connected. This library shows files and versions already saved in your account.</p>
    {opened && <AssetDetailDialog key={opened.asset.id} item={opened} client={library.client} onClose={close} onSelected={library.refresh} />}
  </section>;
}
