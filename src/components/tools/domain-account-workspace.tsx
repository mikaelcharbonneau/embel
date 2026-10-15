"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { BrowserNamePicker } from "@/components/naming/browser-name-picker";
import { AccountStatus, useAccountSession } from "@/components/workspace/account-session";
import { DomainsWorkspace } from "@/features/domain-workspace/domain-workspace";
import { useStandaloneLiveChecks } from "./use-standalone-live-checks";
import { domainDraftFromSavedName, standalonePayloadCodec } from "@/features/domain-workspace/account-codec";
import { emptyDomainDraft } from "@/features/domain-workspace/draft";
import type { DomainBrandSource, DomainSearchAdapter } from "@/features/domain-workspace/model";
import { standaloneImportKey } from "@/domain/standalone-workspaces";
import type { StandaloneDraftMemory } from "./standalone-draft-memory";
import { useStandaloneWorkspace } from "./use-standalone-workspace";
import { useSavedStandalonePromotion } from "./use-saved-standalone-promotion";
import { StandaloneSaveStatus } from "./standalone-save-status";
import styles from "./domain-account-workspace.module.css";

export type AccountDomainsWorkspaceProps = {
  /** Provider-held memory, bound and fenced by AccountSessionProvider. */
  memory: StandaloneDraftMemory;
  importProjectId?: string;
  projectPicker?: ReactNode;
  /** Existing explicit brand seam only; absent unless a real flow is connected. */
  onCreateBrand?: (source: DomainBrandSource) => void;
};

const pendingDomainAdapter: DomainSearchAdapter = {
  status: "unavailable",
  reason: "Live domain checks and pricing are not ready. Recheck your account or try again. Purchases are unavailable.",
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
  const [nameLibraryOpen, setNameLibraryOpen] = useState(false);
  const nameLibrary = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = nameLibrary.current;
    if (nameLibraryOpen && dialog && !dialog.open) dialog.showModal();
    if (!nameLibraryOpen && dialog?.open) dialog.close();
  }, [nameLibraryOpen]);
  async function importName() {
    if (!importProjectId || !state.canImport) return;
    if (await state.importProject(importProjectId, (source, current) => domainDraftFromSavedName(current, source.name))) setNameLibraryOpen(false);
  }
  const controls = <section className={styles.panel} aria-label="Domain workspace">
    <StandaloneSaveStatus state={state} />
    {state.imports.length > 0 && <details className={styles.sources}><summary>Imported saved sources ({state.imports.length})</summary><ul>{state.imports.map(source => <li key={standaloneImportKey(source)}><strong>{source.name}</strong> · {source.projectTitle}<br /><span>Saved project version {source.projectRevision} · {source.origin === "naming_selection" ? "selected Naming candidate" : "supplied project name"}</span></li>)}</ul><p>Source references remain with this draft when you edit its text. Imports do not establish domain availability.</p></details>}
    <p className={styles.note}>Your search, candidates and shortlist save automatically. Live checks and prices stay in this view; purchases are unavailable.</p>
  </section>;
  if (!state.payload) return <div className="page"><h1>Domains</h1>{state.status === "loading" && <p role="status">Loading your domain draft…</p>}{controls}</div>;
  return <DomainsWorkspace adapter={live?.domains ?? pendingDomainAdapter} draft={state.payload} initialView="search" draftDisabled={!state.canEdit} onDraftChange={state.setPayload} draftNotice="Saved candidates require fresh checks when reopened."
    onOpenNameLibrary={() => setNameLibraryOpen(true)}
    draftControls={<>{controls}{promotion.controls}<dialog className={styles.nameLibrary} ref={nameLibrary} aria-label="Name library" onCancel={() => setNameLibraryOpen(false)} onClick={event => { if (event.target === event.currentTarget) setNameLibraryOpen(false); }}>
      <header><h2>From name library</h2><button type="button" className="icon-button" aria-label="Close name library" onClick={() => setNameLibraryOpen(false)}><Icon name="close" size={18} /></button></header>
      {nameLibraryOpen && <BrowserNamePicker disabled={!state.canEdit} replacing={Boolean(state.payload.input.trim())} onUse={name => {
        if (!state.canEdit || !state.payload) return;
        state.setPayload(domainDraftFromSavedName(state.payload, name)); setNameLibraryOpen(false);
      }} />}
      {(projectPicker || importProjectId) && <><p>Or choose a saved project to use its selected name in this search.</p>{nameLibraryOpen && projectPicker}
      <footer><span>{state.importing ? "Loading saved name…" : "Imported project sources stay linked to your draft."}</span><button type="button" className="button primary" disabled={!importProjectId || !state.canImport} onClick={() => void importName()}>Import saved name</button></footer></>}
      {state.error && <p className={styles.error}>{state.error}</p>}
    </dialog></>}
    onCreateBrand={promotion.select ? source => { if (!source.order) promotion.select?.({ tool: "domains", domain: source.domain }); } : onCreateBrand} />;
}
