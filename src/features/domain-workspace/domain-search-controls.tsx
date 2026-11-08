"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "@/components/ui/icon";
import styles from "./domain-workspace.module.css";

export const extensionGroups = {
  Popular: ["com", "co", "net", "org", "me", "info", "online", "biz"],
  Creative: ["studio", "design", "art", "space"],
  Technology: ["io", "ai", "app", "dev"],
  "Country codes": ["ca", "us", "uk", "fr"],
} as const;
type Category = keyof typeof extensionGroups | "All extensions";
export type DomainViewFilters = { hideUnavailable: boolean; minimum: string; maximum: string };
export const defaultViewFilters: DomainViewFilters = { hideUnavailable: true, minimum: "0", maximum: "100" };

export function domainInputEntries(value: string) {
  return value.split(/[,\n]/).map(entry => entry.trim()).filter(Boolean);
}

/** Pending text remains in the existing draft, including across session recovery. */
export function DomainNameInput({ value, onChange, disabled, id, describedBy }: {
  value: string; onChange: (value: string) => void; disabled: boolean; id: string; describedBy: string;
}) {
  const field = useRef<HTMLInputElement>(null);
  const [buffer, setBuffer] = useState<{ value: string; entries: string[]; pending: string } | null>(null);
  const editing = buffer?.value === value ? buffer : { value, entries: domainInputEntries(value), pending: "" };
  function update(entries: string[], pending: string) {
    if (disabled) return;
    const next = [...entries, ...(pending ? [pending] : [])].join("\n");
    if (next.length > 4000) return;
    setBuffer({ value: next, entries, pending });
    if (next !== value) onChange(next);
  }
  function type(next: string) {
    const parts = next.split(/[,\n]/);
    update([...editing.entries, ...parts.slice(0, -1).map(part => part.trim()).filter(Boolean)], parts.at(-1) ?? "");
  }
  function keys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && editing.pending.trim()) {
      event.preventDefault(); update([...editing.entries, editing.pending.trim()], "");
    } else if (event.key === "Backspace" && !editing.pending && editing.entries.length) {
      event.preventDefault(); update(editing.entries.slice(0, -1), editing.entries.at(-1)!);
    }
  }
  return <div className={styles.nameInput} onClick={event => { if (event.target === event.currentTarget) field.current?.focus(); }}>
    {editing.entries.map((entry, index) => <span className={styles.nameChip} key={`${index}:${entry}`} data-domain-entry={entry}>
      <span>{entry}</span><button type="button" aria-label={`Remove name ${entry}`} disabled={disabled} onClick={() => update(editing.entries.filter((_, at) => at !== index), editing.pending)}><Icon name="close" size={12} /></button>
    </span>)}
    <input ref={field} id={id} aria-describedby={describedBy} value={editing.pending} disabled={disabled} autoComplete="off" spellCheck={false}
      maxLength={Math.max(0, 4000 - editing.entries.join("\n").length - (editing.entries.length ? 1 : 0))}
      onChange={event => type(event.target.value)} onKeyDown={keys}
      onPaste={event => { const pasted = event.clipboardData.getData("text"); if (/[,\n]/.test(pasted)) { event.preventDefault(); const input = event.currentTarget; type(editing.pending.slice(0, input.selectionStart ?? 0) + pasted + editing.pending.slice(input.selectionEnd ?? editing.pending.length)); } }}
      placeholder="Add a name or domain..." />
  </div>;
}

