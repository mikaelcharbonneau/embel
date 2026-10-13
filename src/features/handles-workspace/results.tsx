"use client";

import { Fragment, useState, type ReactNode } from "react";
import { HandlesArtwork, type HandlesArtworkName } from "@/components/ui/handles-artwork";
import { handleStatus, platforms, statusLabels, type HandleEntry, type HandleMatrixRow, type HandlePlatform } from "./domain";
import { downloadHandlesCsv, handleProfileUrl } from "./manual-tools";

const unsupported = [{ id: "threads", label: "Threads" }, { id: "facebook", label: "Facebook" }, { id: "whatsapp", label: "WhatsApp" }] as const;

/** Every selected platform must have exact, authoritative available evidence. */
export function availableEverywhere(row: HandleMatrixRow, selected: HandlePlatform[]) {
  return selected.length > 0 && selected.every(platform => {
    const entry = row.entries.find(item => item.platform === platform);
    return Boolean(entry && handleStatus(entry) === "confirmed_available");
  });
}

export function HandlesResults(props: {
  rows: HandleMatrixRow[];
  selectedPlatforms: HandlePlatform[];
  chosen: Partial<Record<HandlePlatform, { rowId: string }>>;
  checking: boolean;
  checksReady: boolean;
  canExport?: () => boolean;
  onChoose: (platform: HandlePlatform, rowId: string, selected: boolean) => void;
  onSaveRow: (row: HandleMatrixRow) => void;
  savedRowIds: string[];
  onEdit: () => void;
  onSaveSearch: () => void;
  onRefresh: () => void;
  onStop: () => void;
  renderEvidence: (entry: HandleEntry) => ReactNode;
}) {
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const available = props.rows.filter(row => availableEverywhere(row, props.selectedPlatforms));
  const visible = onlyAvailable ? available : props.rows;
  const columns = [...platforms.filter(item => props.selectedPlatforms.includes(item.id)), ...unsupported];
  const sources = [...new Map(props.rows.map(row => [row.source.id, row.source])).values()];
  return <section className="handles-results" aria-label="Handles results">
    <div className="handles-business-field">
      <p className="handles-summary-label">Business handles <span>· {props.selectedPlatforms.length} platforms selected</span></p>
      <div className="handles-business-row">
        <div className="handles-search-summary">{sources.map(source => <span className="handles-name-token" key={source.id} title={source.projectTitle ?? undefined}>{source.name}</span>)}<button type="button" className="handles-edit-search" onClick={props.onEdit}><HandlesArtwork name="edit" />Edit search</button></div>
        <button type="button" className="button secondary handles-save-search" onClick={props.onSaveSearch}><HandlesArtwork name="save-search" />Save search</button>
        <button type="button" className="button secondary" disabled={!visible.length} onClick={() => { if (props.canExport?.() !== false) downloadHandlesCsv(visible.map(row => ({ name: row.source.name, entries: row.entries }))); }}>Export handles CSV</button>
      </div>
    </div>
    <div className="handles-results-bar">
      <div className="handles-result-filters" aria-label="Availability filters"><button type="button" aria-pressed={!onlyAvailable} onClick={() => setOnlyAvailable(false)}>All handles <span>{props.rows.length}</span></button><button type="button" aria-pressed={onlyAvailable} onClick={() => setOnlyAvailable(true)}>Available everywhere <span>{available.length}</span></button></div>
      <div className="handles-result-legend"><span><HandlesArtwork name="available-dot" />Available</span><span><HandlesArtwork name="unavailable-dot" />Unavailable (taken)</span><span><b className="handles-unknown-mark">?</b>Unknown</span></div>
    </div>
    <div className="handles-results-table-frame">
      <div className="handles-results-scroll" role="region" aria-label="Handle comparison matrix" tabIndex={0}>
        <table className="handles-results-table"><caption className="sr-only">Handle variants by platform. Select platform icons for a mixed bundle, or save all supported platforms in a row. Question marks indicate unknown availability; dashes indicate disconnected platforms.</caption>
          <colgroup><col className="handles-result-name-col" />{columns.map(column => <col className="handles-result-platform-col" key={column.id} />)}<col className="handles-result-save-col" /></colgroup>
          <thead><tr><th scope="col">Handle</th>{columns.map(column => <th scope="col" key={column.id}>{column.label}</th>)}<th scope="col">Save</th></tr></thead>
          <tbody>{visible.map(row => {
            const count = props.selectedPlatforms.filter(platform => row.entries.some(entry => entry.platform === platform && handleStatus(entry) === "confirmed_available")).length;
            const label = row.entries[0]!.handle;
            return <Fragment key={row.id}><tr className="handles-result-row">
              <th scope="row"><div className="handles-result-identity"><button type="button" aria-label={`Details for @${label} from ${row.source.name}`} aria-expanded={expanded === row.id} onClick={() => setExpanded(expanded === row.id ? null : row.id)}>@{label}</button><span title={`${count} confirmed available of ${props.selectedPlatforms.length} selected platforms`}>{count}/{props.selectedPlatforms.length}</span></div></th>
              {columns.map(column => {
                const supported = props.selectedPlatforms.includes(column.id as HandlePlatform);
                const entry = row.entries.find(item => item.platform === column.id);
                const status = entry ? handleStatus(entry) : null;
                const description = !supported ? "Not connected" : !entry ? "Excluded by local syntax rules" : status === "to_check" ? "Unknown" : statusLabels[status!];
                const icon = `${column.id}-${status === "confirmed_available" ? "available" : "unavailable"}` as HandlesArtworkName;
                return <td key={column.id}>{entry ? <label className="handles-result-platform" title={`${column.label}: ${description}. Select for bundle.`}>
                  <input type="checkbox" aria-label={`Choose @${entry.handle} on ${entry.platform} for bundle`} checked={props.chosen[entry.platform]?.rowId === row.id} onChange={event => props.onChoose(entry.platform, row.id, event.target.checked)} />
                  <HandlesArtwork name={icon} />{status === "to_check" && <b className="handles-platform-marker" aria-hidden="true">?</b>}<span className="sr-only">{statusLabels[status!]}</span>
                </label> : <span className="handles-result-platform handles-platform-disconnected" title={`${column.label}: ${description}`}><HandlesArtwork name={icon} /><b className="handles-platform-marker" aria-hidden="true">—</b><span className="sr-only">{description}</span></span>}</td>;
              })}
              <td><button type="button" className="handles-row-save" aria-label={`Save @${label} from ${row.source.name} to library`} title="Save this row as a bundle; nothing is reserved" aria-pressed={props.savedRowIds.includes(row.id)} disabled={props.checking || props.savedRowIds.includes(row.id)} onClick={() => props.onSaveRow(row)}><HandlesArtwork name="save-search" /></button></td>
            </tr>{expanded === row.id && <tr className="handles-result-details"><td colSpan={columns.length + 2}><p>Source: {row.source.name} · {row.variant}{row.source.projectTitle ? ` · ${row.source.projectTitle}` : ""}</p><div className="handles-result-evidence-grid">{row.entries.map(entry => <section key={entry.platform}><h3>{platforms.find(platform => platform.id === entry.platform)!.label} · @{entry.handle}</h3>{props.renderEvidence(entry)}<a className="text-link" href={handleProfileUrl(entry)} target="_blank" rel="noopener noreferrer">{entry.platform === "linkedin" ? "Open company profile" : "Open profile"}</a></section>)}</div></td></tr>}</Fragment>;
          })}{!visible.length && <tr><td colSpan={columns.length + 2} className="handles-results-empty">No handles have confirmed availability on every selected platform. Unknown, excluded and taken results are not included.</td></tr>}</tbody>
        </table>
      </div>
      <div className="handles-results-footer"><span>{visible.length} of {props.rows.length} handles across {props.selectedPlatforms.length} selected platforms</span><button type="button" aria-label="Refresh results" title={props.checksReady ? "Refresh results" : "Platform checks are not connected"} disabled={!props.checksReady || props.checking} onClick={props.onRefresh}><HandlesArtwork name="refresh" />{props.checking ? "Checking…" : "Refresh results"}</button>{props.checking && <button type="button" onClick={props.onStop}>Stop checks</button>}</div>
    </div>
    <p className="handles-results-reminder">Availability can change. Confirm on the platform before claiming a handle.</p>
    <p className="handles-results-reminder">{props.checksReady ? "Counts use the latest recorded evidence for each exact handle and platform. Open a handle to review sources and dates." : "Checks are not connected. Availability is unknown."} Threads, Facebook and WhatsApp are not connected and are excluded from counts.</p>
    <p className="handles-results-reminder">Open a handle’s details to inspect its profiles manually. Opening a profile does not mark it available. Select platform icons to mix variants from one source name in a bundle.</p>
  </section>;
}
