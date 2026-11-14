"use client";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
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
    <div className="e-stack e-stack--md competitor-widget-controls">
      <div className="e-cluster">
        <Button
          icon="plus"
          aria-expanded={adding}
          aria-controls={`${id}-add`}
          disabled={disabled}
          onClick={() => setAdding((value) => !value)}
        >
          Add a competitor
        </Button>
        <Button icon="refresh-cw" disabled={disabled || !canGenerate} onClick={onMore}>
          {generating ? "Finding more…" : "Suggest more"}
        </Button>
      </div>
      <div id={`${id}-add`} hidden={!adding} className="e-card e-stack e-stack--md competitor-add-form">
        <div className="e-grid-fields">
          <TextField
            label="Competitor name"
            value={draft.name}
            maxLength={160}
            disabled={disabled}
            onChange={(event) => onDraft({ ...draft, name: event.target.value })}
            placeholder="e.g. a shop you know"
          />
          <TextField
            label="Website"
            optional
            type="url"
            value={draft.website}
            maxLength={2048}
            disabled={disabled}
            onChange={(event) => onDraft({ ...draft, website: event.target.value })}
            placeholder="https://"
          />
        </div>
        <p className="e-section__hint">
          {canGenerate
            ? "Embel looks it up like the other competitors: its website, what it offers and why it competes."
            : "Research isn’t available right now, so it’s added as you enter it."}
        </p>
        <div className="e-form-actions">
          <Button variant="quiet" onClick={() => setAdding(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={disabled || !draft.name.trim()}
            onClick={() =>
              void onAdd().then((saved) => {
                if (saved) setAdding(false);
              })
            }
          >
            Add competitor
          </Button>
        </div>
      </div>
    </div>
  );
}
