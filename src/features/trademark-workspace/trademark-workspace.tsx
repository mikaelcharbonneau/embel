"use client";
import { ContextDetails } from "@/components/ui/context-details";

import { useId, useRef, useState, type ReactNode } from "react";
import { TrademarkArtwork } from "@/components/ui/trademark-artwork";
import { BrowserNameDialog } from "@/components/naming/browser-name-picker";
import { assessTrademarkDossier, buildTrademarkDraftPreview, confirmTrademarkReview, trademarkBrandSeed, validateTrademarkDraft, type TrademarkBrandSeed, type TrademarkDraft, type TrademarkDraftPreview } from "./domain";
import "@/components/tools/tool-page.css";
import "./trademark-workspace.css";

export type TrademarkWorkspaceProps = {
  draft: TrademarkDraft;
  draftControls?: ReactNode;
  liveResearch?: ReactNode;
  saveControl?: ReactNode;
  disabled?: boolean;
  savedDraft?: { revision: number; updatedAt: string; dirty: boolean };
  onChange: (draft: TrademarkDraft) => void;
  onExportPreview?: (preview: TrademarkDraftPreview) => void;
  onCreateBrand?: (seed: TrademarkBrandSeed) => void;
  /** The host owns persistence and must describe it truthfully. Default is tab-only. */
  storageNotice?: string;
  exportState?: { status: "idle" | "pending" | "failed"; error?: string };
};

function Field({ label, value, onChange, hint, maxLength, multiline = false, rows = 3, placeholder, accessibleLabel }: { label: string; value: string; onChange: (value: string) => void; hint?: string; maxLength: number; multiline?: boolean; rows?: number; placeholder?: string; accessibleLabel?: string }) {
  const id = useId();
  const props = { id, value, maxLength, placeholder, "aria-label": accessibleLabel, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value), "aria-describedby": hint ? `${id}-hint` : undefined };
  return <div className="tm-field"><label htmlFor={id}>{label}</label>{multiline ? <textarea {...props} rows={rows} className={rows === 1 ? "tm-single-line" : undefined} /> : <input {...props} />}{hint && <p id={`${id}-hint`} className="tm-hint">{hint}</p>}</div>;
}

