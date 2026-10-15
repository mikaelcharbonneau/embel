"use client";

import { useState } from "react";
import styles from "./standalone-save-status.module.css";

type SaveState = {
  payload: unknown; workspace: unknown; status: string; dirty: boolean; pending: boolean;
  busy: boolean; saving: boolean; conflict: boolean; error: string | null; canSave: boolean;
  save: () => Promise<boolean>; reload: (discard?: boolean) => Promise<boolean>; keepChanges: () => Promise<boolean>;
};

/** Ordinary saves stay quiet; recovery appears only when the account needs attention. */
export function StandaloneSaveStatus({ state, onRecovered }: { state: SaveState; onRecovered?: () => void }) {
  const [useSaved, setUseSaved] = useState(false);
  const canRetryRead = state.status === "error" || Boolean(state.error && !state.dirty && !state.pending && !state.conflict);
  const label = !state.payload ? state.status === "loading" ? "Loading…" : "Unable to load"
    : state.conflict ? "Changes need review" : state.error ? "Changes need attention"
    : state.saving || state.dirty || state.pending ? "Saving…" : state.workspace ? "Saved" : "Changes save automatically";
  async function recover(keep: boolean) {
    const recovered = await (keep ? state.keepChanges() : state.reload(true));
    if (recovered) { setUseSaved(false); onRecovered?.(); }
  }
  return <div className={styles.status} aria-label="Save status">
    <p role="status">{label}</p>
    {state.error && <p role="alert">{state.error}</p>}
    {canRetryRead && <button className="button secondary small" type="button" disabled={state.busy} onClick={() => void state.reload()}>Retry</button>}
    {state.error && state.canSave && <button className="button secondary small" type="button" onClick={() => void state.save()}>Retry</button>}
    {state.conflict && <div className="inline-confirm">
      <p>This workspace changed elsewhere. Your changes are retained. Choose which version to keep.</p>
      <button className="button secondary small" type="button" disabled={state.busy} onClick={() => void recover(true)}>Save my changes instead</button>
      <button className="button secondary small" type="button" disabled={state.busy} onClick={() => setUseSaved(true)}>Use saved version</button>
    </div>}
    {state.conflict && useSaved && <div className="inline-confirm" role="alert">
      <p>Replace your current changes with the latest saved version?</p>
      <button className="button secondary small" type="button" disabled={state.busy} onClick={() => setUseSaved(false)}>Keep editing</button>
      <button className="button danger small" type="button" disabled={state.busy} onClick={() => void recover(false)}>Replace my changes</button>
    </div>}
  </div>;
}
