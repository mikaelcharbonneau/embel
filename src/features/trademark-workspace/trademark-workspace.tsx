"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { TrademarkArtwork } from "@/components/ui/trademark-artwork";
import { BrowserNameDialog } from "@/components/naming/browser-name-picker";
import { assessTrademarkDossier, buildTrademarkDraftPreview, confirmTrademarkReview, trademarkBrandSeed, trademarkDependencies, validateTrademarkDraft, type TrademarkBrandSeed, type TrademarkDraft, type TrademarkDraftPreview } from "./domain";
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
  return <div className="tm-field"><label htmlFor={id}>{label}</label>{multiline ? <textarea {...props} rows={rows} /> : <input {...props} />}{hint && <p id={`${id}-hint`} className="tm-hint">{hint}</p>}</div>;
}

export function TrademarkWorkspace({ draft, onChange, onExportPreview, onCreateBrand, storageNotice = "Draft held in this tab only. Reloading may discard it; account saving is not connected.", exportState = { status: "idle" }, draftControls, liveResearch, saveControl, disabled = false, savedDraft }: TrademarkWorkspaceProps) {
  const [view, setView] = useState<"dossier" | "research" | "preview" | "library" | "history">("research");
  const [attempted, setAttempted] = useState(false);
  const [similar, setSimilar] = useState(true);
  const tabs = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const id = useId();
  const parsed = validateTrademarkDraft(draft);
  if (!parsed.success) return <section className="page tm-workspace"><h1>Trademarks</h1><p role="alert">This draft cannot be displayed. Its format or size is invalid. Your host copy has not been changed.</p></section>;
  const completeness = assessTrademarkDossier(draft);
  const preview = buildTrademarkDraftPreview(draft);
  function change(patch: Partial<TrademarkDraft>) {
    if (disabled) return;
    setError("");
    setAttempted(false);
    const next = { ...draft, ...patch, reviewedContent: null };
    const result = validateTrademarkDraft(next);
    if (!result.success) {
      setError("This change exceeds the draft limits or contains control characters. Territories allow up to 20 lines, each at most 160 characters. The previous input has been kept.");
      return;
    }
    onChange(next);
  }
  function invoke(action: () => void) {
    setError("");
    try { action(); } catch { setError("The action could not be completed. Your draft remains available; try again or keep editing."); }
  }

  const heading = view === "dossier" ? "Prepare your trademark draft" : view === "library" ? "Your current preparation draft" : view === "history" ? "Your latest saved revision" : view === "preview" ? "Review your preparation draft" : "Research your name";
  const description = view === "dossier" ? "Collect the name, territory and owner details in one preparation draft." : view === "research" ? "Prepare manual research criteria, then review the coverage of each registry source." : view === "library" ? "One working draft is supported. Saved revisions belong to this draft." : view === "history" ? "Only the latest account save receipt is available here." : "Review your user-entered details. Filing requirements remain unvalidated.";
  const date = savedDraft ? new Date(savedDraft.updatedAt).toLocaleString("en", { timeZone: "UTC" }) : null;
  return <div className="page tm-workspace" data-view={view}>
    <header className="tm-heading"><h1>{heading}<span aria-hidden="true">.</span></h1><p>{description}</p></header>
    <div className="tm-navigation" role="tablist" aria-label="Trademark views" ref={tabs} onKeyDown={event => {
      const buttons = Array.from(tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      if (index < 0 || !["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.click(); buttons[next]?.focus();
    }}>{([['research', 'Research'], ['dossier', 'Prepare'], ['library', 'Current draft'], ['history', 'Latest revision']] as const).map(([key, label]) => <button key={key} id={`${id}-${key}-tab`} type="button" role="tab" aria-selected={view === key || (view === "preview" && key === "dossier")} aria-controls={`${id}-panel`} tabIndex={view === key || (view === "preview" && key === "dossier") ? 0 : -1} className={view === key || (view === "preview" && key === "dossier") ? "is-active" : ""} onClick={() => { setView(key); setError(""); }}>{label}</button>)}</div>
    {error && <p role="alert" className="tm-error">{error}</p>}
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${view === "preview" ? "dossier" : view}-tab`}>
    {view === "research" && <>
      <form className="tm-search-form" onSubmit={event => { event.preventDefault(); if (!disabled) { if (!draft.markName.trim()) { setError("Enter a name to prepare your manual search."); return; } setError(""); setAttempted(true); } }}>
        <fieldset disabled={disabled}>
          <div className="tm-name-field"><Field label="Name to search" accessibleLabel="Mark name" value={draft.markName} onChange={markName => change({ markName })} maxLength={160} placeholder="Enter a name" />
          <div className="tm-name-library"><BrowserNameDialog disabled={disabled} replacing={Boolean(draft.markName.trim())} onUse={markName => change({ markName })} /></div></div>
          <div className="tm-search-scope">
            <Field label="Territory" accessibleLabel="Requested territories" value={draft.territories.join("\n")} onChange={value => change({ territories: value === "" ? [] : value.split("\n") })} maxLength={3200} multiline rows={1} placeholder="Requested territory" />
            <Field label="Goods or services" accessibleLabel="Goods and services" value={draft.goodsServices} onChange={goodsServices => change({ goodsServices })} maxLength={6000} multiline rows={1} placeholder="Describe your goods or services" />
          </div>
          <div className="tm-search-actions"><label><input type="checkbox" checked={similar} onChange={event => { setSimilar(event.target.checked); setAttempted(false); }} />Include similar names</label><button className="button primary" type="submit" aria-describedby={`${id}-manual-scope`}>Prepare manual search</button></div>
          <p className="tm-coverage" id={`${id}-manual-scope`}>Manual research criteria only. This action does not query a registry. Requested territories: {draft.territories.filter(value => value.trim()).join(", ") || "not provided"}.</p>
        </fieldset>
      </form>
      <section className="tm-results" aria-labelledby={`${id}-results`}>
        <div className="tm-results-heading"><h2 id={`${id}-results`}>{attempted ? "Manual search brief" : "Manual research"}</h2><p role="status">{attempted ? "Ready for manual research" : "Criteria not prepared yet"}</p></div>
        {attempted ? <div className="tm-manual-research">
          <h3>Search the official registries</h3><dl><div><dt>Name</dt><dd>{draft.markName}</dd></div><div><dt>Territories</dt><dd>{draft.territories.filter(value => value.trim()).join(", ") || "Choose territories in the registry"}</dd></div><div><dt>Goods and services</dt><dd>{draft.goodsServices || "Add goods and services to narrow your research"}</dd></div><div><dt>Search scope</dt><dd>{similar ? "Exact name and similar spellings or sounds" : "Exact name"}</dd></div></dl>
          <div className="tm-actions"><a className="button secondary small" href="https://branddb.wipo.int/en/" target="_blank" rel="noopener noreferrer">Open WIPO Global Brand Database</a><a className="button secondary small" href="https://www.uspto.gov/trademarks/search" target="_blank" rel="noopener noreferrer">Open US trademark search</a><a className="button secondary small" href="https://ised-isde.canada.ca/cipo/trademark-search/srch?lang=eng" target="_blank" rel="noopener noreferrer">Open Canadian trademark search</a><a className="button secondary small" href="https://euipo.europa.eu/eSearch/" target="_blank" rel="noopener noreferrer">Open EU trademark search</a></div>
          <p>Enter these criteria in the registry and check its territorial coverage. Preparing this brief does not search a registry or assess clearance.</p>
          <button type="button" className="text-link" onClick={() => setView("dossier")}>Record research notes</button>
        </div> : <div className="tm-empty"><span className="tm-search-symbol"><TrademarkArtwork name="search" /></span><h3>Prepare a trademark search</h3><p>Collect your criteria, then search official registries and record your findings. {liveResearch ? "See the available research sources below." : "Automatic registry research is not connected."}</p></div>}
        {liveResearch && <section className="tm-registry-evidence" aria-label="Registry evidence"><p className="tm-hint">Registry sources have their own territorial and search coverage. Results remain separate from your user-entered preparation draft.</p>{liveResearch}</section>}
        <details className="tm-research-details"><summary>Research coverage and your notes</summary><h3>Dossier evidence</h3><p>Live research is separate from this user-entered draft. No registry results or legal conclusions are saved with it.</p><dl>{trademarkDependencies.map(dependency => <div key={dependency.id}><dt>{dependency.label}<span className="small-badge">Unavailable</span></dt><dd>{dependency.detail}</dd></div>)}</dl><h3>Your research notes</h3><p className="tm-hint">User-entered, unsourced</p><p className="tm-user-text">{draft.userNotes.trim() || "No user notes yet."}</p><button className="button secondary" type="button" onClick={() => setView("dossier")}>Edit dossier</button></details>
      </section>
    </>}
    {view === "dossier" && <div className="tm-layout">
      <fieldset className="tm-editor" disabled={disabled}>
        <section className="tm-section" aria-labelledby={`${id}-mark`}><h2 id={`${id}-mark`}>Name and offering</h2>
          <Field label="Name being prepared" accessibleLabel="Mark name" value={draft.markName} onChange={markName => change({ markName })} maxLength={160} placeholder="Enter a name" />
          <Field label="Territory" accessibleLabel="Requested territories" value={draft.territories.join("\n")} onChange={value => change({ territories: value === "" ? [] : value.split("\n") })} maxLength={3200} multiline rows={1} placeholder="Requested territories, one per line" />
          <Field label="Goods or services" accessibleLabel="Goods and services" value={draft.goodsServices} onChange={goodsServices => change({ goodsServices })} maxLength={6000} multiline rows={1} placeholder="Describe what the mark will cover" />
        </section>
        <section className="tm-section" aria-labelledby={`${id}-owner`}><h2 id={`${id}-owner`}>Owner details</h2>
          <Field label="Owner name" value={draft.owner.name} onChange={name => change({ owner: { ...draft.owner, name } })} maxLength={300} placeholder="Enter a person or business name" />
          <Field label="Owner address" value={draft.owner.address} onChange={address => change({ owner: { ...draft.owner, address } })} maxLength={2000} multiline rows={1} placeholder="Street address, city, postal code" />
        </section>
        <details className="tm-section tm-additional"><summary>Additional dossier details</summary>
          <div className="tm-field"><label htmlFor={`${id}-type`}>Mark type</label><select id={`${id}-type`} value={draft.markType} onChange={event => change({ markType: event.target.value as TrademarkDraft["markType"] })}><option value="">Choose a type</option><option value="word">Word</option><option value="logo">Logo</option><option value="combined">Word and logo</option></select></div>
          <Field label="Representation notes" value={draft.representationNotes} onChange={representationNotes => change({ representationNotes })} hint="Describe the planned logo or combined representation. No file is attached or verified here." maxLength={2000} multiline />
          <Field label="Owner contact" value={draft.owner.contact} onChange={contact => change({ owner: { ...draft.owner, contact } })} hint="Contact details for your notes. No message will be sent." maxLength={300} />
          <Field label="Classification notes" value={draft.classificationNotes} onChange={classificationNotes => change({ classificationNotes })} hint="Proposed classes or questions only. No class assignment is verified." maxLength={2000} multiline />
          <div className="tm-field"><label htmlFor={`${id}-plan`}>Supporting document plan</label><select id={`${id}-plan`} value={draft.documents.plan} onChange={event => change({ documents: { ...draft.documents, plan: event.target.value as TrademarkDraft["documents"]["plan"] } })}><option value="unknown">Not considered yet</option><option value="listed">Documents planned</option><option value="none-planned">No documents planned</option></select></div>
          <Field label="Document notes" value={draft.documents.notes} onChange={notes => change({ documents: { ...draft.documents, notes } })} hint="List planned documents. Files are not uploaded; territorial requirements are unknown." maxLength={4000} multiline />
          <Field label="Your research notes" value={draft.userNotes} onChange={userNotes => change({ userNotes })} hint="User-entered, unsourced notes. These do not constitute a registry search." maxLength={4000} multiline />
        </details>
      </fieldset>
      <aside className="tm-checklist" aria-labelledby={`${id}-checklist`}><h2 id={`${id}-checklist`}>Preparation draft</h2><h3>{draft.markName.trim() || "Unnamed draft"}</h3><p>{draft.territories.filter(value => value.trim()).join(" · ") || "Territory not provided"} · {draft.markType === "word" ? "Word mark" : draft.markType === "logo" ? "Logo" : draft.markType === "combined" ? "Combined mark" : "Mark type not provided"}</p><p>{completeness.completed} of {completeness.total} sections filled</p><ul>{completeness.sections.map(section => <li key={section.id}><TrademarkArtwork name={section.complete ? "check" : "pending"} /><span>{section.label} · {section.complete ? "Filled" : "Missing"}</span></li>)}</ul>
        {saveControl || <p className="tm-hint">{storageNotice}</p>}
        <button className="button secondary" type="button" onClick={() => setView("preview")}>Review draft preview</button>
        {onCreateBrand && <button className="button secondary" type="button" disabled={disabled || !draft.markName.trim()} onClick={() => invoke(() => onCreateBrand(trademarkBrandSeed(draft)))}>Create brand from draft</button>}
        <p className="tm-hint">This checks draft input only. Filing requirements and legal clearance remain unvalidated.</p>
      </aside>
    </div>}
    {view === "library" && <section className="tm-section tm-library"><h2>Current draft</h2><p>One working draft is supported. This is not a catalogue of filed or registered marks.</p>{draft.markName.trim() ? <><h3>{draft.markName}</h3><p>{savedDraft ? `Account revision ${savedDraft.revision}${savedDraft.dirty ? " · unsaved changes" : " · saved"}` : "Unsaved draft in this tab"}</p><button className="button secondary" type="button" onClick={() => setView("dossier")}>Edit dossier</button><button className="button secondary" type="button" onClick={() => setView("preview")}>Review draft preview</button>{onCreateBrand && <button className="button secondary" type="button" disabled={disabled} onClick={() => invoke(() => onCreateBrand(trademarkBrandSeed(draft)))}>Create brand from draft</button>}</> : <><p>No named draft yet.</p><button className="button secondary" type="button" onClick={() => setView("dossier")}>Prepare a draft</button></>}</section>}
    {view === "history" && <section className="tm-section tm-history"><h2>Latest saved revision</h2>{savedDraft ? <><p>Account revision {savedDraft.revision} · {date} UTC</p><p>{savedDraft.dirty ? "The current edits are not included in this saved revision." : "The current draft matches this saved revision."}</p></> : <p>No account save receipt is available for this draft.</p>}<p>Earlier revisions and registry search history are not available. No filing or registration has been recorded.</p></section>}
    {view === "preview" && <section className="tm-preview" aria-labelledby={`${id}-preview`}><div className="tm-preview-heading"><h2 id={`${id}-preview`}>{preview.label}</h2><span className="small-badge">{completeness.stage === "reviewed-draft" ? "Reviewed draft" : completeness.intakeComplete ? "Intake filled" : "Incomplete draft"}</span></div>
      <p className="tm-hint">All entries below are user-entered. No application has been filed or registered.</p>
      <dl>{[["Mark", draft.markName], ["Mark type", draft.markType], ["Representation notes", draft.representationNotes], ["Requested territories", draft.territories.join("\n")], ["Goods and services", draft.goodsServices], ["Classification notes", draft.classificationNotes], ["Owner name", draft.owner.name], ["Owner address", draft.owner.address], ["Owner contact", draft.owner.contact], ["Document plan", draft.documents.plan === "none-planned" ? "No documents planned; requirements unvalidated" : draft.documents.plan === "listed" ? "Documents planned; no files attached" : "Not considered"], ["Document notes", draft.documents.notes], ["Your research notes", draft.userNotes]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value?.trim() || "Not provided"}</dd></div>)}</dl>
      {!completeness.intakeComplete && <div className="tm-missing"><h3>Missing intake sections</h3><ul>{completeness.sections.filter((section) => !section.complete).map((section) => <li key={section.id}>{section.label}</li>)}</ul></div>}
      <div className="tm-limitations"><h3>Still needed</h3><ul>{trademarkDependencies.map((dependency) => <li key={dependency.id}>{dependency.detail}</li>)}</ul><p>Completeness does not establish legal clearance, registrability or readiness to file.</p></div>
      <label className="tm-review"><input disabled={disabled} type="checkbox" checked={completeness.reviewCurrent} onChange={(event) => { setError(""); onChange(event.target.checked ? confirmTrademarkReview(draft) : { ...draft, reviewedContent: null }); }} /><span>I reviewed these user-entered notes. I understand this is a draft preview with unvalidated filing requirements.</span></label>
      <div className="tm-actions"><button className="button secondary" type="button" onClick={() => setView("dossier")}>Edit dossier</button><button className="button primary" type="button" disabled={disabled || !onExportPreview || exportState.status === "pending"} onClick={() => invoke(() => onExportPreview?.(preview))}>{exportState.status === "pending" ? "Exporting draft preview…" : "Export draft preview"}</button></div>
      {!onExportPreview && <p className="tm-hint">Export is not connected. You can review the draft here.</p>}
      {exportState.status === "failed" && <p className="tm-error" role="alert">{exportState.error || "Export failed. Your draft remains available."}</p>}
    </section>}
    </div>
    <footer className="tm-draft-controls">{view !== "dossier" && saveControl}<p className="tm-storage">{storageNotice}</p>{draftControls}</footer>
  </div>;
}
