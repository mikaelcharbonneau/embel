"use client";

import { EmbelIdentity } from "@/components/workspace/embel-identity";
import { journeyPartLabel } from "@/domain/journey";
import { isDialogBackdropClick } from "@/components/ui/dialog-backdrop";

import Link from "next/link";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { inspirationCatalog, inspirationLabels, filterInspiration, hasInspirationChoice, type InspirationDesign, type InspirationPreferences } from "@/domain/inspiration";
import { AccountStatus, useAccountSession } from "@/components/workspace/account-session";
import { Icon } from "@/components/ui/icon";
import { useInspiration, type InspirationController } from "./use-inspiration";
import "./inspiration.css";

const noChoice: InspirationPreferences = { ensemble: false, elements: [] };
// Keep immutable references and saved selections, but do not recommend images
// whose mark is tiny, obscured or absent at gallery size.
const retiredFromDiscovery = new Set(["mastercard-stationery", "dropbox-color-guide", "mastercard-brochures", "dropbox-street-posters", "cardless-credit-card", "into-illuminated-billboard", "dropbox-color-posters"]);
const designs = inspirationCatalog.filter(design => !retiredFromDiscovery.has(design.slug));
function Heart({ liked }: { liked: boolean }) {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill={liked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" /></svg>;
}
function Artwork({ design, eager = false, retry = false }: { design: InspirationDesign; eager?: boolean; retry?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="inspiration-image-error" style={{ aspectRatio: `${design.width}/${design.height}` }}><Icon name="assets" /><span>Image unavailable</span>{retry && <button type="button" onClick={() => setFailed(false)}>Retry image</button>}</span>;
  // Catalog imagery is original, attributed reference material, not a project output.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="inspiration-image" src={design.image} width={design.width} height={design.height} alt={design.description} loading={eager ? "eager" : "lazy"} onError={() => setFailed(true)} />;
}
function Recovery({ design, controller }: { design: InspirationDesign; controller: InspirationController }) {
  const intent = controller.intents.get(design.id);
  if (!intent) return null;
  if (controller.busy.has(design.id)) return <p className="inspiration-saving" role="status">Saving choices…</p>;
  return <div className="inspiration-recovery" role="status"><p>{intent.error}</p><div>
    <button type="button" onClick={() => void controller.check(design.id)}>Check saved choices</button>
    <button type="button" disabled={!controller.canSave || !intent.checked || intent.expectedRevision !== (controller.overview?.choices.find(choice => choice.referenceId === design.id)?.revision ?? 0) || intent.expectedProjectRevision !== controller.overview?.projectRevision} onClick={() => void controller.save(design.id, intent.desired, true)}>Save my changes</button>
    <button type="button" onClick={() => controller.keepSaved(design.id)}>Keep saved choices</button>
  </div></div>;
}
function DesignDetail({ design, choice, controller, onClose }: { design: InspirationDesign; choice: InspirationPreferences; controller: InspirationController; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; const previous = document.activeElement; element?.showModal(); return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  const available = controller.overview?.availableReferenceIds?.includes(design.id) ?? !design.availableSince;
  const disabled = !controller.canSave || !available || controller.intents.has(design.id);
  return <dialog ref={dialog} className="inspiration-detail" aria-labelledby="inspiration-detail-title" onCancel={onClose} onClick={event => { if (isDialogBackdropClick(event)) onClose(); }}>
    <div className="inspiration-detail-layout"><div className="inspiration-detail-art"><Artwork design={design} eager retry /></div>
      <div className="inspiration-detail-body"><div className="inspiration-detail-top"><span>DESIGN REFERENCE</span><button autoFocus type="button" className="inspiration-icon-button" aria-label="Close design detail" onClick={onClose}><Icon name="close" size={18} /></button></div>
        <h2 id="inspiration-detail-title">{design.brand}</h2><p>{design.creator} · {design.kind === "identity" ? "Identity" : "Logo"}</p><p>{design.description}</p>
        <a className="inspiration-action" href={design.sourceUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">View original project<Icon name="arrow" size={16} /></a>
        {design.provenance && <p className="inspiration-reference-rights">Reference icon via <a href={design.provenance.source} target="_blank" rel="noopener noreferrer">Simple Icons</a> ({design.provenance.license}). {design.provenance.trademarkNotice}</p>}
        {!available && <p role="status">This new reference is available to browse. Saving it will be enabled with the catalog update.</p>}
        <hr /><h3>What do you like?</h3><p>Like the whole design or choose the details.</p>
        <button className="inspiration-overall" type="button" aria-pressed={choice.ensemble} disabled={disabled} onClick={() => void controller.save(design.id, { ...choice, ensemble: !choice.ensemble })}><Heart liked={choice.ensemble} />Overall look</button>
        <div className="inspiration-elements" aria-label="Design elements">{design.elements.map(element => <button key={element} type="button" aria-pressed={choice.elements.includes(element)} disabled={disabled} onClick={() => void controller.save(design.id, { ...choice, elements: choice.elements.includes(element) ? choice.elements.filter(value => value !== element) : [...choice.elements, element] })}>{inspirationLabels[element]}</button>)}</div>
        <Recovery design={design} controller={controller} />
        <p className="inspiration-detail-footer">Your choices stay with {controller.overview?.projectTitle ?? "this project"}. Change them anytime.</p>
      </div>
    </div>
  </dialog>;
}
/** Keep image/focus identity while preserving the approved round-robin masonry. */
function InspirationGrid({ children }: { children: ReactNode }) {
  const grid = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = grid.current;
    if (!node) return;
    const cards = Array.from(node.children) as HTMLElement[];
    const layout = () => {
      const width = node.getBoundingClientRect().width;
      if (!width) return;
      const columns = width >= 1200 ? 5 : width >= 900 ? 4 : width >= 620 ? 3 : width >= 350 ? 2 : 1;
      const cardWidth = (width - (columns - 1) * 16) / columns;
      node.style.setProperty("--inspiration-card-width", `${cardWidth}px`);
      node.dataset.positioned = "true";
      const heights = Array<number>(columns).fill(0);
      cards.forEach((card, index) => {
        const column = index % columns;
        card.style.left = `${column * (cardWidth + 16)}px`;
        card.style.top = `${heights[column]}px`;
        heights[column]! += card.getBoundingClientRect().height + 20;
      });
      node.style.height = `${Math.max(0, ...heights) - (cards.length ? 20 : 0)}px`;
    };
    layout();
    const observer = new ResizeObserver(layout);
    observer.observe(node);
    cards.forEach(card => observer.observe(card));
    return () => observer.disconnect();
  }, [children]);
  return <div className="inspiration-columns" ref={grid}>{children}</div>;
}
export function InspirationWorkspace({ projectId }: { projectId: string }) {
  const { session } = useAccountSession();
  if (session.status !== "ready") return <div className="page"><h1>Inspiration</h1><AccountStatus /></div>;
  return <OwnedInspiration key={`${session.userId}:${session.generation}:${projectId}`} account={session} projectId={projectId} />;
}
function OwnedInspiration({ account, projectId }: { account: Extract<ReturnType<typeof useAccountSession>["session"], { status: "ready" }>; projectId: string }) {
  const controller = useInspiration(account, projectId);
  return <InspirationView controller={controller} projectId={projectId} />;
}
/** The view accepts the real controller contract so isolated browser checks use the same UI. */
export function InspirationView({ controller, projectId }: { controller: InspirationController; projectId: string }) {
  const availabilityId = useId();
  const [query, setQuery] = useState(""), [kind, setKind] = useState<"all" | "identity" | "logo">("all"), [liked, setLiked] = useState(false);
  const [selected, setSelected] = useState<InspirationDesign | null>(null);
  const saved = useMemo(() => new Map(controller.overview?.choices.map(choice => [choice.referenceId, choice]) ?? []), [controller.overview]);
  const displayed = useMemo(() => {
    const choices = new Map<string, InspirationPreferences>(saved);
    controller.intents.forEach((intent, id) => choices.set(id, intent.desired)); return choices;
  }, [saved, controller.intents]);
  const visible = filterInspiration(liked ? inspirationCatalog : designs, query, kind, liked, displayed);
  const count = [...saved.values()].filter(hasInspirationChoice).length;
  return <div className="inspiration-workspace">
    <section className="inspiration-browse" aria-label="Inspiration gallery"><div className="guided-assistant-message identity-conversation-message inspiration-message">
        <EmbelIdentity label={journeyPartLabel("identity", "Inspiration")} />
        <h1 className="sr-only">Inspiration</h1>
        <p className="guided-assistant-copy">Let’s shape how your brand looks. Like the designs you’re drawn to: the whole look, or open one to choose just the colours, type or layout. Your likes guide the logo concepts.</p>
        <h2 className="inspiration-question">What do you like?</h2>
      </div>
      <div className="inspiration-toolbar"><div className="inspiration-views" aria-label="Inspiration views"><button type="button" aria-pressed={!liked} onClick={() => setLiked(false)}>Browse</button><button type="button" aria-pressed={liked} onClick={() => setLiked(true)}>Liked <span>· {controller.overview ? count : "—"}</span></button></div>
        <label className="inspiration-search"><Icon name="search" size={16} /><input type="search" aria-label="Search identities and logos" placeholder="Search identities and logos…" value={query} maxLength={160} onChange={event => setQuery(event.target.value)} /></label>
        <div className="inspiration-categories" aria-label="Reference categories">{([['identity', 'Identities'], ['logo', 'Logos'], ['all', 'All']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>)}</div>
      </div>
      {controller.error ? <div className="inspiration-notice" role="status"><span>{controller.error}</span><button type="button" onClick={() => void controller.refresh()} disabled={controller.loading}>Retry connection</button></div> : controller.loading ? <p className="inspiration-notice" role="status">Loading saved choices…</p> : controller.blocked ? <p className="inspiration-notice">Save or resolve your project edits before changing inspiration.</p> : controller.overview?.projectScope === "naming_only" ? <p className="inspiration-notice">Expand this project to a complete brand to save visual preferences. <Link href={`/brands/account/${projectId}`}>Open project</Link></p> : null}
      <div className="inspiration-feed">
        {liked && !controller.overview ? <div className="inspiration-empty"><h2>Saved choices are not available yet</h2><p>Reconnect to load this project’s liked designs.</p></div> : visible.length ? <InspirationGrid>
          {visible.map(design => {
            const choice = displayed.get(design.id) ?? noChoice, busy = controller.busy.has(design.id), pending = controller.intents.has(design.id);
            const available = controller.overview?.availableReferenceIds?.includes(design.id) ?? !design.availableSince;
            const catalogPending = Boolean(controller.overview && !available);
            return <article key={design.id} className="inspiration-card" aria-label={`${design.brand} — ${design.slug}`}>
              <div className="inspiration-card-art"><div role="button" tabIndex={0} className="inspiration-open" aria-label={`Inspect ${design.brand}: ${design.description}`} onClick={() => setSelected(design)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(design); } }}><Artwork design={design} /></div>
                <button type="button" className="inspiration-heart" aria-label={`${choice.ensemble ? "Unlike" : "Like"} ${design.brand} overall look: ${design.slug}`} aria-pressed={choice.ensemble} aria-describedby={catalogPending ? `${availabilityId}-${design.id}` : undefined} title={catalogPending ? "Browse this reference now. Saving becomes available after the catalog update." : undefined} disabled={!controller.canSave || pending || !available} onClick={() => void controller.save(design.id, { ...choice, ensemble: !choice.ensemble })}><Heart liked={choice.ensemble} /></button>
              </div><button className="inspiration-caption" type="button" onClick={() => setSelected(design)}><strong>{design.brand}</strong><span>{design.creator}</span></button>
              {catalogPending && <p id={`${availabilityId}-${design.id}`} className="inspiration-element-label inspiration-availability">Browse only · catalog update pending</p>}
              {choice.elements.length > 0 && <p className="inspiration-element-label">{choice.elements.map(element => inspirationLabels[element]).join(", ")} liked</p>}
              {busy ? <p className="inspiration-saving" role="status">Saving…</p> : pending && <button className="inspiration-pending" type="button" onClick={() => setSelected(design)}>Review unsaved choices</button>}
            </article>;
          })}
        </InspirationGrid> : <div className="inspiration-empty"><Icon name="assets" size={30} /><h2>{liked && !query && kind === "all" ? "Start with a few likes" : "No designs match these filters"}</h2><p>{liked && !query && kind === "all" ? "Like an overall look or open a design to choose its details." : "Try a brand, studio, color, or design detail."}</p><button type="button" onClick={() => { setQuery(""); setKind("all"); setLiked(false); }}>Browse all designs</button></div>}
        <footer className="inspiration-footer"><span>{visible.length} of {liked ? inspirationCatalog.length : designs.length} curated designs</span><Link href={`/brands/account/${projectId}/identity`}>Saved references &amp; systems</Link><Link href={`/brands/account/${projectId}/logo/directions`}>Visual directions</Link></footer>
      </div>
      <div className="inspiration-continue-row"><span>{count === 1 ? "1 liked" : `${count} liked`} · Next: Logo</span><Link className="inspiration-continue" href={`/brands/account/${projectId}/logo`}>Continue<Icon name="arrow" size={16} /></Link></div>
    </section>
    {selected && <DesignDetail key={selected.id} design={selected} choice={displayed.get(selected.id) ?? noChoice} controller={controller} onClose={() => setSelected(null)} />}
  </div>;
}
