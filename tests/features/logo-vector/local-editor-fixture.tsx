"use client";

import { useState } from "react";
import type { LogoManualEdit } from "../../../src/domain/logo-vector";
import { LogoEditorPresentation, type LogoEditorPresentationMode } from "../../../src/features/logo-vector/components/logo-editor";
import { applyLogoManualEdit } from "../../../src/features/logo-vector/model/edits";
import { separatedLogoDocument } from "./fixtures";

/** TEST-ONLY binding for a parent-owned local demonstration; never mount in a production route. */
export function TEST_ONLY_LogoVectorFixture() {
  const [document, setDocument] = useState(separatedLogoDocument);
  const [selectedComponentId, setSelected] = useState("synthetic-symbol");
  const [lockedComponentIds, setLocks] = useState<string[]>([]);
  const [mode, setMode] = useState<LogoEditorPresentationMode>("review_required");
  const [error, setError] = useState<string | null>(null);
  const onEdit = (edit: LogoManualEdit) => {
    try {
      if (edit.kind === "locks") { applyLogoManualEdit(document, edit); setLocks([...edit.componentIds]); }
      else {
        const targets = edit.kind === "arrangement" ? edit.placements.map(item => item.componentId) : "componentId" in edit ? [edit.componentId] : [];
        if (targets.some(id => lockedComponentIds.includes(id))) throw new Error("This local component is locked.");
        setDocument(applyLogoManualEdit(document, edit));
      }
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Preview edit could not be applied."); }
  };
  return <main data-synthetic="true" style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
    <p><strong>Synthetic local fixture.</strong> Original geometric test artwork, no real brand, generated output or saved history. Changes and local locks are discarded on reload.</p>
    <label>Test-only view state <select value={mode} onChange={event => setMode(event.currentTarget.value as LogoEditorPresentationMode)}>
      <option value="review_required">Review required</option><option value="stale">Earlier basis</option><option value="conflict">Conflict</option><option value="read_only">Read only</option><option value="unavailable">Unavailable</option>
    </select></label>
    {error && <p role="alert">{error}</p>}
    <LogoEditorPresentation document={mode === "unavailable" ? null : document} mode={mode} selectedComponentId={selectedComponentId} lockedComponentIds={lockedComponentIds} onSelectComponent={setSelected} onEdit={onEdit} history={null} />
  </main>;
}
