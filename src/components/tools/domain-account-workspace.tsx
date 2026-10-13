"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { BrowserNamePicker } from "@/components/naming/browser-name-picker";
import { AccountStatus, useAccountSession } from "@/components/workspace/account-session";
import { DomainsWorkspace } from "@/features/domain-workspace/domain-workspace";
import { useStandaloneLiveChecks } from "./use-standalone-live-checks";
import { domainDraftFromSavedName, standalonePayloadCodec } from "@/features/domain-workspace/account-codec";
import { emptyDomainDraft } from "@/features/domain-workspace/draft";
import type { DomainBrandSource } from "@/features/domain-workspace/model";
import { standaloneImportKey } from "@/domain/standalone-workspaces";
import type { StandaloneDraftMemory } from "./standalone-draft-memory";
import { useStandaloneWorkspace } from "./use-standalone-workspace";
import { useSavedStandalonePromotion } from "./use-saved-standalone-promotion";
import styles from "./domain-account-workspace.module.css";

export type AccountDomainsWorkspaceProps = {
  /** Provider-held memory, bound and fenced by AccountSessionProvider. */
  memory: StandaloneDraftMemory;
  importProjectId?: string;
  projectPicker?: ReactNode;
  /** Existing explicit brand seam only; absent unless a real flow is connected. */
  onCreateBrand?: (source: DomainBrandSource) => void;
};

export function AccountDomainsWorkspace(props: AccountDomainsWorkspaceProps) {
  const { session } = useAccountSession();
  if (session.status !== "ready") return <div className="page"><h1>Domains</h1><AccountStatus retainedEdits={props.memory.hasUnsaved()} /></div>;
  return <OwnedDomainsWorkspace key={`${session.userId}:${session.generation}`} {...props} />;
}

function OwnedDomainsWorkspace({ memory, importProjectId, projectPicker, onCreateBrand }: AccountDomainsWorkspaceProps) {
  const live = useStandaloneLiveChecks(memory);
  const state = useStandaloneWorkspace({ codec: standalonePayloadCodec, emptyPayload: emptyDomainDraft, memory });
  const promotion = useSavedStandalonePromotion("domains", state, memory);
  const [discardRequested, setDiscardRequested] = useState(false);
  const [nameLibraryOpen, setNameLibraryOpen] = useState(false);
  const nameLibrary = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = nameLibrary.current;
    if (nameLibraryOpen && dialog && !dialog.open) dialog.showModal();
    if (!nameLibraryOpen && dialog?.open) dialog.close();
  }, [nameLibraryOpen]);
  async function importName() {
    if (!importProjectId || !state.canEdit) return;
    if (await state.importProject(importProjectId, (source, current) => domainDraftFromSavedName(current, source.name))) setNameLibraryOpen(false);
  }
  async function reload(discard = false) {
    if (!discard && (state.dirty || state.pending)) { setDiscardRequested(true); return; }
    if (await state.reload(discard)) setDiscardRequested(false);
  }
  const status = !state.payload ? state.status === "loading" ? "Loading account draft…" : "Account draft unavailable" : state.busy ? "Account request in progress…" : state.pending ? "Save outcome needs checking. Retry the same save or load the saved draft." : state.dirty ? "Unsaved draft in this tab" : state.workspace ? `Saved to account · version ${state.workspace.revision}` : "New account draft · not saved yet";
  const controls = <section className={styles.panel} aria-label="Domain account draft">
    <div className={styles.heading}><div><h2>Account draft</h2><p role="status">{status}</p></div><div className={styles.actions}>
      <button className="button primary small" type="button" disabled={!state.canSave} onClick={() => void state.save()}>{state.pending && !state.busy ? "Retry save" : "Save draft"}</button>
      <button className="button secondary small" type="button" disabled={state.busy} onClick={() => void reload()}>Load saved draft</button>
    </div></div>
    {state.error && <p className={styles.error} role="alert">{state.error}</p>}
    {discardRequested && <div className={styles.discard} aria-label="Replace domain draft"><p>Load the latest saved draft and discard the edits kept in this tab?</p><div className={styles.actions}><button className="button secondary small" type="button" disabled={state.busy} onClick={() => setDiscardRequested(false)}>Keep edits</button><button className="button secondary small" type="button" disabled={state.busy} onClick={() => void reload(true)}>Discard edits and load saved draft</button></div></div>}
    <div className={styles.import}><button className="button secondary small" type="button" disabled={!importProjectId || !state.canEdit} onClick={() => void importName()}>Import saved name</button><p>{importProjectId ? "Replace the search text with this project’s saved name. Prepare and save when ready." : "Choose an account project to import its saved name."}</p></div>
    {state.imports.length > 0 && <details className={styles.sources}><summary>Imported saved sources ({state.imports.length})</summary><ul>{state.imports.map(source => <li key={standaloneImportKey(source)}><strong>{source.name}</strong> · {source.projectTitle}<br /><span>Saved project version {source.projectRevision} · {source.origin === "naming_selection" ? "selected Naming candidate" : "supplied project name"}</span></li>)}</ul><p>Source references remain with this draft when you edit its text. Imports do not establish domain availability.</p></details>}
    <p className={styles.note}>Account drafts contain search text, extensions and prepared candidates. Live checks and prices stay in this view; purchases are unavailable.</p>
  </section>;
  if (!state.payload) return <div className="page"><h1>Domains</h1>{state.status === "loading" && <p role="status">Loading your domain draft…</p>}{controls}</div>;
  return <DomainsWorkspace adapter={live?.domains} draft={state.payload} initialView="search" draftDisabled={!state.canEdit} onDraftChange={state.setPayload} draftNotice={state.dirty ? "Changes stay in this tab until you save the account draft." : "Saved candidates require fresh checks when reopened."}
    onOpenNameLibrary={() => setNameLibraryOpen(true)}
    draftControls={<>{controls}{promotion.controls}<dialog className={styles.nameLibrary} ref={nameLibrary} aria-label="Name library" onCancel={() => setNameLibraryOpen(false)} onClick={event => { if (event.target === event.currentTarget) setNameLibraryOpen(false); }}>
      <header><h2>From name library</h2><button type="button" className="icon-button" aria-label="Close name library" onClick={() => setNameLibraryOpen(false)}><Icon name="close" size={18} /></button></header>
      {nameLibraryOpen && <BrowserNamePicker disabled={!state.canEdit} replacing={Boolean(state.payload.input.trim())} onUse={name => {
        if (!state.canEdit || !state.payload) return;
        state.setPayload(domainDraftFromSavedName(state.payload, name)); setNameLibraryOpen(false);
      }} />}
      {(projectPicker || importProjectId) && <><p>Or choose a saved project to use its selected name in this search.</p>{nameLibraryOpen && projectPicker}
      <footer><span>{state.busy ? "Loading saved name…" : "Imported project sources stay linked to your draft."}</span><button type="button" className="button primary" disabled={!importProjectId || !state.canEdit} onClick={() => void importName()}>Import saved name</button></footer></>}
      {state.error && <p className={styles.error}>{state.error}</p>}
    </dialog></>}
    onCreateBrand={promotion.select ? source => { if (!source.order) promotion.select?.({ tool: "domains", domain: source.domain }); } : onCreateBrand} />;
}
