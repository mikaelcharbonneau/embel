"use client";
import { useId, useState } from "react";
export type CompetitorDraft = { name: string; website: string };
export function CompetitorWidgetControls({ draft, onDraft, onAdd, onMore, disabled, canGenerate, generating }: {
  draft: CompetitorDraft;
  onDraft: (draft: CompetitorDraft) => void;
  onAdd: () => Promise<boolean>; onMore: () => void; disabled: boolean; canGenerate: boolean; generating: boolean;
}) {
  const id = useId();
  const [adding, setAdding] = useState(false);
  return <div className="competitor-widget-controls">
    <div className="competitor-widget-toolbar"><button type="button" className="button secondary small" aria-expanded={adding} aria-controls={`${id}-add`} disabled={disabled} onClick={() => setAdding(value => !value)}>Add competitor</button><button type="button" className="button secondary small" disabled={disabled || !canGenerate} onClick={onMore}>{generating ? "Finding more suggestions…" : "Generate more suggestions"}</button></div>
    <div id={`${id}-add`} hidden={!adding} className="competitor-add-form">
      <label className="field-label">Competitor name<input value={draft.name} maxLength={160} disabled={disabled} onChange={event => onDraft({ ...draft, name: event.target.value })} placeholder="e.g. Logram.ai" /></label>
      <label className="field-label">Website <span>(optional)</span><input type="url" value={draft.website} maxLength={2048} disabled={disabled} onChange={event => onDraft({ ...draft, website: event.target.value })} placeholder="https://example.com" /></label>
      <p>Added directly to your project. This does not start AI research.</p>
      <button type="button" className="button primary small" disabled={disabled || !draft.name.trim()} onClick={() => void onAdd().then(saved => { if (saved) setAdding(false); })}>Save competitor</button>
    </div>
  </div>;
}
