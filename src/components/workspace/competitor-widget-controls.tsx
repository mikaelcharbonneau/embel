"use client";
import { useId, useState } from "react";
import { Icon } from "@/components/ui/icon";
type CompetitorDraft = { name: string; website: string };
export function CompetitorWidgetControls({
  draft,
  onDraft,
  onAdd,
  onMore,
  disabled,
  canGenerate,
  generating,
}: {
  draft: CompetitorDraft;
  onDraft: (draft: CompetitorDraft) => void;
  onAdd: () => Promise<boolean>;
  onMore: () => void;
  disabled: boolean;
  canGenerate: boolean;
  generating: boolean;
}) {
  const id = useId();
  const [adding, setAdding] = useState(false);
  return (
    <div className="competitor-widget-controls">
      <div className="competitor-widget-toolbar">
        <button
          type="button"
          className="button secondary small"
          aria-expanded={adding}
          aria-controls={`${id}-add`}
          disabled={disabled}
          onClick={() => setAdding((value) => !value)}
        >
          <Icon name="plus" size={14} />
          Add a competitor
        </button>
        <button type="button" className="button secondary small" disabled={disabled || !canGenerate} onClick={onMore}>
          <Icon name="refresh" size={14} />
          {generating ? "Finding more…" : "Suggest more"}
        </button>
      </div>
      <div id={`${id}-add`} hidden={!adding} className="competitor-add-form">
        <label className="field-label">
          Competitor name
          <input
            value={draft.name}
            maxLength={160}
            disabled={disabled}
            onChange={(event) => onDraft({ ...draft, name: event.target.value })}
            placeholder="e.g. a shop you know"
          />
        </label>
        <label className="field-label">
          Website <span>Optional</span>
          <input
            type="url"
            value={draft.website}
            maxLength={2048}
            disabled={disabled}
            onChange={(event) => onDraft({ ...draft, website: event.target.value })}
            placeholder="https://"
          />
        </label>
        <p>
          {canGenerate
            ? "Embel looks it up like the other competitors: its website, what it offers and why it competes."
            : "Research isn’t available right now, so it’s added as you enter it."}
        </p>
        <div className="competitor-add-actions">
          <button type="button" className="button secondary small" onClick={() => setAdding(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary small"
            disabled={disabled || !draft.name.trim()}
            onClick={() =>
              void onAdd().then((saved) => {
                if (saved) setAdding(false);
              })
            }
          >
            Add competitor
          </button>
        </div>
      </div>
    </div>
  );
}