export function TrademarkWorkspace({ draft, onChange, onExportPreview, onCreateBrand, storageNotice = "This draft stays on this page only. Reloading clears it.", exportState = { status: "idle" }, draftControls, liveResearch, saveControl, disabled = false, savedDraft }: TrademarkWorkspaceProps) {
  const [view, setView] = useState<"dossier" | "research" | "preview" | "library" | "history">("research");
  const [attempted, setAttempted] = useState(false);
  const [similar, setSimilar] = useState(true);
  const tabs = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const id = useId();
  const parsed = validateTrademarkDraft(draft);
  if (!parsed.success) return <section className="page tool-page tm-workspace"><header className="tool-heading tm-heading"><div className="tool-heading-text"><h1>Trademarks</h1></div></header><p role="alert">This draft can’t be shown because it’s damaged or too large. Your saved copy hasn’t been changed.</p></section>;
  const completeness = assessTrademarkDossier(draft);
  const preview = buildTrademarkDraftPreview(draft);
  function change(patch: Partial<TrademarkDraft>) {
    if (disabled) return;
    setError("");
    setAttempted(false);
    const next = { ...draft, ...patch, reviewedContent: null };
    const result = validateTrademarkDraft(next);
    if (!result.success) {
      setError("That change is too long or has characters that can’t be saved. Use up to 20 territories of 160 characters each. Your previous text is kept.");
      return;
    }
    onChange(next);
  }
  function invoke(action: () => void) {
    setError("");
    try { action(); } catch { setError("The action could not be completed. Your draft remains available; try again or keep editing."); }
  }

  const heading = view === "dossier" ? "Trademark details" : view === "library" ? "Your trademark draft" : view === "history" ? "Save history" : view === "preview" ? "Review your draft" : "Search for your name";
  const description = view === "dossier" ? "Keep the name, where you’ll use it and who owns it in one place." : view === "research" ? liveResearch ? "Prepare a trademark search. Embel lists what to look up and where, and can check exact names in the EU register." : "Prepare a trademark search. Embel lists what to look up and where; it doesn’t search registries for you." : view === "library" ? "A summary of your trademark notes." : view === "history" ? "When this draft was last saved." : "Check what you’ve entered. Embel doesn’t check filing requirements.";
  const tabLabels = [["research", "Search"], ["dossier", "Details"], ["library", "Summary"], ["history", "Save history"]] as const;
  const date = savedDraft ? new Date(savedDraft.updatedAt).toLocaleString("en", { timeZone: "UTC" }) : null;
  return <div className="page tool-page tm-workspace" data-view={view}>
    <header className="tool-heading tm-heading"><div className="tool-heading-text"><h1>{heading}<span aria-hidden="true">.</span></h1><p>{description}</p></div></header>
    <div className="tool-tabs tm-navigation" role="tablist" aria-label="Trademark views" ref={tabs} onKeyDown={event => {
      const buttons = Array.from(tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      if (index < 0 || !["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.click(); buttons[next]?.focus();
    }}>{tabLabels.map(([key, label]) => <button key={key} id={`${id}-${key}-tab`} data-label={label} type="button" role="tab" aria-selected={view === key || (view === "preview" && key === "dossier")} aria-controls={`${id}-panel`} tabIndex={view === key || (view === "preview" && key === "dossier") ? 0 : -1} className={view === key || (view === "preview" && key === "dossier") ? "is-active" : ""} onClick={() => { setView(key); setError(""); }}>{label}</button>)}</div>
    {error && <p role="alert" className="tm-error">{error}</p>}
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${view === "preview" ? "dossier" : view}-tab`}>
    {view === "research" && <>
      <form className="tm-search-form" onSubmit={event => { event.preventDefault(); if (!disabled) { if (!draft.markName.trim()) { setError("Enter a name to prepare your search."); return; } setError(""); setAttempted(true); } }}>
        <fieldset disabled={disabled}>
          <div className="tm-name-field"><Field label="Name to search" accessibleLabel="Mark name" value={draft.markName} onChange={markName => change({ markName })} maxLength={160} placeholder="Enter a name" />
          <div className="tm-name-library"><BrowserNameDialog disabled={disabled} replacing={Boolean(draft.markName.trim())} onUse={markName => change({ markName })} /></div></div>
          <div className="tm-search-scope">
            <Field label="Territory" accessibleLabel="Requested territories" value={draft.territories.join("\n")} onChange={value => change({ territories: value === "" ? [] : value.split("\n") })} maxLength={3200} multiline rows={1} placeholder="For example, Canada" />
            <Field label="Goods or services" accessibleLabel="Goods and services" value={draft.goodsServices} onChange={goodsServices => change({ goodsServices })} maxLength={6000} multiline rows={1} placeholder="Describe your goods or services" />
          </div>
          <div className="tm-search-actions"><label><input type="checkbox" checked={similar} onChange={event => { setSimilar(event.target.checked); setAttempted(false); }} />Include similar names</label><button className="button primary" type="submit">Prepare search</button></div>
        </fieldset>
      </form>
      <section className="tm-results" aria-labelledby={`${id}-results`}>
        <div className="tm-results-heading"><h2 id={`${id}-results`}>Search brief</h2><p role="status">{attempted ? "Ready to search" : "Not prepared yet"}</p></div>
        {attempted ? <div className="tm-manual-research">
          <h3>Search the official registries</h3><dl><div><dt>Name</dt><dd>{draft.markName}</dd></div><div><dt>Territories</dt><dd>{draft.territories.filter(value => value.trim()).join(", ") || "Choose territories in the registry"}</dd></div><div><dt>Goods and services</dt><dd>{draft.goodsServices || "Add goods and services to narrow your search"}</dd></div><div><dt>Search scope</dt><dd>{similar ? "Exact name and similar spellings or sounds" : "Exact name"}</dd></div></dl>
          <div className="tm-actions"><a className="button secondary small" href="https://branddb.wipo.int/en/" target="_blank" rel="noopener noreferrer">Open WIPO Global Brand Database</a><a className="button secondary small" href="https://www.uspto.gov/trademarks/search" target="_blank" rel="noopener noreferrer">Open US trademark search</a><a className="button secondary small" href="https://ised-isde.canada.ca/cipo/trademark-search/srch?lang=eng" target="_blank" rel="noopener noreferrer">Open Canadian trademark search</a><a className="button secondary small" href="https://euipo.europa.eu/eSearch/" target="_blank" rel="noopener noreferrer">Open EU trademark search</a></div>
          <p>Enter these details in each registry’s search. Each registry covers its own countries.</p>
          <button type="button" className="text-link" onClick={() => setView("dossier")}>Record research notes</button>
        </div> : <div className="tm-empty"><span className="tm-search-symbol"><TrademarkArtwork name="search" /></span><h3>Prepare a trademark search</h3><p>Add a name and where you’ll use it. Embel lists the official registries to search.</p></div>}
        {liveResearch && <section className="tm-registry-evidence" aria-label="Registry evidence"><p className="tm-hint">EU register results show here. They aren’t saved with your draft.</p>{liveResearch}</section>}
        <ContextDetails className="tm-research-details" title={<>Your research notes</>}><p className="tm-user-text">{draft.userNotes.trim() || "No notes yet."}</p><button className="button secondary" type="button" onClick={() => setView("dossier")}>Edit notes</button></ContextDetails>
      </section>
    </>}
    {view === "dossier" && <div className="tm-layout">
      <fieldset className="tm-editor" disabled={disabled}>
        <section className="tm-section" aria-labelledby={`${id}-mark`}><h2 id={`${id}-mark`}>Name and offering</h2>
          <Field label="Name" accessibleLabel="Mark name" value={draft.markName} onChange={markName => change({ markName })} maxLength={160} placeholder="Enter a name" />
          <Field label="Territory" accessibleLabel="Requested territories" value={draft.territories.join("\n")} onChange={value => change({ territories: value === "" ? [] : value.split("\n") })} maxLength={3200} multiline rows={1} placeholder="Where you’ll use it, one per line" />
          <Field label="Goods or services" accessibleLabel="Goods and services" value={draft.goodsServices} onChange={goodsServices => change({ goodsServices })} maxLength={6000} multiline rows={1} placeholder="Describe what the mark will cover" />
        </section>
        <section className="tm-section" aria-labelledby={`${id}-owner`}><h2 id={`${id}-owner`}>Owner details</h2>
          <Field label="Owner name" value={draft.owner.name} onChange={name => change({ owner: { ...draft.owner, name } })} maxLength={300} placeholder="Enter a person or business name" />
          <Field label="Owner address" value={draft.owner.address} onChange={address => change({ owner: { ...draft.owner, address } })} maxLength={2000} multiline rows={1} placeholder="Street address, city, postal code" />
        </section>
        <ContextDetails className="tm-section tm-additional" title={<>More details</>}><div className="tm-field"><label htmlFor={`${id}-type`}>Mark type</label><select id={`${id}-type`} value={draft.markType} onChange={event => change({ markType: event.target.value as TrademarkDraft["markType"] })}><option value="">Choose a type</option><option value="word">Word</option><option value="logo">Logo</option><option value="combined">Word and logo</option></select></div><Field label="Representation notes" value={draft.representationNotes} onChange={representationNotes => change({ representationNotes })} hint="Describe the logo you plan to use." maxLength={2000} multiline /><Field label="Owner contact" value={draft.owner.contact} onChange={contact => change({ owner: { ...draft.owner, contact } })} hint="For your notes only." maxLength={300} /><Field label="Classification notes" value={draft.classificationNotes} onChange={classificationNotes => change({ classificationNotes })} hint="Classes you plan to use, or questions about them." maxLength={2000} multiline /><div className="tm-field"><label htmlFor={`${id}-plan`}>Supporting document plan</label><select id={`${id}-plan`} value={draft.documents.plan} onChange={event => change({ documents: { ...draft.documents, plan: event.target.value as TrademarkDraft["documents"]["plan"] } })}><option value="unknown">Not considered yet</option><option value="listed">Documents planned</option><option value="none-planned">No documents planned</option></select></div><Field label="Document notes" value={draft.documents.notes} onChange={notes => change({ documents: { ...draft.documents, notes } })} hint="Documents you plan to include." maxLength={4000} multiline /><Field label="Your research notes" value={draft.userNotes} onChange={userNotes => change({ userNotes })} hint="Notes from your own registry searches." maxLength={4000} multiline /></ContextDetails>
      </fieldset>
      <aside className="tm-checklist" aria-labelledby={`${id}-checklist`}><h2 id={`${id}-checklist`}>Your draft</h2><h3>{draft.markName.trim() || "Unnamed draft"}</h3><p>{draft.territories.filter(value => value.trim()).join(" · ") || "Territory not provided"} · {draft.markType === "word" ? "Word mark" : draft.markType === "logo" ? "Logo" : draft.markType === "combined" ? "Combined mark" : "Mark type not provided"}</p><p>{completeness.completed} of {completeness.total} sections filled</p><ul>{completeness.sections.map(section => <li key={section.id}><TrademarkArtwork name={section.complete ? "check" : "pending"} /><span>{section.label} · {section.complete ? "Filled" : "Missing"}</span></li>)}</ul>
        {saveControl || <p className="tm-hint">{storageNotice}</p>}
        <button className="button secondary" type="button" onClick={() => setView("preview")}>Review draft</button>
        {onCreateBrand && <button className="button secondary" type="button" disabled={disabled || !draft.markName.trim()} onClick={() => invoke(() => onCreateBrand(trademarkBrandSeed(draft)))}>Create brand from draft</button>}
        <p className="tm-hint">This only checks that each section is filled in.</p>
      </aside>
    </div>}
    {view === "library" && <section className="tm-section tm-library"><h2>Summary</h2><p>Your trademark notes live in one draft. Nothing here has been filed.</p>{draft.markName.trim() ? <><h3>{draft.markName}</h3><p>{savedDraft ? `Version ${savedDraft.revision} · ${savedDraft.dirty ? "unsaved changes" : "saved"}` : "Not saved yet"}</p><button className="button secondary" type="button" onClick={() => setView("dossier")}>Edit details</button><button className="button secondary" type="button" onClick={() => setView("preview")}>Review draft</button>{onCreateBrand && <button className="button secondary" type="button" disabled={disabled} onClick={() => invoke(() => onCreateBrand(trademarkBrandSeed(draft)))}>Create brand from draft</button>}</> : <><p>Add a name to start your draft.</p><button className="button secondary" type="button" onClick={() => setView("dossier")}>Add details</button></>}</section>}
    {view === "history" && <section className="tm-section tm-history"><h2>Last save</h2>{savedDraft ? <><p>Version {savedDraft.revision} · saved {date} UTC</p><p>{savedDraft.dirty ? "Your latest edits aren’t saved yet." : "Everything is saved."}</p></> : <p>This draft hasn’t been saved yet.</p>}<p>Only the last save is shown.</p></section>}
    {view === "preview" && <section className="tm-preview" aria-labelledby={`${id}-preview`}><div className="tm-preview-heading"><h2 id={`${id}-preview`}>{preview.label}</h2><span className="small-badge">{completeness.stage === "reviewed-draft" ? "Reviewed draft" : completeness.intakeComplete ? "Intake filled" : "Incomplete draft"}</span></div>
      <p className="tm-hint">Everything below is what you entered. Nothing has been filed.</p>
      <dl>{[["Mark", draft.markName], ["Mark type", draft.markType], ["Representation notes", draft.representationNotes], ["Requested territories", draft.territories.join("\n")], ["Goods and services", draft.goodsServices], ["Classification notes", draft.classificationNotes], ["Owner name", draft.owner.name], ["Owner address", draft.owner.address], ["Owner contact", draft.owner.contact], ["Document plan", draft.documents.plan === "none-planned" ? "No documents planned" : draft.documents.plan === "listed" ? "Documents planned" : "Not considered"], ["Document notes", draft.documents.notes], ["Your research notes", draft.userNotes]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value?.trim() || "Not provided"}</dd></div>)}</dl>
      {!completeness.intakeComplete && <div className="tm-missing"><h3>Still to fill in</h3><ul>{completeness.sections.filter((section) => !section.complete).map((section) => <li key={section.id}>{section.label}</li>)}</ul></div>}
      <div className="tm-limitations"><p>Embel doesn’t check filing rules or legal clearance. A complete draft doesn’t mean the name can be registered.</p></div>
      <label className="tm-review"><input disabled={disabled} type="checkbox" checked={completeness.reviewCurrent} onChange={(event) => { setError(""); onChange(event.target.checked ? confirmTrademarkReview(draft) : { ...draft, reviewedContent: null }); }} /><span>I’ve reviewed these notes and understand Embel hasn’t checked filing requirements.</span></label>
      <div className="tm-actions"><button className="button secondary" type="button" onClick={() => setView("dossier")}>Edit details</button><button className="button primary" type="button" disabled={disabled || !onExportPreview || exportState.status === "pending"} onClick={() => invoke(() => onExportPreview?.(preview))}>{exportState.status === "pending" ? "Exporting draft preview…" : "Export draft preview"}</button></div>
      {!onExportPreview && <p className="tm-hint">Export isn’t available here. You can review the draft on this page.</p>}
      {exportState.status === "failed" && <p className="tm-error" role="alert">{exportState.error || "Export failed. Your draft remains available."}</p>}
    </section>}
    </div>
    <footer className="tm-draft-controls">{view !== "dossier" && saveControl}<p className="tm-storage">{storageNotice}</p>{draftControls}</footer>
  </div>;
}
