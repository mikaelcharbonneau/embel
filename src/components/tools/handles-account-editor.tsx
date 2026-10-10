"use client";

import { useState, type ReactNode } from "react";
import { AccountStatus, useAccountSession } from "@/components/workspace/account-session";
import { HandlesWorkspace } from "@/features/handles-workspace/handles-workspace";
import { createEmptyHandlesDraft, standalonePayloadCodec } from "@/features/handles-workspace/account-codec";
import { unavailableHandleAdapter } from "@/features/handles-workspace/adapters";
import { handlesAccountSourceLabel, handlesImportedName, importHandlesName } from "./handles-account-adapter";
import type { StandaloneDraftMemory } from "./standalone-draft-memory";
import { useStandaloneWorkspace } from "./use-standalone-workspace";
import { useSavedStandalonePromotion } from "./use-saved-standalone-promotion";

export type HandlesAccountEditorProps = { memory: StandaloneDraftMemory; importProjectId?: string; importProjectTitle?: string; projectPicker?: ReactNode };

function HandlesAccountContent({ memory, importProjectId, importProjectTitle, projectPicker }: HandlesAccountEditorProps) {
  const workspace = useStandaloneWorkspace({ codec: standalonePayloadCodec, emptyPayload: createEmptyHandlesDraft, memory });
  const promotion = useSavedStandalonePromotion("handles", workspace, memory);
  const [confirmReload, setConfirmReload] = useState(false);
  const [notice, setNotice] = useState("");
  const [editorEpoch, setEditorEpoch] = useState(0);
  if (!workspace.payload) return <section className="page"><h1>Handles</h1><p role="status">{workspace.status === "loading" ? "Loading your saved handle draft…" : "Your account draft could not be loaded."}</p>{workspace.error && <p role="alert">{workspace.error}</p>}<button type="button" className="button secondary" disabled={workspace.busy} onClick={() => void workspace.reload()}>Retry loading</button></section>;
  const storageNote = workspace.dirty ? "Unsaved account edits are held in this tab. Save to keep bundles and declarations across reloads." : workspace.workspace ? `Account draft saved · revision ${workspace.workspace.revision}. Unfinished comparisons are temporary.` : "New account draft. Save to keep bundles and declarations across reloads.";
  async function importName() {
    if (!importProjectId) return;
    setNotice("");
    if (await workspace.importProject(importProjectId, importHandlesName)) setNotice("Saved name added to the Search import choices. Choose it explicitly to build a comparison; save the account draft to keep the import.");
  }
  function requestReload() {
    setNotice("");
    if (workspace.dirty || workspace.pending) setConfirmReload(true);
    else reloadDraft();
  }
  function reloadDraft(discard = false) {
    void workspace.reload(discard).then(loaded => { if (loaded) setEditorEpoch(epoch => epoch + 1); });
  }
  const draftControls = <>
    {projectPicker}
    <section className="page" aria-label="Handle account draft controls">
      <div className="handles-actions"><button type="button" className="button primary" disabled={!workspace.canSave} onClick={() => { setNotice(""); void workspace.save(); }}>{workspace.busy ? "Working…" : workspace.pending ? "Retry same save" : "Save account draft"}</button><button type="button" className="button secondary" disabled={workspace.busy} onClick={requestReload}>Load saved draft</button></div>
      {importProjectId && <div className="handles-actions"><p>{importProjectTitle ? `Import from ${importProjectTitle}` : "Import the selected project's saved name"}</p><button type="button" className="button secondary" disabled={!workspace.canEdit} onClick={() => void importName()}>Import saved name</button></div>}
      {workspace.error && <p className="handles-error" role="alert">{workspace.error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!workspace.canEdit && !workspace.busy && <p role="status">Your draft is retained. Resolve the save or load the saved draft before making further changes.</p>}
      {confirmReload && <div className="inline-confirm" role="alert"><p>Discard the unsaved changes in this tab and load the saved account draft? An interrupted save may already have reached the account.</p><button type="button" className="button secondary" disabled={workspace.busy} onClick={() => setConfirmReload(false)}>Keep my edits</button><button type="button" className="button danger" disabled={workspace.busy} onClick={() => { setConfirmReload(false); reloadDraft(true); }}>Discard changes and load saved draft</button></div>}
      {!!workspace.imports.length && <details><summary>Saved-name sources ({workspace.imports.length})</summary><ul>{workspace.imports.map(source => <li key={handlesImportedName(source).id}>{source.name} · {source.projectTitle} · revision {source.projectRevision}</li>)}</ul><p>These are frozen name imports. No platform has been checked.</p></details>}
    </section>
    {promotion.controls}
  </>;
  return <HandlesWorkspace key={editorEpoch} value={workspace.payload} onChange={workspace.setPayload} importedNames={workspace.imports.map(handlesImportedName)} adapter={unavailableHandleAdapter} storageNote={storageNote} sourceLabel={source => handlesAccountSourceLabel(source, workspace.imports)} disabled={!workspace.canEdit} draftControls={draftControls} onCreateBrand={promotion.select ? bundle => promotion.select?.({ tool: "handles", bundleId: bundle.id }) : undefined} />;
}

/** Remount every transient matrix/form/request on owner or verification generation changes. */
export function HandlesAccountEditor(props: HandlesAccountEditorProps) {
  const { session } = useAccountSession();
  if (session.status !== "ready") return <AccountStatus retainedEdits={props.memory.hasUnsaved()} />;
  return <HandlesAccountContent key={`${session.userId}:${session.generation}`} {...props} />;
}
