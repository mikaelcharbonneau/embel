"use client";
import { useId, useState } from "react";
import type { ContextSnapshot } from "@/domain/projects";
export type CompetitorDraft = { name: string; website: string };
export function CompetitorWidgetControls({ competitors, selectedIds, draft, onDraft, onSelection, onAdd, onMore, disabled, canGenerate, generating }: {
  competitors: ContextSnapshot["competitors"]; selectedIds: readonly string[]; draft: CompetitorDraft;
  onDraft: (draft: CompetitorDraft) => void; onSelection: (ids: string[]) => void;
  onAdd: () => Promise<boolean>; onMore: () => void; disabled: boolean; canGenerate: boolean; generating: boolean;
}) {
  const id = useId();
  const [adding, setAdding] = useState(false);
  return <div className="competitor-widget-controls">
    {competitors.length > 0 && <div className="guided-choice-options" aria-label="Added and retained competitors">{competitors.map(item => <label className={`guided-choice-card competitor-retained${selectedIds.includes(item.id) ? " is-selected" : ""}`} key={item.id}><input type="checkbox" checked={selectedIds.includes(item.id)} disabled={disabled} onChange={event => onSelection(event.target.checked ? [...selectedIds.filter(value => value !== item.id), item.id] : selectedIds.filter(value => value !== item.id))} /><span><strong>{item.name}</strong><small>{item.origin === "user" ? "Added by you" : "Earlier suggestion"}</small>{item.url && <span>{item.url}</span>}</span></label>)}</div>}
    <div className="competitor-widget-toolbar"><button type="button" className="button secondary small" aria-expanded={adding} aria-controls={`${id}-add`} disabled={disabled} onClick={() => setAdding(value => !value)}>Add competitor</button><button type="button" className="button secondary small" disabled={disabled || !canGenerate} onClick={onMore}>{generating ? "Finding more suggestions…" : "Generate more suggestions"}</button></div>
    <div id={`${id}-add`} hidden={!adding} className="competitor-add-form">
      <label className="field-label">Competitor name<input value={draft.name} maxLength={160} disabled={disabled} onChange={event => onDraft({ ...draft, name: event.target.value })} placeholder="e.g. Logram.ai" /></label>
      <label className="field-label">Website <span>(optional)</span><input type="url" value={draft.website} maxLength={2048} disabled={disabled} onChange={event => onDraft({ ...draft, website: event.target.value })} placeholder="https://example.com" /></label>
      <p>Added directly to your project. This does not start AI research.</p>
      <button type="button" className="button primary small" disabled={disabled || !draft.name.trim()} onClick={() => void onAdd().then(saved => { if (saved) setAdding(false); })}>Save competitor</button>
    </div>
  </div>;
}
