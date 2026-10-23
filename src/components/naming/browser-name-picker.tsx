"use client";
import { isDialogBackdropClick } from "@/components/ui/dialog-backdrop";

import { useEffect, useId, useRef, useState } from "react";
import { useNamesStore } from "./use-names-store";
import styles from "./browser-name-picker.module.css";

/** Explicitly copies the text of a name from the verified account. */
export function BrowserNamePicker({ onUse, disabled = false, replacing = false }: {
  onUse: (name: string) => void;
  disabled?: boolean;
  replacing?: boolean;
}) {
  const snapshot = useNamesStore();
  const id = useId();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const candidate = snapshot.data.candidates.find(item => item.source.id === selected);
  const choices = snapshot.data.candidates.filter(item => item.source.value.toLocaleLowerCase("en").includes(query.trim().toLocaleLowerCase("en"))).slice().reverse();
  const name = candidate?.source.value;
  function copy() {
    if (disabled || !name) return;
    if (replacing && confirmation !== name) { setConfirmation(name); return; }
    onUse(name);
    setConfirmation(null);
  }
  return <section className={styles.picker} aria-label="Your names">
    <h3>Your names</h3>
    <p>Choose a name from your Names workshop. Its original entry stays in your library.</p>
    {!snapshot.loaded ? <p role="status">Loading names…</p> : !snapshot.data.candidates.length ? <p>No names in your account yet. Save or favorite a name in the Names workshop first.</p> : <>
      <label htmlFor={`${id}-search`}>Search your names</label>
      <input id={`${id}-search`} type="search" value={query} maxLength={160} onChange={event => { setQuery(event.target.value); setSelected(""); setConfirmation(null); }} disabled={disabled} />
      <label htmlFor={`${id}-name`}>Name</label>
      <select id={`${id}-name`} value={selected} disabled={disabled} onChange={event => { setSelected(event.target.value); setConfirmation(null); }}>
        <option value="">Choose a name</option>
        {choices.map(item => <option key={item.source.id} value={item.source.id}>{item.source.value}{item.favorite ? " · Favorite" : item.saved ? " · Saved" : ""}</option>)}
      </select>
      <p>{choices.length} matching names.</p>
      {confirmation && confirmation === name && replacing ? <div role="alert"><p>Replace the current name input with “{name}”? Other settings and the original name entry will stay unchanged.</p><div className={styles.actions}><button type="button" className="button secondary small" disabled={disabled} onClick={() => setConfirmation(null)}>Keep current input</button><button type="button" className="button primary small" disabled={disabled} onClick={copy}>Replace with this name</button></div></div> : <button type="button" className="button secondary small" disabled={disabled || !name} onClick={copy}>Use this name</button>}
    </>}
    {snapshot.storage !== "available" && <p role="status">{snapshot.error} Unsaved changes are kept in this tab.</p>}
  </section>;
}

export function BrowserNameDialog({ onUse, disabled = false, replacing = false, label = "From name library" }: {
  onUse: (name: string) => void; disabled?: boolean; replacing?: boolean; label?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const node = dialog.current;
    if (open && !disabled && node && !node.open) node.showModal();
    else if ((!open || disabled) && node?.open) node.close();
  }, [open, disabled]);
  return <>
    <button type="button" className="text-link" disabled={disabled} onClick={() => setOpen(true)}>{label}</button>
    <dialog className={styles.dialog} ref={dialog} aria-label="Name library" onClose={() => setOpen(false)} onCancel={() => setOpen(false)} onClick={event => { if (isDialogBackdropClick(event)) setOpen(false); }}>
      <header><h2>Name library</h2><button type="button" className="button secondary small" onClick={() => setOpen(false)}>Close</button></header>
      {open && <BrowserNamePicker disabled={disabled} replacing={replacing} onUse={name => { if (!disabled) { onUse(name); setOpen(false); } }} />}
    </dialog>
  </>;
}
