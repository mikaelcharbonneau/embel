"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Icon } from "@/components/ui/icon";
import { createBrandFromName } from "@/components/workspace/name-promotion";
import { CapturedContext, NameCandidateCard, NameSymbol, RunParameters, transformLabels } from "./name-candidate-card";
import { ContextEditor, WorkshopPanel } from "./workshop-panel";
import { namesStore, useNamesStore } from "./use-names-store";
import type { NameCandidate, NamesMutationResult, NamesSnapshot, NamesUi } from "./local-names";
import { AccountNamesLibrary } from "./account-names-library";
import { NamesAssistant } from "@/features/names-assistant";
import "@/styles/naming.css";

const tabs = [{ value: "library", label: "Library" }, { value: "workshop", label: "Workshop" }, { value: "assistant", label: "AI Assistant" }] as const;

function downloadCopy(raw: string, filename: string) {
  const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function StorageRecovery({ snapshot }: { snapshot: NamesSnapshot }) {
  const [confirm, setConfirm] = useState<"load" | "replace" | null>(null);
  if (snapshot.storage === "available") return null;
  return <section className="names-recovery" aria-label="Names storage recovery">
    <p role="alert">{snapshot.error}</p>
    <div className="names-recovery-actions">
      <button type="button" className="button secondary small" onClick={() => downloadCopy(JSON.stringify(snapshot.data, null, 2), "fluid-names-this-tab.json")}>Download this tab&apos;s copy</button>
      {snapshot.storage === "unavailable" ? <button type="button" className="button secondary small" onClick={() => namesStore.retrySave()}>Retry saving</button> : null}
      {snapshot.storage === "conflict" ? <button type="button" className="button secondary small" onClick={() => setConfirm("load")}>Load saved version</button> : null}
      {snapshot.storage === "invalid" ? <>
        <button type="button" className="button secondary small" onClick={() => { const raw = namesStore.readSavedRaw(); if (raw !== null) downloadCopy(raw, "fluid-names-unreadable.json"); }}>Download stored data</button>
        <button type="button" className="text-link" onClick={() => setConfirm("replace")}>Replace unreadable saved data</button>
      </> : null}
    </div>
    {confirm ? <div className="names-recovery-confirm">
      <p>{confirm === "load" ? "Loading the saved version replaces unsaved work in this tab. Download this tab's copy first if you want to keep it." : "Replace the unreadable stored data with this tab's workspace? Download the stored data first if you want to keep it."}</p>
      <button type="button" className="button secondary small" onClick={() => setConfirm(null)}>Cancel</button>
      <button type="button" className="button danger small" onClick={() => { if (confirm === "load") namesStore.loadSaved(); else namesStore.replaceInvalid(); setConfirm(null); }}>{confirm === "load" ? "Confirm load saved version" : "Confirm replace saved data"}</button>
    </div> : null}
    <p className="names-muted">You can keep working in this tab. Downloaded copies contain your local Names data.</p>
  </section>;
}

function ScreeningStatus() {
  return <section className="names-screening" aria-label="Name screening">
    <div className="names-section-heading"><h2>Screening</h2><span>No names checked</span></div>
    <div className="names-screening-grid">
      <Link href="/domains"><Icon name="domains" size={18} /><div><strong>Domains</strong><span>Not connected</span></div><Icon name="chevron" size={13} /></Link>
      <Link href="/handles"><Icon name="handles" size={18} /><div><strong>Handles</strong><span>Not connected</span></div><Icon name="chevron" size={13} /></Link>
      <Link href="/trademarks"><Icon name="trademarks" size={18} /><div><strong>Trademarks</strong><span>Not connected</span></div><Icon name="chevron" size={13} /></Link>
    </div>
    <p>Saving or favoriting a name does not check availability or trademark clearance.</p>
  </section>;
}

function ManualCapture({ ui, onResult }: { ui: NamesUi; onResult: (result: NamesMutationResult, success: string) => void }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onResult(namesStore.addManual(), "Name added to your library.");
  }
  return <section className="names-manual" aria-label="Add a name">
    <div className="names-section-heading"><h2>Add a name</h2><button type="button" className="icon-button subtle" aria-label="Close name capture" onClick={() => namesStore.updateUi({ manualOpen: false })}><Icon name="close" size={16} /></button></div>
    <form onSubmit={submit}>
      <div className="names-manual-row"><label className="names-field">Name<input id="names-manual-value" autoFocus value={ui.manualValue} onChange={event => namesStore.updateUi({ manualValue: event.target.value })} maxLength={160} required autoComplete="off" placeholder="A name worth keeping" /></label><button className="button primary" type="submit">Save name<Icon name="plus" size={15} /></button></div>
      <ContextEditor ui={ui} />
    </form>
  </section>;
}

