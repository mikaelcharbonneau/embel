"use client";

import { useState, type ReactNode } from "react";
import { AccountStatus, useAccountSession } from "@/components/workspace/account-session";
import { HandlesWorkspace } from "@/features/handles-workspace/handles-workspace";
import { createEmptyHandlesDraft, standalonePayloadCodec } from "@/features/handles-workspace/account-codec";
import { useStandaloneLiveChecks } from "./use-standalone-live-checks";
import { handlesAccountSourceLabel, handlesImportedName, importHandlesName } from "./handles-account-adapter";
import type { StandaloneDraftMemory } from "./standalone-draft-memory";
import { useStandaloneWorkspace } from "./use-standalone-workspace";
import { useSavedStandalonePromotion } from "./use-saved-standalone-promotion";
import { StandaloneSaveStatus } from "./standalone-save-status";

export type HandlesAccountEditorProps = { memory: StandaloneDraftMemory; importProjectId?: string; importProjectTitle?: string; projectPicker?: ReactNode };

function HandlesAccountContent({ memory, importProjectId, importProjectTitle, projectPicker }: HandlesAccountEditorProps) {
  const live = useStandaloneLiveChecks(memory);
  const { session: account, isCurrent } = useAccountSession();
  const workspace = useStandaloneWorkspace({ codec: standalonePayloadCodec, emptyPayload: createEmptyHandlesDraft, memory });
  const promotion = useSavedStandalonePromotion("handles", workspace, memory);
  const [notice, setNotice] = useState("");
  const [editorEpoch, setEditorEpoch] = useState(0);
  if (!workspace.payload) return <section className="page"><h1>Handles</h1><StandaloneSaveStatus state={workspace} /></section>;
  async function importName() {
    if (!importProjectId) return;
    setNotice("");
    if (await workspace.importProject(importProjectId, importHandlesName)) setNotice("Saved name added to the Search import choices. Choose it to build a comparison.");
  }
  const draftControls = <>
    {projectPicker}
    <section className="page" aria-label="Handle workspace">
      <StandaloneSaveStatus state={workspace} onRecovered={() => setEditorEpoch(epoch => epoch + 1)} />
      {importProjectId && <div className="handles-actions"><p>{importProjectTitle ? `Import from ${importProjectTitle}` : "Import the selected project's saved name"}</p><button type="button" className="button secondary" disabled={!workspace.canImport} onClick={() => void importName()}>Import saved name</button></div>}
      {notice && <p role="status">{notice}</p>}
      {!!workspace.imports.length && <details><summary>Saved-name sources ({workspace.imports.length})</summary><ul>{workspace.imports.map(source => <li key={handlesImportedName(source).id}>{source.name} · {source.projectTitle} · revision {source.projectRevision}</li>)}</ul><p>These are frozen name imports. No platform has been checked.</p></details>}
    </section>
    {promotion.controls}
  </>;
  return <HandlesWorkspace key={editorEpoch} value={workspace.payload} onChange={workspace.setPayload} importedNames={workspace.imports.map(handlesImportedName)} adapter={live?.handles} saveCheckEvidence={false} canExport={() => account.status === "ready" && isCurrent(account) && memory.isCurrent(account)} storageNote="Library choices save automatically. Provider observations stay in the current comparison." sourceLabel={source => handlesAccountSourceLabel(source, workspace.imports)} disabled={!workspace.canEdit} draftControls={draftControls} onCreateBrand={promotion.select ? bundle => promotion.select?.({ tool: "handles", bundleId: bundle.id }) : undefined} />;
}

/** Remount every transient matrix/form/request on owner or verification generation changes. */
export function HandlesAccountEditor(props: HandlesAccountEditorProps) {
  const { session } = useAccountSession();
  if (session.status !== "ready") return <AccountStatus retainedEdits={props.memory.hasUnsaved()} />;
  return <HandlesAccountContent key={`${session.userId}:${session.generation}`} {...props} />;
}
