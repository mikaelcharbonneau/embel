"use client";

import { useId, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { assessTrademarkDossier, buildTrademarkDraftPreview, confirmTrademarkReview, trademarkBrandSeed, trademarkDependencies, validateTrademarkDraft, type TrademarkBrandSeed, type TrademarkDraft, type TrademarkDraftPreview } from "./domain";
import "./trademark-workspace.css";

export type TrademarkWorkspaceProps = {
  draft: TrademarkDraft;
  onChange: (draft: TrademarkDraft) => void;
  onExportPreview?: (preview: TrademarkDraftPreview) => void;
  onCreateBrand?: (seed: TrademarkBrandSeed) => void;
  /** The host owns persistence and must describe it truthfully. Default is tab-only. */
  storageNotice?: string;
  exportState?: { status: "idle" | "pending" | "failed"; error?: string };
};

function Field({ label, value, onChange, hint, maxLength, multiline = false }: { label: string; value: string; onChange: (value: string) => void; hint?: string; maxLength: number; multiline?: boolean }) {
  const id = useId();
  const props = { id, value, maxLength, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value), "aria-describedby": hint ? `${id}-hint` : undefined };
  return <div className="tm-field"><label htmlFor={id}>{label}</label>{multiline ? <textarea {...props} rows={3} /> : <input {...props} />}{hint && <p id={`${id}-hint`} className="tm-hint">{hint}</p>}</div>;
}

