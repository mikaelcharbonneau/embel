"use client";

import { useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Icon } from "@/components/ui/icon";
import { checkHandleEntry, HandleCheckTimeoutError, unavailableHandleAdapter, type HandleCheckAdapter } from "./adapters";
import { buildHandleMatrix, declareAccountCreated, emptyHandlesState, filterBundles, groupKey, groupLabel, handleStatus, lastCheckedAt, platforms, saveBundle, statusLabels, updateBundleEntry, type HandleBundle, type HandleEntry, type HandleMatrixRow, type HandleNameSource, type HandlePlatform, type HandlesState, type LibraryFilter } from "./domain";
import "./handles-workspace.css";

type CommonProps = {
  importedNames?: HandleNameSource[];
  adapter?: HandleCheckAdapter;
  storageNote?: string;
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
  return <details className="handles-evidence"><summary>Check evidence {entry.evidence.length ? `(${entry.evidence.length})` : ""}</summary>
    {!latest ? <p>No check has been performed. A missing profile is not proof of availability.</p> : entry.evidence.slice().reverse().map((evidence, index) => <dl key={`${evidence.observedAt}-${index}`}>
      <dt>Platform</dt><dd>{platforms.find(platform => platform.id === evidence.platform)?.label}</dd>
      <dt>Exact handle</dt><dd>@{evidence.handle}</dd>
      <dt>Observation</dt><dd>{evidence.outcome.replaceAll("_", " ")}</dd>
      <dt>Source</dt><dd>{evidence.source ?? "None"}{evidence.sourceUrl && <> <a href={evidence.sourceUrl} target="_blank" rel="noopener noreferrer">Open source</a></>}</dd>
      <dt>Method</dt><dd>{evidence.method}</dd>
      <dt>Checked at</dt><dd>{evidence.checkedAt ?? "Not checked"}</dd>
      <dt>Recorded at</dt><dd>{evidence.observedAt}</dd>
      {evidence.detail && <><dt>Details</dt><dd>{evidence.detail}</dd></>}
    </dl>)}
  </details>;
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
    {entry.accountCreated ? <><span className="handles-created">Account created · user declared</span><small>Declared {entry.accountCreated.declaredAt}</small>{entry.accountCreated.url && <a href={entry.accountCreated.url} target="_blank" rel="noopener noreferrer">Open my account</a>}<button type="button" className="text-link" onClick={() => onChange({ ...entry, accountCreated: null })}>Remove declaration</button></> : <button type="button" className="text-link" onClick={() => setOpen(!open)}>I created this account</button>}
    {open && !entry.accountCreated && <form onSubmit={submit} className="handles-declare-form"><p>Record an account you created externally. Fluid has not verified ownership.</p><label className="handles-field">Account URL (optional)<input type="url" value={url} maxLength={2048} onChange={event => setUrl(event.target.value)} placeholder="https://…" /></label>{error && <p role="alert">{error}</p>}<div className="handles-actions"><button type="submit" className="button secondary small">Record my created account</button><button type="button" className="text-link" onClick={() => setOpen(false)}>Cancel</button></div></form>}
  </div>;
}

