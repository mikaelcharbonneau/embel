"use client";
import { ContextDetails } from "@/components/ui/context-details";

import { useState, type ReactNode } from "react";
import { AccountStatus, useAccountSession } from "@/components/workspace/account-session";
import { standaloneImportKey } from "@/domain/standalone-workspaces";
import { TrademarkWorkspace } from "@/features/trademark-workspace/trademark-workspace";
import { createEmptyTrademarkAccountDraft, standalonePayloadCodec } from "@/features/trademark-workspace/account-codec";
import { serializeTrademarkDraftPreview } from "@/features/trademark-workspace/domain";
import { importTrademarkName } from "./trademark-account-adapter";
import type { StandaloneDraftMemory } from "./standalone-draft-memory";
import { useStandaloneWorkspace } from "./use-standalone-workspace";
import { useSavedStandalonePromotion } from "./use-saved-standalone-promotion";
import { useStandaloneLiveChecks } from "./use-standalone-live-checks";
import { TrademarkLiveResearch } from "./trademark-live-research";
import { StandaloneSaveStatus } from "./standalone-save-status";
import "./tool-page.css";

export type TrademarkAccountEditorProps = { memory: StandaloneDraftMemory; importProjectId?: string; importProjectTitle?: string; projectPicker?: ReactNode };

function TrademarkAccountContent({ memory, importProjectId, importProjectTitle, projectPicker }: TrademarkAccountEditorProps) {
  const live = useStandaloneLiveChecks(memory);
  const { session: account, isCurrent } = useAccountSession();
  const workspace = useStandaloneWorkspace({ codec: standalonePayloadCodec, emptyPayload: createEmptyTrademarkAccountDraft, memory });
  const promotion = useSavedStandalonePromotion("trademarks", workspace, memory);
  const [confirmImport, setConfirmImport] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [editorEpoch, setEditorEpoch] = useState(0);
  const importingProject = confirmImport === importProjectId ? confirmImport : null;
  if (!workspace.payload) return <section className="page tool-page"><header className="tool-heading"><div className="tool-heading-text"><h1>Trademarks</h1></div></header><StandaloneSaveStatus state={workspace} /></section>;
  async function importName(projectId: string) {
    setNotice(""); setConfirmImport(null);
    if (await workspace.importProject(projectId, importTrademarkName)) setNotice("Saved name copied into this draft. Other intake details were kept and the previous review was cleared.");
  }
  function requestImport() {
    if (!importProjectId) return;
    if (workspace.payload?.markName.trim()) setConfirmImport(importProjectId);
    else void importName(importProjectId);
  }
  const saveControl = <StandaloneSaveStatus state={workspace} onRecovered={() => { setConfirmImport(null); setEditorEpoch(epoch => epoch + 1); }} />;
  const draftControls = <>
    {projectPicker}
    <section className="page" aria-label="Trademark workspace">
      {importProjectId && <div className="tm-actions"><p>{importProjectTitle ? `Import from ${importProjectTitle}` : "Import the selected project's saved name"}</p><button type="button" className="button secondary" disabled={!workspace.canImport} onClick={requestImport}>Import saved name</button></div>}
      {importingProject && <div className="inline-confirm" role="alert"><p>Replace the mark name with the current name from this saved project? Other intake details stay in the draft; its review will be cleared.</p><button type="button" className="button secondary" disabled={workspace.busy} onClick={() => setConfirmImport(null)}>Keep current name</button><button type="button" className="button secondary" disabled={!workspace.canImport} onClick={() => void importName(importingProject)}>Replace mark name</button></div>}
      {notice && <p role="status">{notice}</p>}
      {!!workspace.imports.length && <ContextDetails  title={<>Imported names ({workspace.imports.length})</>}><ul>{workspace.imports.map(source => <li key={standaloneImportKey(source)}>{source.name} · {source.projectTitle} · version {source.projectRevision}</li>)}</ul><p>Copied from your projects as they were when you imported them.</p></ContextDetails>}
    </section>
    {promotion.controls}
  </>;
  return <TrademarkWorkspace key={editorEpoch} disabled={!workspace.canEdit} draftControls={draftControls} liveResearch={live?.trademarks.ready ? <TrademarkLiveResearch key={JSON.stringify([workspace.payload.markName, workspace.payload.territories, workspace.payload.goodsServices, workspace.payload.classificationNotes])} draft={workspace.payload} adapter={live.trademarks} disabled={!workspace.canEdit} /> : undefined} saveControl={saveControl} savedDraft={workspace.workspace ? { revision: workspace.workspace.revision, updatedAt: workspace.workspace.updatedAt, dirty: workspace.dirty } : undefined} draft={workspace.payload} onChange={workspace.setPayload} storageNotice="Your draft saves to your account automatically." onCreateBrand={promotion.select ? () => promotion.select?.({ tool: "trademarks" }) : undefined} onExportPreview={preview => {
        // A retained callback can run after synchronous session fencing, before remount.
        if (account.status !== "ready" || !isCurrent(account) || !memory.isCurrent(account)) return;
        const raw = serializeTrademarkDraftPreview(preview);
        const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url; link.download = "embel-trademark-draft-preview.json";
        try { document.body.appendChild(link); link.click(); }
        finally { link.remove(); URL.revokeObjectURL(url); }
      }} />

}

export function TrademarkAccountEditor(props: TrademarkAccountEditorProps) {
  const { session } = useAccountSession();
  if (session.status !== "ready") return <AccountStatus retainedEdits={props.memory.hasUnsaved()} />;
  return <TrademarkAccountContent key={`${session.userId}:${session.generation}`} {...props} />;
}