function WorkspaceManagement({ snapshot }: { snapshot: NamesSnapshot }) {
  const [confirm, setConfirm] = useState(false);
  return <details className="names-management"><summary>Browser workspace · {snapshot.data.candidates.length}/500 names · {snapshot.data.runs.length}/100 runs</summary>
    <p>Your Names workspace is independent of your account. Runs and their results are retained in this browser, up to 4 MB; nothing is automatically removed.</p>
    <div className="names-recovery-actions"><button type="button" className="button secondary small" onClick={() => downloadCopy(JSON.stringify(snapshot.data, null, 2), "fluid-names-workspace.json")}>Download workspace copy</button><button type="button" className="text-link" disabled={snapshot.storage !== "available"} onClick={() => setConfirm(true)}>Start a new Names workspace</button></div>
    {confirm ? <div className="names-recovery-confirm"><p>Remove all {snapshot.data.candidates.length} names and {snapshot.data.runs.length} runs from this browser workspace? Download a copy first to keep your history.</p><button type="button" className="button secondary small" onClick={() => setConfirm(false)}>Keep workspace</button><button type="button" className="button danger small" onClick={() => { namesStore.startFresh(); setConfirm(false); }}>Confirm new workspace</button></div> : null}
  </details>;
}

export function NamesWorkspace() {
  const router = useRouter();
  const snapshot = useNamesStore();
  const { candidates, runs, ui } = snapshot.data;
  const [notice, setNotice] = useState("");
  const [promotionError, setPromotionError] = useState("");
  const [pendingBrandId, setPendingBrandId] = useState<string | null>(null);
  const [libraryScope, setLibraryScope] = useState<"browser" | "account">("browser");
  const accountLibrary = ui.tab === "library" && libraryScope === "account";
  const assistant = ui.tab === "assistant";
  const accountContext = accountLibrary || assistant;
  const browserWorkspace = !accountContext;
  const compared = ui.comparisonIds.map(id => candidates.find(candidate => candidate.source.id === id)).filter((candidate): candidate is NameCandidate => Boolean(candidate));
  const activeRun = runs.find(run => run.id === ui.activeRunId);
  const activeCandidates = activeRun?.candidateIds.map(id => candidates.find(candidate => candidate.source.id === id)).filter((candidate): candidate is NameCandidate => Boolean(candidate)) ?? [];
  const query = ui.query.trim().toLocaleLowerCase("en");
  const library = candidates.filter(candidate => {
    const retained = ui.filter === "all" || (ui.filter === "retained" && (candidate.favorite || candidate.saved)) || (ui.filter === "favorite" && candidate.favorite) || (ui.filter === "saved" && candidate.saved);
    return retained && (ui.origin === "all" || candidate.source.origin === ui.origin) && (!query || candidate.source.value.toLocaleLowerCase("en").includes(query));
  }).reverse();
  function onResult(result: NamesMutationResult, success: string) {
    setNotice(result.ok ? `${success} ${result.persisted ? "Saved in this browser." : "This tab only."}` : "");
  }
  function switchTab(tab: NamesUi["tab"]) {
    namesStore.updateUi({ tab });
    setNotice("");
  }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    const tab = tabs[next]!;
    switchTab(tab.value);
    document.getElementById(`names-tab-${tab.value}`)?.focus();
  }
  function addName() { setLibraryScope("browser"); namesStore.updateUi({ manualOpen: true, tab: "library" }); setNotice(""); }
  function seed(candidate: NameCandidate) {
    onResult(namesStore.useAsSeed(candidate.source.id), `${candidate.source.value} is your next seed. Its context and history are carried forward.`);
    requestAnimationFrame(() => document.getElementById("names-seed")?.focus());
  }
  function createBrand(candidate: NameCandidate) {
    setPromotionError("");
    setPendingBrandId(null);
    try {
      const result = createBrandFromName(candidate.source, candidate.context);
      if (!result) { setPromotionError("Your browser has reached its 50-brand limit. This name and its context are unchanged. Manage browser drafts in Brands before creating another."); return; }
      if (result.persisted) router.push(`/brands/${result.id}`);
      else { setPendingBrandId(result.id); setPromotionError("Brand created in this tab only. It could not be saved in this browser."); }
    } catch (error) {
      setPromotionError(error instanceof Error && error.message === "Saved brand drafts could not be read. Recover or clear them in Settings before creating a brand." ? error.message : "The brand draft could not be created. Your name and its captured context are unchanged.");
    }
  }
  function card(candidate: NameCandidate, row = false) {
    return <NameCandidateCard key={candidate.source.id} row={row} candidate={candidate} compared={ui.comparisonIds.includes(candidate.source.id)} comparisonFull={ui.comparisonIds.length >= 3}
      onFavorite={() => namesStore.togglePreference(candidate.source.id, "favorite")} onSave={() => namesStore.togglePreference(candidate.source.id, "saved")}
      onCompare={() => namesStore.toggleComparison(candidate.source.id)} onSeed={() => seed(candidate)} onCreateBrand={() => createBrand(candidate)} />;
  }
  if (!snapshot.loaded) return <div className="page names-page"><div className="names-heading"><h1>Names</h1></div><p className="names-muted" role="status">Loading your browser workspace…</p></div>;
  return <div className={`page names-page${compared.length && browserWorkspace ? " has-comparison-tray" : ""}`}>
    <header className="names-heading"><div><h1>Names</h1><span className="names-save-label"><Icon name={accountContext ? "names" : "device"} size={12} />{accountContext ? assistant ? "Account naming" : "Account library" : snapshot.storage === "available" && !snapshot.dirty ? "Saved in this browser" : "This tab only"}</span></div><div className="names-heading-actions">{ui.tab === "library" ? <button type="button" className="button secondary small" onClick={() => switchTab("workshop")}>Open workshop<Icon name="arrow" size={14} /></button> : null}<button type="button" className="button primary small" onClick={addName}><Icon name="plus" size={15} />{assistant ? "Add browser name" : "Add name"}</button></div></header>
    <div className="names-tabs" role="tablist" aria-label="Names views">{tabs.map((tab, index) => <button key={tab.value} id={`names-tab-${tab.value}`} type="button" role="tab" aria-selected={ui.tab === tab.value} aria-controls="names-tab-panel" tabIndex={ui.tab === tab.value ? 0 : -1} onKeyDown={event => tabKey(event, index)} onClick={() => switchTab(tab.value)}>{tab.label}</button>)}</div>
    {browserWorkspace ? <StorageRecovery snapshot={snapshot} /> : null}
    {browserWorkspace && snapshot.storage === "available" && snapshot.error ? <p className="form-error" role="alert">{snapshot.error}</p> : null}
    {browserWorkspace && notice ? <p className="names-notice" role="status">{notice}</p> : null}
    {browserWorkspace && promotionError ? <div className="form-error" role="alert"><p>{promotionError}</p>{pendingBrandId ? <Link href={`/brands/${pendingBrandId}`} className="text-link">Open brand (this tab only)<Icon name="arrow" size={14} /></Link> : null}</div> : null}
    {ui.compareOpen && compared.length && browserWorkspace ? <section className="names-comparison" aria-label="Name comparison"><div className="names-section-heading"><h2 id="names-comparison-heading" tabIndex={-1}>Compare names</h2><button type="button" className="text-link" onClick={() => namesStore.updateUi({ compareOpen: false })}>Close comparison<Icon name="close" size={14} /></button></div><div className="names-comparison-scroll" tabIndex={0} aria-label="Names side by side"><div className="names-comparison-grid" style={{ gridTemplateColumns: `repeat(${compared.length}, minmax(230px, 1fr))` }}>{compared.map(candidate => <article key={candidate.source.id}><h3>{candidate.source.value}</h3><div className="names-comparison-badges"><span>{candidate.favorite ? "Favorite" : "Not favorited"}</span><span>{candidate.saved ? "Saved" : "Not saved"}</span></div><p>{candidate.source.origin === "manual" ? "Added manually" : `${candidate.source.history.length} transformation ${candidate.source.history.length === 1 ? "step" : "steps"}`}</p><CapturedContext context={candidate.context} /><dl className="names-comparison-screening"><div><dt>Domains</dt><dd>Not connected</dd></div><div><dt>Handles</dt><dd>Not connected</dd></div><div><dt>Trademarks</dt><dd>Not connected</dd></div></dl><div className="names-comparison-actions"><button type="button" className="button secondary small" onClick={() => seed(candidate)}>Use as seed</button><button type="button" className="button primary small" onClick={() => createBrand(candidate)}>Create brand</button></div></article>)}</div></div></section> : null}
    <div role="tabpanel" id="names-tab-panel" aria-labelledby={`names-tab-${ui.tab}`} className="names-tab-panel">
      {ui.tab === "library" ? <>
        <div className="project-naming-scopes" role="group" aria-label="Names library scope"><button type="button" aria-pressed={libraryScope === "browser"} onClick={() => setLibraryScope("browser")}>Browser library</button><button type="button" aria-pressed={libraryScope === "account"} onClick={() => setLibraryScope("account")}>Account library</button></div>
        {accountLibrary ? <AccountNamesLibrary /> : <>
        {ui.manualOpen ? <ManualCapture ui={ui} onResult={onResult} /> : null}
        <div className="names-library-toolbar"><label className="names-search"><span className="sr-only">Search names</span><input type="search" placeholder="Search names" value={ui.query} maxLength={160} onChange={event => namesStore.updateUi({ query: event.target.value })} /></label><label><span className="sr-only">Filter names</span><select aria-label="Filter names" value={ui.filter} onChange={event => namesStore.updateUi({ filter: event.target.value as NamesUi["filter"] })}><option value="retained">Saved or favorite</option><option value="favorite">Favorites</option><option value="saved">Saved</option><option value="all">All results</option></select></label><label><span className="sr-only">Name source</span><select aria-label="Name source" value={ui.origin} onChange={event => namesStore.updateUi({ origin: event.target.value as NamesUi["origin"] })}><option value="all">All sources</option><option value="manual">Manual</option><option value="workshop">Workshop</option></select></label><span className="names-library-count">{library.length} {library.length === 1 ? "name" : "names"}</span></div>
        {library.length ? <div className="names-library-list"><div className="names-library-columns" aria-hidden="true"><span>Name</span><span>Source</span><span>Status &amp; actions</span></div>{library.map(candidate => card(candidate, true))}</div> : <section className="names-empty"><div className="names-empty-icon"><Icon name="names" size={25} /></div><h2>{candidates.length ? "No names in this view" : "A name worth keeping"}</h2><p>{candidates.length ? "Save or favorite a result to keep it in your library, or change the filters to explore your full history." : "Add a name you have in mind, or shape a new one in the workshop."}</p><div>{candidates.length ? <button type="button" className="button secondary" onClick={() => namesStore.updateUi({ filter: "all", query: "", origin: "all" })}>View all results</button> : <><button type="button" className="button primary" onClick={addName}><Icon name="plus" size={15} />Add your first name</button><button type="button" className="text-link" onClick={() => switchTab("workshop")}>Try the workshop<Icon name="arrow" size={14} /></button></>}</div></section>}
        <p className="names-library-note"><NameSymbol name="favorite" />Favorite and saved are separate. Your default library includes either; All results keeps the full history.</p>
        </>}
      </> : null}
      {ui.tab === "workshop" ? <div className="names-workshop"><WorkshopPanel ui={ui} candidates={candidates} onResult={onResult} /><div className="names-workshop-output"><section className="names-results" aria-label="Workshop results"><div className="names-section-heading"><h2>{activeRun ? `${transformLabels[activeRun.input.kind]} results` : "Make something your own"}</h2>{activeRun ? <span>{activeCandidates.length} {activeCandidates.length === 1 ? "result" : "results"}</span> : null}</div>
        {activeRun ? <><p className="names-run-origin">{activeRun.parentId ? "Continued from" : "Started with"} <strong>{activeRun.input.kind === "blend" ? activeRun.input.left : activeRun.input.seed}</strong></p>{activeCandidates.length ? <div className="names-results-grid">{activeCandidates.map(candidate => card(candidate))}</div> : <div className="names-no-results"><p>No new variants for these parameters.</p><span>Change the seed or settings and run again. This run is still in your history.</span></div>}{activeRun.notes.length ? <ul className="names-run-notes">{activeRun.notes.map((note, index) => <li key={`${index}-${note}`}>{note}</li>)}</ul> : null}{activeRun.truncated ? <p className="names-run-limit">This run reached its 64-result limit. Narrow the parameters to explore other combinations.</p> : null}<RunParameters run={activeRun} /></> : <div className="names-workshop-empty"><span className="names-word-play" aria-hidden="true">a<span>+</span>b</span><p>Start with a word, choose a transformation, and see what takes shape.</p><span>Literal transformations you control. No AI, no availability claims.</span></div>}
      </section>{runs.length ? <section className="names-history" aria-label="Workshop history"><details><summary><Icon name="clock" size={15} />Run history<span>{runs.length}</span></summary><ol>{[...runs].reverse().map(run => <li key={run.id}><button type="button" className={run.id === activeRun?.id ? "is-active" : ""} aria-pressed={run.id === activeRun?.id} onClick={() => namesStore.updateUi({ activeRunId: run.id })}><span><strong>{transformLabels[run.input.kind]}</strong><span>{run.input.kind === "blend" ? `${run.input.left} + ${run.input.right}` : run.input.seed}</span></span><span>{run.candidateIds.length} results<time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></span></button></li>)}</ol></details></section> : null}</div></div> : null}
      {assistant ? <NamesAssistant onOpenAccountLibrary={() => { setLibraryScope("account"); switchTab("library"); }} /> : null}
    </div>
    {!assistant ? <ScreeningStatus /> : null}
    {browserWorkspace ? <WorkspaceManagement snapshot={snapshot} /> : null}
    {compared.length && browserWorkspace ? <aside className="names-comparison-tray" aria-label="Comparison tray"><div className="names-tray-content"><span>{compared.length} of 3 selected</span><div className="names-tray-names">{compared.map(candidate => <div key={candidate.source.id}><strong>{candidate.source.value}</strong><button type="button" aria-label={`Remove ${candidate.source.value} from tray`} onClick={() => namesStore.toggleComparison(candidate.source.id)}><Icon name="close" size={13} /></button></div>)}</div></div><div className="names-tray-actions"><button type="button" className="button names-compare-button" onClick={() => { namesStore.updateUi({ compareOpen: true }); requestAnimationFrame(() => { const heading = document.getElementById("names-comparison-heading"); heading?.focus(); heading?.scrollIntoView({ block: "start" }); }); }}><NameSymbol name="compare" />Compare names</button><button type="button" className="names-tray-clear" onClick={() => namesStore.clearComparison()}>Clear tray</button></div></aside> : null}
  </div>;
}

export default NamesWorkspace;
