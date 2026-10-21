"use client";
import { ContextDetails } from "@/components/ui/context-details";

import { useState, type FormEvent } from "react";
import { namingPreferencesSchema, type NamingPreferences } from "@/domain/project-naming";
import { Icon } from "@/components/ui/icon";

export function parseNamingPreferenceFields(fields: { locale: string; notes: string; minimum: string; maximum: string }, fallbackLocale: string): NamingPreferences {
  const length = (value: string) => value.trim() === "" ? null : Number(value);
  return namingPreferencesSchema.parse({ version: 1, creativeLocale: fields.locale.trim() || fallbackLocale, notes: fields.notes, minimumGraphemes: length(fields.minimum), maximumGraphemes: length(fields.maximum) });
}

export function NamingPreferencesPanel({ initial, savedVersion, pending, blocked, onSave, onClose }: {
  initial: NamingPreferences;
  savedVersion: number;
  pending: boolean;
  blocked: boolean;
  onSave: (preferences: NamingPreferences, expectedVersion: number) => Promise<boolean>;
  onClose: () => void;
}) {
  const [fields, setFields] = useState({ locale: initial.creativeLocale, notes: initial.notes, minimum: initial.minimumGraphemes?.toString() ?? "", maximum: initial.maximumGraphemes?.toString() ?? "" });
  const [expectedVersion, setExpectedVersion] = useState(savedVersion);
  const [error, setError] = useState<string | null>(null);
  const conflict = expectedVersion !== savedVersion;
  function patch(next: Partial<typeof fields>) { setFields(previous => ({ ...previous, ...next })); setError(null); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || blocked || conflict) return;
    let preferences: NamingPreferences;
    try { preferences = parseNamingPreferenceFields(fields, initial.creativeLocale); }
    catch { setError("Use a language label of 2–30 characters and optional whole-number lengths from 1 to 160. Minimum length cannot exceed maximum length."); return; }
    setError(null);
    if (await onSave(preferences, expectedVersion)) { setExpectedVersion(version => version + 1); onClose(); }
  }
  return <form className="project-naming-preferences" aria-label="Naming preferences" onSubmit={event => void submit(event)}>
    <h2 id="project-naming-preferences-heading" tabIndex={-1}>{savedVersion ? "Shape the next batch" : "What should the name feel like?"}</h2>
    <p className="project-naming-muted">{savedVersion ? "These preferences and your favorites guide future batches. Earlier names keep their original context." : "Your saved brief is the starting point. Add a direction, words to avoid, or leave room to explore."}</p>
    {conflict ? <div className="project-naming-notice" role="alert"><strong>A newer preference version is saved</strong><p>Your edits are still here. Load the saved preferences, or keep your edits for the next version.</p><div className="project-naming-actions"><button type="button" className="button secondary small" disabled={pending} onClick={() => { setFields({ locale: initial.creativeLocale, notes: initial.notes, minimum: initial.minimumGraphemes?.toString() ?? "", maximum: initial.maximumGraphemes?.toString() ?? "" }); setExpectedVersion(savedVersion); setError(null); }}>Load latest preferences</button><button type="button" className="button secondary small" disabled={pending} onClick={() => { setExpectedVersion(savedVersion); setError(null); }}>Keep my preference edits</button></div></div> : null}
    <label>Style and words to avoid <span className="project-naming-muted">· optional</span><textarea autoFocus value={fields.notes} rows={4} maxLength={2000} disabled={pending || blocked} onChange={event => patch({ notes: event.target.value })} placeholder="For example: warm and concise; avoid technical jargon" /></label>
    <ContextDetails  title={<>Language and length <span className="project-naming-muted">· optional</span></>}><label>Creative language<input value={fields.locale} maxLength={30} disabled={pending || blocked} onChange={event => patch({ locale: event.target.value })} placeholder={initial.creativeLocale} autoComplete="off" /></label><p className="project-naming-muted">Starts from the language saved with your brief.</p><div className="project-naming-lengths"><label>Minimum characters<input type="number" inputMode="numeric" min={1} max={160} step={1} value={fields.minimum} disabled={pending || blocked} onChange={event => patch({ minimum: event.target.value })} placeholder="No minimum" /></label><label>Maximum characters<input type="number" inputMode="numeric" min={1} max={160} step={1} value={fields.maximum} disabled={pending || blocked} onChange={event => patch({ maximum: event.target.value })} placeholder="No maximum" /></label></div><p className="project-naming-muted">Characters are counted as complete written characters, including combined letters and emoji.</p></ContextDetails>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="project-naming-actions">{savedVersion ? <button className="button secondary small" type="button" disabled={pending} onClick={onClose}>Keep current preferences</button> : null}<button className="button primary" type="submit" disabled={pending || blocked || conflict}>{pending ? "Saving preferences…" : savedVersion ? "Save for future batches" : "Continue to names"}<Icon name="arrow" size={15} /></button></div>
  </form>;
}
