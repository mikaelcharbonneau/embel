"use client";

import { useId, useState } from "react";
import { Icon } from "@/components/ui/icon";
import type { DomainDraft } from "./draft";
import styles from "./domain-workspace.module.css";

const extensionGroups = {
  All: ["com", "co", "studio", "ma"],
  Popular: ["com", "co", "io", "net", "org"],
  Creative: ["studio", "ma", "app", "design", "xyz"],
};

export function DomainSearchFilters({ draft, disabled, onChange, hideUnavailable, onHideUnavailable, onReset }: {
  draft: DomainDraft; disabled: boolean; onChange: (next: DomainDraft) => void;
  hideUnavailable: boolean; onHideUnavailable: (hide: boolean) => void; onReset: () => void;
}) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<keyof typeof extensionGroups>("All");
  const options = [...new Set([...(query.trim() ? Object.values(extensionGroups).flat() : extensionGroups[group]), ...(group === "All" ? draft.extensions : [])])]
    .filter(extension => extension.includes(query.trim().replace(/^\./, "").toLowerCase()));
  const choose = (extensions: string[]) => onChange({ ...draft, extensions, candidates: [] });
  return <aside className={styles.filters} aria-label="Advanced search">
    <div className={styles.filterHeading}><h2><Icon name="settings" size={16} />Advanced search</h2><button type="button" disabled={disabled} onClick={() => { setQuery(""); setGroup("All"); onReset(); }}>Reset</button></div>
    <section className={styles.filterSection} aria-label="Extensions">
      <div className={styles.filterLabel}><h3>Extensions</h3><span>{draft.extensions.length} selected</span></div>
      <input className={styles.extensionSearch} type="search" aria-label="Find an extension" placeholder="Find an extension…" value={query} onChange={event => setQuery(event.target.value)} />
      <div className={styles.extensionGroups} aria-label="Extension categories">{Object.keys(extensionGroups).map(value => <button key={value} type="button" aria-pressed={group === value} onClick={() => setGroup(value as keyof typeof extensionGroups)}>{value}</button>)}</div>
      <fieldset className={styles.extensions} disabled={disabled}><legend className="sr-only">Extensions for names</legend>{options.map(extension => <label key={extension}><input type="checkbox" checked={draft.extensions.includes(extension)} onChange={event => choose(event.target.checked ? [...draft.extensions, extension] : draft.extensions.filter(item => item !== extension))} /><span>.{extension}</span></label>)}</fieldset>
      {options.length === 0 && <p className={styles.smallNote}>No matching extensions.</p>}
      <div className={styles.extensionActions}><button type="button" disabled={disabled || !options.length} onClick={() => choose([...new Set([...draft.extensions, ...options])])}>Select all</button><button type="button" disabled={disabled || !draft.extensions.length} onClick={() => choose([])}>Clear</button></div>
    </section>
    <section className={styles.filterSection} aria-label="Transform names">
      <div className={styles.filterLabel}><h3>Transform names</h3><span>Unavailable</span></div>
      <fieldset disabled className={styles.transformOptions} title="Name transformations are not available yet."><legend className="sr-only">Name transformations unavailable</legend>{["Prefix / suffix", "Domain hacks", "Drop last vowel", "Pluralize nouns"].map(label => <label key={label}><input type="checkbox" />{label}</label>)}</fieldset>
      <div className={styles.inputPair}><label>Prefixes<input disabled placeholder="get, try" title="Prefix transformations are not available yet." /></label><label>Suffixes<input disabled placeholder="studio, hq" title="Suffix transformations are not available yet." /></label></div>
    </section>
    <section className={styles.filterSection} aria-label="Budget and availability">
      <div className={styles.filterLabel}><h3>Budget &amp; availability</h3><span>USD / year</span></div>
      <div className={styles.inputPair}><label>Minimum<input disabled placeholder="$0" title="Budget filtering requires verified registrar pricing." /></label><label>Maximum<input disabled placeholder="$50" title="Budget filtering requires verified registrar pricing." /></label></div>
      <label className={styles.filterCheckbox}><input type="checkbox" checked={hideUnavailable} onChange={event => onHideUnavailable(event.target.checked)} />Hide unavailable</label>
      <label className={styles.filterCheckbox} title="Premium-domain pricing is not connected."><input type="checkbox" disabled />Include premium domains</label>
      <p className="sr-only">Price and premium filters are unavailable.</p>
    </section>
  </aside>;
}

export function DomainKeywordInput({ draft, disabled, onChange, onPrepare, onImportNames, errors }: {
  draft: DomainDraft; disabled: boolean; onChange: (next: DomainDraft) => void;
  onPrepare: () => void; onImportNames?: () => void; errors: string[];
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const entries = draft.input.split(/[\n,]/).map(value => value.trim()).filter(Boolean);
  const tokenized = entries.length > 0 && !editing;
  return <form className={styles.keywordCard} onSubmit={event => { event.preventDefault(); onPrepare(); }}>
    <div className={styles.keywordHeading}><label htmlFor={id}>Keywords or domains</label><div className={styles.importActions}>
      <button type="button" disabled title="CSV import is not available yet."><Icon name="file" size={14} />Import CSV</button>
      <button type="button" disabled={!onImportNames} onClick={onImportNames} title={onImportNames ? "Choose a saved project and import its name below." : "Sign in to import a saved project name."}><Icon name="names" size={14} />From Names</button>
    </div></div>
    <div className={`${styles.keywordEditor} ${tokenized ? styles.tokenized : ""}`}>
      <textarea id={id} value={draft.input} maxLength={4000} rows={2} disabled={disabled} onFocus={() => setEditing(true)} onBlur={() => setEditing(false)} onChange={event => onChange({ ...draft, input: event.target.value, candidates: [] })} placeholder="Paste names here, separated by commas or new lines…" aria-describedby={`${id}-help`} />
      {tokenized && <><div className={styles.keywordTokens}>{entries.map((entry, index) => <span key={`${index}:${entry}`}><span className={styles.tokenText}>{entry}</span><button type="button" disabled={disabled} aria-label={`Remove ${entry}`} onClick={() => onChange({ ...draft, input: entries.filter((_, i) => i !== index).join("\n"), candidates: [] })}><Icon name="close" size={11} /></button></span>)}</div><span className={styles.keywordHint} aria-hidden="true">Paste names here, separated by commas or new lines…</span></>}
    </div>
    <p id={`${id}-help`} className="sr-only">Enter up to 20 ASCII names or full domains. Spaces in names are removed; full domains keep their extension. Preparing candidates does not check availability.</p>
    <div className={styles.keywordFooter}><span>{entries.length} {entries.length === 1 ? "entry" : "entries"}</span><button type="submit" className="button primary" disabled={disabled}>Generate candidates<Icon name="arrow" size={16} /></button></div>
    {errors.length > 0 && <div role="alert" className={styles.preparationError}>{errors.map((error, index) => <p key={index}>{error}</p>)}</div>}
  </form>;
}
