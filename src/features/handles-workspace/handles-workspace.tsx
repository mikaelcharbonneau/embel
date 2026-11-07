"use client";
import { ContextDetails } from "@/components/ui/context-details";

import { BrowserNameDialog } from "@/components/naming/browser-name-picker";

import { useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { HandlesArtwork } from "@/components/ui/handles-artwork";
import { Icon } from "@/components/ui/icon";
import { checkHandleEntry, HandleCheckTimeoutError, unavailableHandleAdapter, type HandleCheckAdapter } from "./adapters";
import { declareAccountCreated, emptyHandlesSearch, emptyHandlesState, filterBundles, groupKey, groupLabel, handleStatus, handlesSearchSchema, lastCheckedAt, platforms, saveBundle, statusLabels, updateBundleEntry, type HandleBundle, type HandleEntry, type HandleMatrixRow, type HandleNameSource, type HandlePlatform, type HandlesState, type HandlesSearch, type LibraryFilter } from "./domain";
import { previewHandleSearch, type HandleSeparator } from "./search";
import { HandlesResults } from "./results";
import { downloadHandlesCsv, handleProfileUrl } from "./manual-tools";
import "@/components/tools/tool-page.css";
import "./handles-workspace.css";

type CommonProps = {
  importedNames?: HandleNameSource[];
  adapter?: HandleCheckAdapter;
  /** Account drafts store choices only; provider observations remain in the comparison. */
  saveCheckEvidence?: boolean;
  /** Checked at download time as account/session fencing may precede unmount. */
  canExport?: () => boolean;
  storageNote?: string;
  initialView?: "library" | "search";
  draftControls?: ReactNode;
  disabled?: boolean;
  /** Account hosts distinguish resolved imports from ordinary user source labels. */
  sourceLabel?: (source: HandleNameSource) => string;
  onCreateBrand?: (bundle: HandleBundle) => void;
};
export type HandlesWorkspaceProps = CommonProps & (
  { value: HandlesState; onChange: (next: HandlesState) => void; initialState?: never } |
  { value?: never; initialState?: HandlesState; onChange?: (next: HandlesState) => void }
);

export function HandleEvidenceDetails({ entry }: { entry: HandleEntry }) {
  const latest = entry.evidence.at(-1);
  return <ContextDetails className="handles-evidence" title={<>Check details {entry.evidence.length ? `(${entry.evidence.length})` : ""}</>}>{!latest ? <p>Not checked yet.</p> : entry.evidence.slice().reverse().map((evidence, index) => <dl key={`${evidence.observedAt}-${index}`}>
      <dt>Platform</dt><dd>{platforms.find(platform => platform.id === evidence.platform)?.label}</dd>
      <dt>Exact handle</dt><dd>@{evidence.handle}</dd>
      <dt>Observation</dt><dd>{evidence.outcome.replaceAll("_", " ")}</dd>
      <dt>Source</dt><dd>{evidence.source ?? "None"}{evidence.sourceUrl && <> <a href={evidence.sourceUrl} target="_blank" rel="noopener noreferrer">Open source</a></>}</dd>
      <dt>Method</dt><dd>{evidence.method}</dd>
      <dt>Checked at</dt><dd>{evidence.checkedAt ?? "Not checked"}</dd>
      <dt>Recorded at</dt><dd>{evidence.observedAt}</dd>
      {evidence.detail && <><dt>Details</dt><dd>{evidence.detail}</dd></>}
    </dl>)}</ContextDetails>;
}

function AccountDeclaration({ entry, onChange }: { entry: HandleEntry; onChange: (entry: HandleEntry) => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(entry.accountCreated?.url ?? "");
  const [error, setError] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    try { onChange(declareAccountCreated(entry, url, new Date().toISOString())); setOpen(false); setError(""); }
    catch { setError("Enter a valid account URL on this platform, or leave it blank."); }
  }
  return <div className="handles-account">
    {entry.accountCreated ? <><span className="handles-created">You created this account</span><small>Added {entry.accountCreated.declaredAt}</small>{entry.accountCreated.url && <a href={entry.accountCreated.url} target="_blank" rel="noopener noreferrer">Open my account</a>}<button type="button" className="text-link" onClick={() => onChange({ ...entry, accountCreated: null })}>Remove</button></> : <button type="button" className="text-link" onClick={() => setOpen(!open)}>I created this account</button>}
    {open && !entry.accountCreated && <form onSubmit={submit} className="handles-declare-form"><p>Note an account you made on this platform.</p><label className="handles-field">Account link (optional)<input type="url" value={url} maxLength={2048} onChange={event => setUrl(event.target.value)} placeholder="https://…" /></label>{error && <p role="alert">{error}</p>}<div className="handles-actions"><button type="submit" className="button secondary small">Save</button><button type="button" className="text-link" onClick={() => setOpen(false)}>Cancel</button></div></form>}
  </div>;
}

export function HandlesWorkspace(props: HandlesWorkspaceProps = {}) {
  const id = useId();
  const [local, setLocal] = useState<HandlesState>(props.initialState ?? emptyHandlesState());
  const state = props.value ?? local;
  const [tab, setTab] = useState<"library" | "search" | "saved" | "history">(props.initialView ?? "search");
  const search = state.search ?? emptyHandlesSearch();
  const { names, nameDraft, options: searchOptions, savedSearches, imports, platforms: chosenPlatforms, title, list } = search;
  const [history, setHistory] = useState<Array<{ id: string; at: string; names: string[]; count: number }>>([]);
  const [matrix, setMatrix] = useState<HandleMatrixRow[]>([]);
  const [chosen, setChosen] = useState<Partial<Record<HandlePlatform, { rowId: string }>>>({});
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [group, setGroup] = useState("all");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [activeCheck, setActiveCheck] = useState<{ adapter: HandleCheckAdapter; controller: AbortController } | null>(null);
  const request = useRef<AbortController | null>(null);
  const adapter = props.adapter ?? unavailableHandleAdapter;
  const adapterBinding = useRef<{ adapter: HandleCheckAdapter } | null>(null);
  const checking = adapter.availability === "ready" && activeCheck?.adapter === adapter && !activeCheck.controller.signal.aborted;
  useLayoutEffect(() => {
    const binding = { adapter };
    adapterBinding.current = binding;
    // Invalidate at commit, before a resolved old promise can publish or dispatch again.
    return () => {
      if (adapterBinding.current === binding) {
        adapterBinding.current = null;
        request.current?.abort();
      }
    };
  }, [adapter, adapter.availability]);
  function change(next: HandlesState) {
    if (props.value === undefined) setLocal(next);
    props.onChange?.(next);
  }
  function updateSearch(patch: Partial<HandlesSearch>) {
    const parsed = handlesSearchSchema.safeParse({ ...search, ...patch });
    if (!parsed.success) { setError("This search exceeds the saved input limits. Keep names within 3,000 characters and up to 20 saved searches."); return; }
    change({ ...state, search: parsed.data });
  }
  function attempt(action: () => void) { try { action(); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "This change could not be prepared."); } }
  function invalidateSearch() {
    request.current?.abort(); setActiveCheck(null); setMatrix([]); setChosen({}); setNotice(""); setError("");
  }
  const manualNames = names.split(/[\n,]/).map(value => value.trim()).filter(Boolean);
  const allNames = [...new Set([...manualNames, ...nameDraft.split(/[\n,]/).map(value => value.trim()).filter(Boolean)])];
  const sources: HandleNameSource[] = [
    ...allNames.map((name): HandleNameSource => ({ id: `manual-${name}`, name, origin: "manual", projectId: null, projectTitle: null })),
    ...(props.importedNames ?? []).filter(source => imports.includes(source.id)),
  ];
  let preview: ReturnType<typeof previewHandleSearch> = { rows: [], excluded: 0 };
  let previewError = "";
  if (sources.length) {
    try { preview = previewHandleSearch(sources, chosenPlatforms, searchOptions); }
    catch (cause) { previewError = cause instanceof Error ? cause.message : "This search could not be prepared."; }
  }
  const candidates = [...new Set(preview.rows.map(row => row.entries[0]!.handle))];
  function commitNames() { updateSearch({ names: allNames.join(", "), nameDraft: "" }); }
  function compare(event?: FormEvent) {
    event?.preventDefault();
    let rows: HandleMatrixRow[] = [];
    attempt(() => {
      rows = previewHandleSearch(sources, chosenPlatforms, searchOptions).rows;
      request.current?.abort(); setActiveCheck(null); setMatrix(rows); setChosen({}); updateSearch({ names: allNames.join(", "), nameDraft: "", title: sources[0]?.name ?? "" });
      setNotice(`${rows.length} handle ${rows.length === 1 ? "option" : "options"} ready to compare.`);
    });
    return rows;
  }
  function saveSearch() {
    attempt(() => {
      previewHandleSearch(sources, chosenPlatforms, searchOptions);
      if (savedSearches.length >= 20) throw new Error("Keep up to 20 saved searches. Remove one before saving another.");
      updateSearch({ names: allNames.join(", "), nameDraft: "", savedSearches: [...savedSearches, { id: crypto.randomUUID(), names: allNames.join(", "), imports: [...imports], platforms: [...chosenPlatforms], options: structuredClone(searchOptions) }] });
      setNotice("Search added to your saved searches.");
    });
  }
  async function checkMatrix(rows = matrix) {
    const binding = adapterBinding.current;
    if (!binding || binding.adapter !== adapter || adapter.availability !== "ready") return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const isCurrent = () => !controller.signal.aborted && request.current === controller && adapterBinding.current === binding;
    setActiveCheck({ adapter, controller }); setError("");
    setHistory(current => [{ id: crypto.randomUUID(), at: new Date().toISOString(), names: [...new Set(rows.map(row => row.source.name))], count: rows.reduce((total, row) => total + row.entries.length, 0) }, ...current].slice(0, 20));
    // Sequential and bounded; no bulk live provider implementation is supplied.
    try {
      for (const row of rows) {
        for (const entry of row.entries) {
          if (!isCurrent()) return;
          let checked: HandleEntry;
          let timedOut = false;
          try { checked = await checkHandleEntry(entry, adapter, controller.signal); }
          catch (cause) {
            if (!(cause instanceof HandleCheckTimeoutError)) throw cause;
            checked = cause.entry; timedOut = true;
          }
          if (!isCurrent()) return;
          // Retain completed evidence immediately, including when later cells fail or checks stop.
          setMatrix(current => isCurrent() ? current.map(item => item.id !== row.id ? item : { ...item, entries: item.entries.map(value => value.platform === checked.platform ? checked : value) }) : current);
          if (timedOut) throw new HandleCheckTimeoutError(checked);
        }
      }
      if (isCurrent()) { setActiveCheck(null); setNotice("Checks finished. Open a handle to see its results."); }
    } catch (cause) {
      if (isCurrent()) { setActiveCheck(null); setError(cause instanceof Error ? cause.message : "Checks could not be completed."); }
    }
  }
  const selected = Object.entries(chosen).flatMap(([platform, item]) => {
    const row = matrix.find(row => row.id === item?.rowId);
    const entry = row?.entries.find(entry => entry.platform === platform);
    return row && entry ? [{ row, entry }] : [];
  });
  function saveRow(row: HandleMatrixRow) {
    attempt(() => {
      const bundle: HandleBundle = { id: crypto.randomUUID(), title: `@${row.entries[0]!.handle}`, list: list.trim(), source: row.source, savedAt: new Date().toISOString(), entries: row.entries.map(entry => ({ ...structuredClone(entry), ...(props.saveCheckEvidence === false ? { evidence: [] } : {}) })) };
      change(saveBundle(state, bundle)); setNotice("Saved to your library.");
    });
  }
  function save(event: FormEvent) {
    event.preventDefault();
    attempt(() => {
      if (!selected.length) throw new Error("Choose at least one handle in the matrix.");
      if (new Set(selected.map(item => item.row.source.id)).size > 1) throw new Error("Choose variants from one source name per bundle so its project context stays clear.");
      const bundle: HandleBundle = { id: crypto.randomUUID(), title: title.trim(), list: list.trim(), source: selected[0]!.row.source, savedAt: new Date().toISOString(), entries: selected.map(item => ({ ...structuredClone(item.entry), ...(props.saveCheckEvidence === false ? { evidence: [] } : {}) })) };
      change(saveBundle(state, bundle)); setChosen({}); setTab("library"); setNotice("Bundle saved to your library.");
    });
  }
  // History lists checks, so it appears only when a check can run.
  const tabs = adapter.availability === "ready" ? ["search", "library", "saved", "history"] as const : ["search", "library", "saved"] as const;
  const view: typeof tab = (tabs as readonly string[]).includes(tab) ? tab : "search";
  const tabLabels = { search: "Search", library: "Library", saved: "Saved", history: "History" } as const;
  function tabKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = (tabs as readonly string[]).indexOf(view);
    const next = tabs[event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!;
    setTab(next); document.getElementById(`${id}-${next}`)?.focus();
  }
  const visible = filterBundles(state, query, filter, group);
  const groups = [...new Map(state.bundles.map(bundle => [groupKey(bundle), groupLabel(bundle)])).entries()];
  return <div className="page tool-page handles-workspace">
    <header className="tool-heading handles-heading"><div className="tool-heading-text"><h1>Find your handle. Make it yours<span>.</span></h1><p>{adapter.availability === "ready" ? "Embel drafts handle options for each platform and can look up existing YouTube profiles. Confirm on each platform before you claim one." : "Embel drafts handle options for each platform. It doesn’t check whether they’re taken yet."}</p></div></header>
    <div className="tool-tabs handles-tabs" role="tablist" aria-label="Handles workspace">{tabs.map(value => <button type="button" role="tab" id={`${id}-${value}`} data-label={tabLabels[value]} aria-controls={`${id}-panel`} aria-selected={view === value} tabIndex={view === value ? 0 : -1} onKeyDown={tabKey} onClick={() => setTab(value)} key={value}>{tabLabels[value]}</button>)}</div>
    {error && <p className="handles-error" role="alert">{error}</p>}
    <fieldset disabled={props.disabled} className="handles-editor"><section role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${view}`}>
      {view === "library" ? <>
        {state.bundles.length > 0 && <>
        <button type="button" className="button secondary small" disabled={!visible.length} onClick={() => { if (props.canExport?.() !== false) downloadHandlesCsv(visible.map(bundle => ({ name: bundle.title, entries: bundle.entries }))); }}>Export library CSV</button>
        <div className="handles-toolbar"><label className="handles-field">Search library<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Handle, brand or list" /></label><label className="handles-field">State<select value={filter} onChange={event => setFilter(event.target.value as LibraryFilter)}><option value="all">All saved handles</option><option value="favorite">Favorites</option><option value="selected">Selected</option><option value="account_created">Accounts I created</option></select></label><label className="handles-field">Brand or list<select value={group} onChange={event => setGroup(event.target.value)}><option value="all">All brands and lists</option>{groups.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><button type="button" className="button primary" onClick={() => setTab("search")}>Add handles<Icon name="plus" size={15} /></button></div>
        </>}
        {!visible.length && <div className="tool-empty"><h2>{state.bundles.length ? "No matching bundles" : "Keep your handles together"}</h2><p>{state.bundles.length ? "Try another search or state filter." : "Compare handle options across platforms, then save the ones you like."}</p><button type="button" className="button primary" onClick={() => setTab("search")}>Compare handles</button></div>}
        {groups.filter(([key]) => visible.some(bundle => groupKey(bundle) === key)).map(([key, label]) => <section className="handles-group" key={key} aria-label={label}><h2>{label}</h2>{visible.filter(bundle => groupKey(bundle) === key).map(bundle => <article className="handles-bundle" key={bundle.id}><div className="handles-bundle-heading"><div><h3>{bundle.title}</h3><p>Source: {bundle.source.name} · {props.sourceLabel ? props.sourceLabel(bundle.source) : <>{bundle.source.origin === "manual" ? "Entered name" : bundle.source.origin === "project" ? "Project" : "Names library"}{bundle.source.projectTitle ? ` · ${bundle.source.projectTitle}` : ""}</>}</p></div>{props.onCreateBrand && <button type="button" className="button secondary small" onClick={() => props.onCreateBrand?.(structuredClone(bundle))}>Create brand from bundle</button>}</div>
          <div className="handles-library-grid">{bundle.entries.map(entry => <div className="handles-saved-entry" key={entry.platform}><strong>{platforms.find(platform => platform.id === entry.platform)?.label}</strong><span className="handles-exact">@{entry.handle}</span><span className={`handles-status handles-status-${handleStatus(entry)}`}>{statusLabels[handleStatus(entry)]}</span><p className="handles-last-check">Last check: {lastCheckedAt(entry) ?? "Not checked"}</p><div className="handles-actions"><button type="button" className="button secondary small" aria-pressed={entry.favorite} onClick={() => attempt(() => change(updateBundleEntry(state, bundle.id, entry.platform, value => ({ ...value, favorite: !value.favorite }))))}>{entry.favorite ? "Favorited" : "Favorite"}</button><button type="button" className="button secondary small" aria-pressed={entry.selected} onClick={() => attempt(() => change(updateBundleEntry(state, bundle.id, entry.platform, value => ({ ...value, selected: !value.selected }))))}>{entry.selected ? "Selected" : "Select"}</button></div><AccountDeclaration entry={entry} onChange={value => attempt(() => change(updateBundleEntry(state, bundle.id, entry.platform, () => value)))} /><HandleEvidenceDetails entry={entry} /><a className="text-link" href={handleProfileUrl(entry)} target="_blank" rel="noopener noreferrer">{entry.platform === "linkedin" ? "Open company profile" : "Open profile"}</a><a className="text-link" href={platforms.find(platform => platform.id === entry.platform)!.url} target="_blank" rel="noopener noreferrer">Open platform to create or change an account</a></div>)}</div>
        </article>)}</section>)}
      </> : view === "search" ? <>
        <form className="handles-search-form" hidden={matrix.length > 0} onSubmit={event => { event.preventDefault(); commitNames(); }}>
          <div className="handles-business-field">
            <label htmlFor={`${id}-names`}>Business handles <span>· add several, separated by commas</span></label>
            <div className="handles-name-library"><BrowserNameDialog disabled={props.disabled || checking} onUse={name => {
              if (allNames.includes(name)) return;
              if (allNames.length + imports.length >= 30 || [...allNames, name].join(", ").length > 3000) { setError("Keep up to 30 names within 3,000 characters. Your current search is unchanged."); return; }
              invalidateSearch(); updateSearch({ names: [...allNames, name].join(", "), nameDraft: "" });
            }} /></div>
            <div className="handles-business-row"><div className="handles-token-field">
              {manualNames.map(name => <span className="handles-name-token" key={name}>{name}<button type="button" aria-label={`Remove ${name}`} onClick={() => { invalidateSearch(); updateSearch({ names: manualNames.filter(value => value !== name).join(", ") }); }}><HandlesArtwork name="remove" /></button></span>)}
              <input id={`${id}-names`} aria-label="Business handles" value={nameDraft} maxLength={3000} placeholder="Add another handle…" onChange={event => { invalidateSearch(); updateSearch({ nameDraft: event.target.value }); }} onBlur={commitNames} onKeyDown={event => { if ((event.key === "Enter" || event.key === ",") && !event.nativeEvent.isComposing) { event.preventDefault(); commitNames(); } }} />
            </div><button type="button" className="button secondary handles-save-search" disabled={!sources.length || !!previewError || checking} onClick={saveSearch}><HandlesArtwork name="save-search" />Save search</button></div>
          </div>
          {!!props.importedNames?.length && <fieldset className="handles-imports"><legend>Import from Names or a project</legend><div className="handles-options">{props.importedNames.map(source => <label key={source.id}><input type="checkbox" checked={imports.includes(source.id)} onChange={event => { invalidateSearch(); updateSearch({ imports: event.target.checked ? [...imports, source.id] : imports.filter(value => value !== source.id) }); }} />{source.name}{source.projectTitle && <small>{source.projectTitle}</small>}</label>)}</div></fieldset>}
          <div className="handles-preview-summary" aria-label="Candidate preview summary"><div><strong>{candidates.length} handle {candidates.length === 1 ? "option" : "options"}</strong><span>{previewError ? "Review search options" : candidates.length ? candidates.slice(0, 2).map(handle => `@${handle}`).join(" · ") : "Add a name to preview"}</span></div><a href={`#${id}-preview`} onClick={() => document.getElementById(`${id}-preview`)?.focus()}>View preview<Icon name="arrow" size={14} /></a></div>
          <div className="handles-workbench">
            <div className="handles-controls-column">
              <fieldset className="handles-card handles-platform-card"><legend className="sr-only">Platforms</legend><h2 aria-hidden="true">Platforms</h2><div className="handles-platform-options">{platforms.map(platform => {
                const checked = chosenPlatforms.includes(platform.id);
                return <label key={platform.id}><span className="handles-checkbox"><input type="checkbox" checked={checked} onChange={event => { invalidateSearch(); updateSearch({ platforms: event.target.checked ? [...chosenPlatforms, platform.id] : chosenPlatforms.filter(value => value !== platform.id) }); }} />{checked && <HandlesArtwork name="check" />}</span>{platform.label}</label>;
              })}</div></fieldset>
              <section className="handles-card handles-affix-card"><h2>Prefixes &amp; suffixes</h2>{(["prefixes", "suffixes"] as const).map(kind => <label className="handles-field" key={kind}><span>{kind === "prefixes" ? "Prefixes" : "Suffixes"} · choose or add your own</span><div className="handles-affix-input"><input aria-label={kind === "prefixes" ? "Prefixes" : "Suffixes"} value={searchOptions[kind]} maxLength={200} placeholder={kind === "prefixes" ? "get, hello, try" : "hq, studio, co"} onChange={event => { invalidateSearch(); updateSearch({ options: { ...searchOptions, [kind]: event.target.value } }); }} /><button type="button" aria-label={`Add ${kind}`} onClick={event => { const input = event.currentTarget.previousElementSibling as HTMLInputElement; const next = searchOptions[kind].trim() ? `${searchOptions[kind].replace(/[\s,]+$/, "")}, ` : ""; invalidateSearch(); updateSearch({ options: { ...searchOptions, [kind]: next } }); input.focus(); queueMicrotask(() => input.setSelectionRange(next.length, next.length)); }}>+ Add</button></div></label>)}</section>
              <section className="handles-card handles-separator-card"><h2>Separators</h2><div className="handles-separator-options">{(["", ".", "_"] as HandleSeparator[]).map(separator => <button key={separator} type="button" aria-pressed={searchOptions.separators.includes(separator)} onClick={() => { invalidateSearch(); updateSearch({ options: { ...searchOptions, separators: searchOptions.separators.includes(separator) ? searchOptions.separators.filter(value => value !== separator) : [...searchOptions.separators, separator] } }); }}>{separator === "" ? "None" : separator === "." ? "Dot ." : "Underscore _"}</button>)}</div><p>Goes between the name and a prefix or suffix. Each platform only gets the separators it allows.</p></section>
            </div>
            <section className="handles-card handles-preview-card" id={`${id}-preview`} tabIndex={-1} aria-label="Handles preview"><header><h2>Handles preview</h2><p>{candidates.length} handle {candidates.length === 1 ? "option" : "options"}</p></header>
              {previewError ? <p className="handles-error" role="status">{previewError}</p> : candidates.length ? <div className="handles-candidate-grid">{candidates.map(handle => <span key={handle}>@{handle}</span>)}</div> : <div className="handles-preview-empty"><p>Add a business handle to see options.</p></div>}
              {!!preview.excluded && <p className="handles-muted">{preview.excluded} {preview.excluded === 1 ? "option was" : "options were"} left out because a platform doesn’t allow {preview.excluded === 1 ? "it" : "them"}.</p>}
              <button type="button" className="button primary handles-check-action" disabled={!candidates.length || checking || !!previewError} onClick={() => compare()}>Build comparison</button>
              {adapter.availability === "ready" && <div className="handles-preview-actions"><span>{adapter.label}</span><button type="button" className="button secondary small" disabled={!candidates.length || checking} onClick={() => { const rows = compare(); if (rows.length) void checkMatrix(rows); }}>{checking ? "Checking…" : "Check handles"}</button></div>}
            </section>
          </div>
        </form>
        {!!matrix.length && <>
          <HandlesResults rows={matrix} selectedPlatforms={chosenPlatforms} chosen={chosen} checking={checking} checksReady={adapter.availability === "ready"} canExport={props.canExport}
            onChoose={(platform, rowId, selected) => setChosen({ ...chosen, [platform]: selected ? { rowId } : undefined })}
            onSaveRow={saveRow} savedRowIds={matrix.filter(row => state.bundles.some(bundle => bundle.source.id === row.source.id && bundle.entries.length === row.entries.length && row.entries.every(entry => bundle.entries.some(saved => saved.platform === entry.platform && saved.handle === entry.handle)))).map(row => row.id)} onEdit={() => { invalidateSearch(); queueMicrotask(() => document.getElementById(`${id}-names`)?.focus()); }} onSaveSearch={saveSearch}
            onRefresh={() => void checkMatrix()} onStop={() => { request.current?.abort(); setActiveCheck(null); }} renderEvidence={entry => <HandleEvidenceDetails entry={entry} />} />
          {!!selected.length && <form className="handles-save-tray" onSubmit={save}><div><strong>{selected.length} platforms in this bundle</strong><p>{selected.map(item => `${item.entry.platform}: @${item.entry.handle}`).join(" · ")}</p></div><label className="handles-field">Bundle name<input value={title} maxLength={160} required onChange={event => updateSearch({ title: event.target.value })} /></label><label className="handles-field">Personal list<input value={list} maxLength={160} required onChange={event => updateSearch({ list: event.target.value })} /></label><button type="submit" className="button primary" disabled={checking}>Save bundle</button></form>}
        </>}

      </> : view === "saved" ? <div className="handles-session-list">{!savedSearches.length ? <div className="tool-empty"><h2>No saved searches yet</h2><p>Save a search to come back to its names, platforms and options.</p></div> : <p className="handles-muted">Saved searches keep your names, platforms and options.</p>}{savedSearches.map(search => <article className="handles-card" key={search.id}><h2>{search.names || "Imported names"}</h2><p>{search.platforms.map(platform => platforms.find(item => item.id === platform)!.label).join(" · ")}</p><div className="handles-actions"><button type="button" className="button secondary" onClick={() => { invalidateSearch(); updateSearch({ names: search.names, nameDraft: "", imports: search.imports.filter(sourceId => props.importedNames?.some(source => source.id === sourceId)), platforms: search.platforms, options: structuredClone(search.options) }); setTab("search"); if (search.imports.some(sourceId => !props.importedNames?.some(source => source.id === sourceId))) setNotice("Some imported names are no longer available. Import them again before comparing."); }}>Use search</button><button type="button" className="text-link" onClick={() => updateSearch({ savedSearches: savedSearches.filter(item => item.id !== search.id) })}>Remove search</button></div></article>)}</div> : <div className="handles-session-list">{!history.length ? <div className="tool-empty"><h2>No checks yet</h2><p>Checks you start on this page appear here.</p></div> : <p className="handles-muted">Checks you started on this page. Open a handle in the comparison to see its results.</p>}{history.map(item => <article className="handles-card" key={item.id}><h2>{item.names.join(", ")}</h2><p>Started {item.at} · {item.count} {item.count === 1 ? "handle" : "handles"}</p></article>)}</div>}
    </section></fieldset>
    <footer className="handles-draft-footer">{notice && <p className="handles-notice" role="status">{notice}</p>}<p className="handles-note">{props.storageNote ?? "This tab only. Leaving the page clears it."}</p>{props.draftControls}</footer>

    <p className="handles-boundary">Saving a handle here doesn’t reserve it. Create the account on each platform to claim it.</p>
  </div>;
}
