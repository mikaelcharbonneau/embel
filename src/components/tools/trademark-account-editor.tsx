"use client";

import { useState } from "react";
import { AccountStatus, useAccountSession } from "@/components/workspace/account-session";
import { standaloneImportKey } from "@/domain/standalone-workspaces";
import { TrademarkWorkspace } from "@/features/trademark-workspace/trademark-workspace";
import { createEmptyTrademarkAccountDraft, standalonePayloadCodec } from "@/features/trademark-workspace/account-codec";
import { serializeTrademarkDraftPreview } from "@/features/trademark-workspace/domain";
import { importTrademarkName } from "./trademark-account-adapter";
import type { StandaloneDraftMemory } from "./standalone-draft-memory";
import { useStandaloneWorkspace } from "./use-standalone-workspace";
import { useSavedStandalonePromotion } from "./use-saved-standalone-promotion";

export type TrademarkAccountEditorProps = { memory: StandaloneDraftMemory; importProjectId?: string; importProjectTitle?: string };

function TrademarkAccountContent({ memory, importProjectId, importProjectTitle }: TrademarkAccountEditorProps) {
  const { session: account, isCurrent } = useAccountSession();
  const workspace = useStandaloneWorkspace({ codec: standalonePayloadCodec, emptyPayload: createEmptyTrademarkAccountDraft, memory });
  const promotion = useSavedStandalonePromotion("trademarks", workspace, memory);
  const [confirmReload, setConfirmReload] = useState(false);
  const [confirmImport, setConfirmImport] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [editorEpoch, setEditorEpoch] = useState(0);
  const importingProject = confirmImport === importProjectId ? confirmImport : null;
  if (!workspace.payload) return <section className="page"><h1>Trademarks</h1><p role="status">{workspace.status === "loading" ? "Loading your saved trademark draft…" : "Your account draft could not be loaded."}</p>{workspace.error && <p role="alert">{workspace.error}</p>}<button type="button" className="button secondary" disabled={workspace.busy} onClick={() => void workspace.reload()}>Retry loading</button></section>;
  const storageNotice = workspace.dirty ? "Unsaved account edits are held in this tab. Save to keep this draft across reloads." : workspace.workspace ? `Account draft saved · revision ${workspace.workspace.revision}. Review marks only your user-entered notes.` : "New account draft. Save to keep these notes across reloads.";
  async function importName(projectId: string) {
    setNotice(""); setConfirmImport(null);
    if (await workspace.importProject(projectId, importTrademarkName)) setNotice("Saved name copied into this draft. Other intake details were kept and the previous review was cleared. Save the account draft to retain this change.");
  }
  function requestImport() {
    if (!importProjectId) return;
    if (workspace.payload?.markName.trim()) setConfirmImport(importProjectId);
    else void importName(importProjectId);
  }
  function requestReload() {
    setNotice("");
    if (workspace.dirty || workspace.pending) setConfirmReload(true);
    else reloadDraft();
  }
  function reloadDraft(discard = false) {
    void workspace.reload(discard).then(loaded => { if (loaded) setEditorEpoch(epoch => epoch + 1); });
  }
  return <>
    <section className="page" aria-label="Trademark account draft controls">
      <div className="tm-actions"><button type="button" className="button primary" disabled={!workspace.canSave} onClick={() => { setNotice(""); void workspace.save(); }}>{workspace.busy ? "Working…" : workspace.pending ? "Retry same save" : "Save account draft"}</button><button type="button" className="button secondary" disabled={workspace.busy} onClick={requestReload}>Load saved draft</button></div>
      {importProjectId && <div className="tm-actions"><p>{importProjectTitle ? `Import from ${importProjectTitle}` : "Import the selected project's saved name"}</p><button type="button" className="button secondary" disabled={!workspace.canEdit} onClick={requestImport}>Import saved name</button></div>}
      {importingProject && <div className="inline-confirm" role="alert"><p>Replace the mark name with the current name from this saved project? Other intake details stay in the draft; its review will be cleared.</p><button type="button" className="button secondary" disabled={workspace.busy} onClick={() => setConfirmImport(null)}>Keep current name</button><button type="button" className="button secondary" disabled={!workspace.canEdit} onClick={() => void importName(importingProject)}>Replace mark name</button></div>}
      {workspace.error && <p className="tm-error" role="alert">{workspace.error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!workspace.canEdit && !workspace.busy && <p role="status">Your draft is retained. Resolve the save or load the saved draft before making further changes.</p>}
      {confirmReload && <div className="inline-confirm" role="alert"><p>Discard the unsaved changes in this tab and load the saved account draft? An interrupted save may already have reached the account.</p><button type="button" className="button secondary" disabled={workspace.busy} onClick={() => setConfirmReload(false)}>Keep my edits</button><button type="button" className="button danger" disabled={workspace.busy} onClick={() => { setConfirmReload(false); setConfirmImport(null); reloadDraft(true); }}>Discard changes and load saved draft</button></div>}
      {!!workspace.imports.length && <details><summary>Saved-name sources ({workspace.imports.length})</summary><ul>{workspace.imports.map(source => <li key={standaloneImportKey(source)}>{source.name} · {source.projectTitle} · revision {source.projectRevision}</li>)}</ul><p>Sources record copied names. They establish no ownership of a mark or legal clearance.</p></details>}
    </section>
    {promotion.controls}
    <fieldset disabled={!workspace.canEdit} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }} aria-label="Trademark draft editor">
      <TrademarkWorkspace key={editorEpoch} draft={workspace.payload} onChange={workspace.setPayload} storageNotice={storageNotice} onCreateBrand={promotion.select ? () => promotion.select?.({ tool: "trademarks" }) : undefined} onExportPreview={preview => {
        // A retained callback can run after synchronous session fencing, before remount.
        if (account.status !== "ready" || !isCurrent(account) || !memory.isCurrent(account)) return;
        const raw = serializeTrademarkDraftPreview(preview);
        const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url; link.download = "fluid-trademark-draft-preview.json";
        try { document.body.appendChild(link); link.click(); }
        finally { link.remove(); URL.revokeObjectURL(url); }
      }} />
    </fieldset>
  </>;
}

export function TrademarkAccountEditor(props: TrademarkAccountEditorProps) {
  const { session } = useAccountSession();
  if (session.status !== "ready") return <AccountStatus retainedEdits={props.memory.hasUnsaved()} />;
  return <TrademarkAccountContent key={`${session.userId}:${session.generation}`} {...props} />;
}