export function TrademarkWorkspace({ draft, onChange, onExportPreview, onCreateBrand, storageNotice = "Draft held in this tab only. Reloading may discard it; account saving is not connected.", exportState = { status: "idle" } }: TrademarkWorkspaceProps) {
  const [view, setView] = useState<"dossier" | "research" | "preview">("dossier");
  const [error, setError] = useState("");
  const id = useId();
  const parsed = validateTrademarkDraft(draft);
  if (!parsed.success) return <section className="page tm-workspace"><h1>Trademarks</h1><p role="alert">This draft cannot be displayed. Its format or size is invalid. Your host copy has not been changed.</p></section>;
  const completeness = assessTrademarkDossier(draft);
  const preview = buildTrademarkDraftPreview(draft);
  function change(patch: Partial<TrademarkDraft>) {
    setError("");
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

  return <div className="page tm-workspace">
    <div className="page-heading"><h1>Trademarks</h1><span className="small-badge">Draft preparation</span></div>
    <p className="tm-intro">Prepare your mark, territories and goods or services for review.</p>
    <div className="tm-notice"><Icon name="offline" size={18} /><div><strong>Research is not connected</strong><p>No registry has been searched. Territory coverage and filing requirements remain unvalidated.</p></div></div>
    <p className="tm-storage">{storageNotice}</p>
    <div className="tm-navigation" role="group" aria-label="Trademark views">{([['dossier', 'Dossier'], ['research', 'Research'], ['preview', 'Draft preview']] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={view === key} className={view === key ? "is-active" : ""} onClick={() => { setView(key); setError(""); }}>{label}</button>)}</div>
    {error && <p role="alert" className="tm-error">{error}</p>}
    {view === "dossier" && <div className="tm-layout">
      <div className="tm-editor">
        <section className="tm-section" aria-labelledby={`${id}-mark`}><h2 id={`${id}-mark`}>Mark</h2>
          <Field label="Mark name" value={draft.markName} onChange={(markName) => change({ markName })} maxLength={160} />
          <div className="tm-field"><label htmlFor={`${id}-type`}>Mark type</label><select id={`${id}-type`} value={draft.markType} onChange={(event) => change({ markType: event.target.value as TrademarkDraft["markType"] })}><option value="">Choose a type</option><option value="word">Word</option><option value="logo">Logo</option><option value="combined">Word and logo</option></select></div>
          <Field label="Representation notes" value={draft.representationNotes} onChange={(representationNotes) => change({ representationNotes })} hint="For a logo or combined mark, describe the representation you plan to provide. No file is attached or verified here." maxLength={2000} multiline />
        </section>
        <section className="tm-section" aria-labelledby={`${id}-territories`}><h2 id={`${id}-territories`}>Territories and offering</h2>
          <Field label="Requested territories" value={draft.territories.join("\n")} onChange={(value) => change({ territories: value === "" ? [] : value.split("\n") })} hint="One territory per line, up to 20. These are requests; supported coverage is not confirmed." maxLength={3200} multiline />
          <Field label="Goods and services" value={draft.goodsServices} onChange={(goodsServices) => change({ goodsServices })} hint="Describe what the mark will cover in your own words. This wording has not been reviewed for filing." maxLength={6000} multiline />
          <Field label="Classification notes" value={draft.classificationNotes} onChange={(classificationNotes) => change({ classificationNotes })} hint="Add proposed classes or questions for review. Fluid has not assigned or verified a class." maxLength={2000} multiline />
        </section>
        <section className="tm-section" aria-labelledby={`${id}-owner`}><h2 id={`${id}-owner`}>Proposed owner</h2>
          <Field label="Owner name" value={draft.owner.name} onChange={(name) => change({ owner: { ...draft.owner, name } })} maxLength={300} />
          <Field label="Owner address" value={draft.owner.address} onChange={(address) => change({ owner: { ...draft.owner, address } })} maxLength={2000} multiline />
          <Field label="Owner contact" value={draft.owner.contact} onChange={(contact) => change({ owner: { ...draft.owner, contact } })} hint="Contact details for your notes. No message will be sent." maxLength={300} />
        </section>
        <section className="tm-section" aria-labelledby={`${id}-documents`}><h2 id={`${id}-documents`}>Documents and notes</h2>
          <div className="tm-field"><label htmlFor={`${id}-plan`}>Supporting document plan</label><select id={`${id}-plan`} value={draft.documents.plan} onChange={(event) => change({ documents: { ...draft.documents, plan: event.target.value as TrademarkDraft["documents"]["plan"] } })}><option value="unknown">Not considered yet</option><option value="listed">Documents planned</option><option value="none-planned">No documents planned</option></select></div>
          <Field label="Document notes" value={draft.documents.notes} onChange={(notes) => change({ documents: { ...draft.documents, notes } })} hint="List documents you plan to gather. Files are not uploaded; territorial document requirements are unknown." maxLength={4000} multiline />
          <Field label="Your research notes" value={draft.userNotes} onChange={(userNotes) => change({ userNotes })} hint="User-entered notes only. They are separate from sourced results and do not constitute a registry search." maxLength={4000} multiline />
        </section>
      </div>
      <aside className="tm-checklist" aria-labelledby={`${id}-checklist`}><h2 id={`${id}-checklist`}>Dossier intake</h2><p>{completeness.completed} of {completeness.total} sections filled</p><ul>{completeness.sections.map((section) => <li key={section.id}><span className={section.complete ? "tm-filled" : ""}>{section.complete ? "Filled" : "Missing"}</span><strong>{section.label}</strong>{!section.complete && <p>{section.guidance}</p>}</li>)}</ul><p className="tm-hint">This checklist checks your draft input. It does not validate a legal filing dossier.</p><button className="button primary" type="button" onClick={() => setView("preview")}>Review draft preview</button>
        {onCreateBrand && <button className="button secondary" type="button" disabled={!draft.markName.trim()} onClick={() => invoke(() => onCreateBrand(trademarkBrandSeed(draft)))}>Create brand from draft</button>}
      </aside>
    </div>}
    {view === "research" && <section className="tm-research" aria-labelledby={`${id}-research`}><h2 id={`${id}-research`}>Sourced results</h2><p>No results are available. Research needs validated territory support and a connected registry data source.</p><dl>{trademarkDependencies.map((dependency) => <div key={dependency.id}><dt>{dependency.label}<span className="small-badge">Unavailable</span></dt><dd>{dependency.detail}</dd></div>)}</dl><h3>Your research notes</h3><p className="tm-hint">User-entered, unsourced</p><p className="tm-user-text">{draft.userNotes.trim() || "No user notes yet."}</p><button className="button secondary" type="button" onClick={() => setView("dossier")}>Edit dossier</button></section>}
    {view === "preview" && <section className="tm-preview" aria-labelledby={`${id}-preview`}><div className="tm-preview-heading"><h2 id={`${id}-preview`}>{preview.label}</h2><span className="small-badge">{completeness.stage === "reviewed-draft" ? "Reviewed draft" : completeness.intakeComplete ? "Intake filled" : "Incomplete draft"}</span></div>
      <p className="tm-hint">All entries below are user-entered. No application has been filed or registered.</p>
      <dl>{[["Mark", draft.markName], ["Mark type", draft.markType], ["Representation notes", draft.representationNotes], ["Requested territories", draft.territories.join("\n")], ["Goods and services", draft.goodsServices], ["Classification notes", draft.classificationNotes], ["Owner name", draft.owner.name], ["Owner address", draft.owner.address], ["Owner contact", draft.owner.contact], ["Document plan", draft.documents.plan === "none-planned" ? "No documents planned; requirements unvalidated" : draft.documents.plan === "listed" ? "Documents planned; no files attached" : "Not considered"], ["Document notes", draft.documents.notes], ["Your research notes", draft.userNotes]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value?.trim() || "Not provided"}</dd></div>)}</dl>
      {!completeness.intakeComplete && <div className="tm-missing"><h3>Missing intake sections</h3><ul>{completeness.sections.filter((section) => !section.complete).map((section) => <li key={section.id}>{section.label}</li>)}</ul></div>}
      <div className="tm-limitations"><h3>Still needed</h3><ul>{trademarkDependencies.map((dependency) => <li key={dependency.id}>{dependency.detail}</li>)}</ul><p>Completeness does not establish legal clearance, registrability or readiness to file.</p></div>
      <label className="tm-review"><input type="checkbox" checked={completeness.reviewCurrent} onChange={(event) => { setError(""); onChange(event.target.checked ? confirmTrademarkReview(draft) : { ...draft, reviewedContent: null }); }} /><span>I reviewed these user-entered notes. I understand this is a draft preview with unvalidated filing requirements.</span></label>
      <div className="tm-actions"><button className="button secondary" type="button" onClick={() => setView("dossier")}>Edit dossier</button><button className="button primary" type="button" disabled={!onExportPreview || exportState.status === "pending"} onClick={() => invoke(() => onExportPreview?.(preview))}>{exportState.status === "pending" ? "Exporting draft preview…" : "Export draft preview"}</button></div>
      {!onExportPreview && <p className="tm-hint">Export is not connected. You can review the draft here.</p>}
      {exportState.status === "failed" && <p className="tm-error" role="alert">{exportState.error || "Export failed. Your draft remains available."}</p>}
    </section>}
  </div>;
}