export function HandlesWorkspace(props: HandlesWorkspaceProps = {}) {
  const id = useId();
  const [local, setLocal] = useState<HandlesState>(props.initialState ?? emptyHandlesState());
  const state = props.value ?? local;
  const [tab, setTab] = useState<"library" | "search">("library");
  const [names, setNames] = useState("");
  const [imports, setImports] = useState<string[]>([]);
  const [chosenPlatforms, setChosenPlatforms] = useState<HandlePlatform[]>(["instagram", "tiktok", "youtube"]);
  const [variants, setVariants] = useState(false);
  const [matrix, setMatrix] = useState<HandleMatrixRow[]>([]);
  const [chosen, setChosen] = useState<Partial<Record<HandlePlatform, { rowId: string }>>>({});
  const [title, setTitle] = useState("");
  const [list, setList] = useState("Personal list");
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
  function attempt(action: () => void) { try { action(); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "This change could not be prepared."); } }
  function compare(event: FormEvent) {
    event.preventDefault();
    attempt(() => {
      const manual = names.split(/[\n,]/).map(value => value.trim()).filter(Boolean).map((name, index): HandleNameSource => ({ id: `manual-${index}-${name}`, name, origin: "manual", projectId: null, projectTitle: null }));
      const sources = [...manual, ...(props.importedNames ?? []).filter(source => imports.includes(source.id))];
      const rows = buildHandleMatrix(sources, chosenPlatforms, variants);
      request.current?.abort(); setActiveCheck(null); setMatrix(rows); setChosen({}); setTitle(sources[0]?.name ?? "");
      setNotice(`${rows.length} handle variants prepared. Platform rules and availability still need checking.`);
    });
  }
  async function checkMatrix() {
    const binding = adapterBinding.current;
    if (!binding || binding.adapter !== adapter || adapter.availability !== "ready") return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const isCurrent = () => !controller.signal.aborted && request.current === controller && adapterBinding.current === binding;
    setActiveCheck({ adapter, controller }); setError("");
    // Sequential and bounded; no bulk live provider implementation is supplied.
    try {
      for (const row of matrix) {
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
      if (isCurrent()) { setActiveCheck(null); setNotice("Checks finished. Review the evidence for each result."); }
    } catch (cause) {
      if (isCurrent()) { setActiveCheck(null); setError(cause instanceof Error ? cause.message : "Checks could not be completed."); }
    }
  }
  const selected = Object.entries(chosen).flatMap(([platform, item]) => {
    const row = matrix.find(row => row.id === item?.rowId);
    const entry = row?.entries.find(entry => entry.platform === platform);
    return row && entry ? [{ row, entry }] : [];
  });
  function save(event: FormEvent) {
    event.preventDefault();
    attempt(() => {
      if (!selected.length) throw new Error("Choose at least one handle in the matrix.");
      if (new Set(selected.map(item => item.row.source.id)).size > 1) throw new Error("Choose variants from one source name per bundle so its project context stays clear.");
      const bundle: HandleBundle = { id: crypto.randomUUID(), title: title.trim(), list: list.trim(), source: selected[0]!.row.source, savedAt: new Date().toISOString(), entries: selected.map(item => structuredClone(item.entry)) };
      change(saveBundle(state, bundle)); setChosen({}); setTab("library"); setNotice("Bundle added to the library. No handle was reserved.");
    });
  }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const next = event.key === "Home" ? "library" : event.key === "End" ? "search" : tab === "library" ? "search" : "library";
    setTab(next); document.getElementById(`${id}-${next}`)?.focus();
  }
  const visible = filterBundles(state, query, filter, group);
  const groups = [...new Map(state.bundles.map(bundle => [groupKey(bundle), groupLabel(bundle)])).entries()];
  return <div className="page handles-workspace">
    <div className="page-heading"><h1>Handles</h1><span className="small-badge">{adapter.availability === "unavailable" ? "Checks not connected" : adapter.label}</span></div>
    <div className="handles-tabs" role="tablist" aria-label="Handles workspace">{(["library", "search"] as const).map(value => <button type="button" role="tab" id={`${id}-${value}`} aria-controls={`${id}-panel`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onKeyDown={tabKey} onClick={() => setTab(value)} key={value}>{value === "library" ? "Library" : "Search"}</button>)}</div>
    <p className="handles-note">{props.storageNote ?? "This tab only. Reopening this page starts a new workspace."}</p>
    {error && <p className="handles-error" role="alert">{error}</p>}{notice && <p className="handles-notice" role="status">{notice}</p>}
    <section role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
      {tab === "library" ? <>
        <div className="handles-toolbar"><label className="handles-field">Search library<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Handle, brand or list" /></label><label className="handles-field">State<select value={filter} onChange={event => setFilter(event.target.value as LibraryFilter)}><option value="all">All saved handles</option><option value="favorite">Favorites</option><option value="selected">Selected</option><option value="account_created">Account created · user declared</option></select></label><label className="handles-field">Brand or list<select value={group} onChange={event => setGroup(event.target.value)}><option value="all">All brands and lists</option>{groups.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><button type="button" className="button primary" onClick={() => setTab("search")}>Add handles<Icon name="plus" size={15} /></button></div>
        {!visible.length && <div className="empty-panel"><h2>{state.bundles.length ? "No matching bundles" : "Keep your handles together"}</h2><p>{state.bundles.length ? "Try another search or state filter." : "Compare names across platforms, then keep a bundle for a brand or personal list."}</p><button type="button" className="button secondary" onClick={() => setTab("search")}>Compare handles</button></div>}
        {groups.filter(([key]) => visible.some(bundle => groupKey(bundle) === key)).map(([key, label]) => <section className="handles-group" key={key} aria-label={label}><h2>{label}</h2>{visible.filter(bundle => groupKey(bundle) === key).map(bundle => <article className="handles-bundle" key={bundle.id}><div className="handles-bundle-heading"><div><h3>{bundle.title}</h3><p>Source: {bundle.source.name} · {props.sourceLabel ? props.sourceLabel(bundle.source) : <>{bundle.source.origin === "manual" ? "Entered name" : bundle.source.origin === "project" ? "Project" : "Names library"}{bundle.source.projectTitle ? ` · ${bundle.source.projectTitle}` : ""}</>}</p></div>{props.onCreateBrand && <button type="button" className="button secondary small" onClick={() => props.onCreateBrand?.(structuredClone(bundle))}>Create brand from bundle</button>}</div>
          <div className="handles-library-grid">{bundle.entries.map(entry => <div className="handles-saved-entry" key={entry.platform}><strong>{platforms.find(platform => platform.id === entry.platform)?.label}</strong><span className="handles-exact">@{entry.handle}</span><span className={`handles-status handles-status-${handleStatus(entry)}`}>{statusLabels[handleStatus(entry)]}</span><p className="handles-last-check">Last check: {lastCheckedAt(entry) ?? "Not checked"}</p><div className="handles-actions"><button type="button" className="button secondary small" aria-pressed={entry.favorite} onClick={() => attempt(() => change(updateBundleEntry(state, bundle.id, entry.platform, value => ({ ...value, favorite: !value.favorite }))))}>{entry.favorite ? "Favorited" : "Favorite"}</button><button type="button" className="button secondary small" aria-pressed={entry.selected} onClick={() => attempt(() => change(updateBundleEntry(state, bundle.id, entry.platform, value => ({ ...value, selected: !value.selected }))))}>{entry.selected ? "Selected" : "Select"}</button></div><AccountDeclaration entry={entry} onChange={value => attempt(() => change(updateBundleEntry(state, bundle.id, entry.platform, () => value)))} /><HandleEvidenceDetails entry={entry} /><a className="text-link" href={platforms.find(platform => platform.id === entry.platform)!.url} target="_blank" rel="noopener noreferrer">Open platform to create or change an account</a></div>)}</div>
        </article>)}</section>)}
      </> : <>
        <form className="handles-search-form" onSubmit={compare}><label className="handles-field">Names<textarea value={names} onChange={event => setNames(event.target.value)} maxLength={3000} placeholder="One name per line, or separated by commas" rows={3} /></label>
          {!!props.importedNames?.length && <fieldset><legend>Import from Names or a project</legend><div className="handles-options">{props.importedNames.map(source => <label key={source.id}><input type="checkbox" checked={imports.includes(source.id)} onChange={event => setImports(event.target.checked ? [...imports, source.id] : imports.filter(value => value !== source.id))} />{source.name}{source.projectTitle && <small>{source.projectTitle}</small>}</label>)}</div></fieldset>}
          <fieldset><legend>Platforms</legend><div className="handles-options">{platforms.map(platform => <label key={platform.id}><input type="checkbox" checked={chosenPlatforms.includes(platform.id)} onChange={event => setChosenPlatforms(event.target.checked ? [...chosenPlatforms, platform.id] : chosenPlatforms.filter(value => value !== platform.id))} />{platform.label}</label>)}</div></fieldset>
          <div className="handles-search-footer"><label><input type="checkbox" checked={variants} onChange={event => setVariants(event.target.checked)} /> Include get… and …hq variants</label><button type="submit" className="button primary">Build comparison</button></div>
        </form>
        {!!matrix.length && <><div className="handles-matrix-heading"><div><h2>Compare handles</h2><p>Choose one handle per platform. Mix variants from the same source name in a bundle.</p></div><button type="button" className="button secondary small" disabled={adapter.availability === "unavailable" || checking} onClick={() => void checkMatrix()}>{checking ? "Checking…" : "Check platforms"}</button>{checking && <button type="button" className="text-link" onClick={() => { request.current?.abort(); setActiveCheck(null); }}>Stop checks</button>}</div><p className="handles-note">{adapter.availability === "unavailable" ? "Platform checks are not connected. All candidates remain to check." : "A result is tied to its exact handle, platform, source and check date."}</p>
          <div className="handles-matrix-scroll" role="region" aria-label="Handle comparison matrix" tabIndex={0}><table className="handles-matrix"><caption className="sr-only">Handle variants by platform</caption><thead><tr><th scope="col">Name / variant</th>{matrix[0]!.entries.map(entry => <th scope="col" key={entry.platform}>{platforms.find(platform => platform.id === entry.platform)?.label}</th>)}</tr></thead><tbody>{matrix.map(row => <tr key={row.id}><th scope="row"><strong>{row.source.name}</strong><small>{row.variant}</small>{row.source.projectTitle && <small>{row.source.projectTitle}</small>}</th>{row.entries.map(entry => <td key={entry.platform}><label className="handles-choice"><input type="checkbox" aria-label={`Choose @${entry.handle} on ${entry.platform} for bundle`} checked={chosen[entry.platform]?.rowId === row.id} onChange={event => setChosen({ ...chosen, [entry.platform]: event.target.checked ? { rowId: row.id } : undefined })} /><span>@{entry.handle}</span></label><span className={`handles-status handles-status-${handleStatus(entry)}`}>{statusLabels[handleStatus(entry)]}</span><HandleEvidenceDetails entry={entry} /></td>)}</tr>)}</tbody></table></div>
          <form className="handles-save-tray" onSubmit={save}><div><strong>{selected.length} platforms in this bundle</strong><p>{selected.map(item => `${item.entry.platform}: @${item.entry.handle}`).join(" · ") || "Choose handles in the matrix."}</p></div><label className="handles-field">Bundle name<input value={title} maxLength={160} required onChange={event => setTitle(event.target.value)} /></label><label className="handles-field">Personal list<input value={list} maxLength={160} required onChange={event => setList(event.target.value)} /></label><button type="submit" className="button primary" disabled={!selected.length || checking}>Save bundle</button></form>
        </>}
      </>}
    </section>
    <p className="handles-boundary">Saving, favoriting or selecting a handle does not reserve it. Create accounts and change handles on the external platform. A user declaration does not verify ownership or availability.</p>
  </div>;
}