export function DomainFilters({ extensions, onExtensionsChange, disabled, expanded, onExpandedChange, filters, onFiltersChange }: {
  extensions: string[]; onExtensionsChange: (extensions: string[]) => void; disabled: boolean;
  expanded: boolean; onExpandedChange: (expanded: boolean) => void;
  filters: DomainViewFilters; onFiltersChange: (filters: DomainViewFilters) => void;
}) {
  const uid = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [category, setCategory] = useState<Category>("Popular");
  const [query, setQuery] = useState("");
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const all = [...new Set([...Object.values(extensionGroups).flat(), ...extensions])];
  const available: readonly string[] = category === "All extensions" ? all : extensionGroups[category];
  const visible = available.filter(extension => extension.includes(query.trim().replace(/^\./, "").toLowerCase()));
  function select(next: string[]) {
    if (disabled) return;
    if (next.length > 10) { setSelectionError("Choose up to 10 extensions for one search."); return; }
    setSelectionError(null); onExtensionsChange(next);
  }
  function reset() {
    if (disabled) return;
    setSelectionError(null); setQuery(""); setCategory("Popular");
    onFiltersChange({ ...defaultViewFilters }); onExtensionsChange(["com", "co", "io"]);
  }
  const range = `${filters.minimum || "0"}${filters.maximum ? `–$${filters.maximum}` : "+"}`;
  const invalidRange = Number(filters.minimum || 0) < 0 || Number(filters.maximum || Infinity) < Number(filters.minimum || 0);
  function close() { onExpandedChange(false); trigger.current?.focus(); }
  return <div className={styles.filterSurface} onBlur={event => { if (expanded && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) onExpandedChange(false); }} onKeyDown={event => { if (event.key === "Escape" && expanded) { event.preventDefault(); close(); } }}>
    <section className={styles.collapsedFilters} aria-label="Active domain filters">
      <button ref={trigger} type="button" className={styles.editFilters} aria-expanded={expanded} aria-controls={`${uid}-filters`} onClick={() => onExpandedChange(!expanded)}><Icon name="settings" size={15} />Edit filters<Icon name="chevron" size={12} className={expanded ? styles.chevronUp : styles.chevronDown} /></button>
      <span className={styles.filterPill}>{extensions.length} extensions</span><span className={styles.filterPill}>{filters.hideUnavailable ? "Taken domains hidden" : "Taken domains shown"}</span><span className={styles.filterPill}>${range} USD / year</span>
      <button type="button" className={styles.resetSearch} disabled={disabled} onClick={reset}>Reset</button>
    </section>
    <section className={styles.filtersPanel} aria-label="Domain search filters" id={`${uid}-filters`} hidden={!expanded}>
    <header className={styles.filterHeading}><div><h2><Icon name="settings" size={16} />Refine your search</h2><p className={styles.filterScope}>Changing extensions starts a new search.</p></div><button type="button" onClick={close}>Done<Icon name="chevron" size={12} className={styles.chevronUp} /></button></header>
    <div className={styles.filterBody}>
    <div className={styles.filterColumns}>
      <nav className={styles.categories} aria-label="Extension categories"><p>Categories</p>{([...Object.keys(extensionGroups), "All extensions"] as Category[]).map(item => <button type="button" key={item} aria-pressed={category === item} onClick={() => { setCategory(item); setQuery(""); }}>{item}</button>)}</nav>
      <div className={styles.extensionBrowser}>
        <div className={styles.extensionHeading}><h3>{category === "All extensions" ? "All extensions" : `${category} extensions`}</h3><button type="button" disabled={disabled || !visible.length} onClick={() => select([...new Set([...extensions, ...visible])])}>Select all</button></div>
        <label className={styles.extensionSearch}><Icon name="search" size={15} /><span className="sr-only">Find an extension</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find an extension..." /></label>
        <fieldset className={styles.extensions} disabled={disabled}><legend className="sr-only">Extensions for names</legend>{visible.map(extension => <label key={extension}><input type="checkbox" checked={extensions.includes(extension)} onChange={event => select(event.target.checked ? [...extensions, extension] : extensions.filter(item => item !== extension))} /><span>.{extension}</span></label>)}</fieldset>
        {!visible.length && <p className={styles.muted}>No matching extensions in this category.</p>}
        {selectionError && <p className={styles.filterError} role="alert">{selectionError}</p>}
      </div>
      <div className={styles.preferences}>
        <fieldset className={styles.priceSettings} disabled={disabled}><legend className="sr-only">Price range</legend><div className={styles.preferenceHeading}><h3>Price range</h3><span>USD / year</span></div>
          <div className={styles.priceInputs}>{(["minimum", "maximum"] as const).map(key => <label key={key} htmlFor={`${uid}-${key}`}>{key === "minimum" ? "Minimum" : "Maximum"}<span className={styles.priceInput}><span aria-hidden="true">$</span><input id={`${uid}-${key}`} type="number" inputMode="decimal" min="0" step="0.01" value={filters[key]} onChange={event => onFiltersChange({ ...filters, [key]: event.target.value })} aria-invalid={invalidRange || undefined} placeholder={key === "minimum" ? "0" : "Any"} /></span></label>)}</div>
          {invalidRange && <p role="alert" className={styles.filterError}>Maximum must be at least the minimum.</p>}
        </fieldset>
        <fieldset className={styles.inclusion} disabled={disabled}><legend className="sr-only">Include in results</legend><h3>Include in results</h3>
          <label>Hide taken domains<input className={styles.switch} type="checkbox" checked={filters.hideUnavailable} onChange={event => onFiltersChange({ ...filters, hideUnavailable: event.target.checked })} /></label>
        </fieldset><button type="button" className={styles.resetFilters} disabled={disabled} onClick={reset}>Reset filters</button>
      </div>
    </div>
    <footer className={styles.selectedExtensions}><span>{extensions.length} selected</span><div>{extensions.map(extension => <button type="button" key={extension} disabled={disabled} aria-label={`Remove extension .${extension}`} onClick={() => select(extensions.filter(item => item !== extension))}>.{extension}<Icon name="close" size={12} /></button>)}</div><button type="button" className={styles.clearSelection} disabled={disabled || !extensions.length} onClick={() => select([])}>Clear selection</button></footer>
    </div>
  </section></div>;
}
