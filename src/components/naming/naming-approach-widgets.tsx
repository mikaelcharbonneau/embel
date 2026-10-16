"use client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { NAMING_APPROACHES, getNamingPreferencesReadiness, namingPreferencesV2Schema, type NamingDirectness, type NamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import type { ContextSnapshot } from "@/domain/projects";
import type { NamingPreferenceRevision } from "@/domain/project-naming";
import type { NamingAccount, NamingBrainMemory } from "./naming-brain-memory";
const hidden = () => null;
const directness: { id: NamingDirectness; label: string; description: string }[] = [
  { id: "direct", label: "Direct", description: "Make the offering easy to recognize." },
  { id: "suggestive", label: "Suggestive", description: "Hint at an outcome, feeling or association." },
  { id: "open_ended", label: "Open-ended", description: "Leave room for an unexpected connection." },
  { id: "all", label: "Explore all", description: "Explore across these degrees of connection." },
];
export function NamingRecoveryNotice({ memory, account }: { memory: NamingBrainMemory; account: NamingAccount }) {
  const read = useCallback(() => memory.getRecovery(account), [memory, account]);
  const recovery = useSyncExternalStore(memory.subscribe, read, hidden);
  if (!recovery) return null;
  return <div className="project-naming-notice" role="status"><strong>Unfinished Naming work is available</strong><p>Recover it into this verified account to check the saved version and confirm any unfinished request.</p><div className="project-naming-actions"><button type="button" className="button secondary small" onClick={() => memory.recover(account)}>Recover my Naming work</button><button type="button" className="text-link" onClick={() => memory.discardRecovery(account)}>Use saved account work</button></div></div>;
}
export function NamingApproachWidgets({ memory, account, projectId, context, saved, blocked, runtimeReady, onContinue, onCheckSaved }: {
  memory: NamingBrainMemory; account: NamingAccount; projectId: string; context: ContextSnapshot; saved: NamingPreferenceRevision | null;
  blocked: boolean; runtimeReady: boolean; onContinue: () => Promise<boolean>; onCheckSaved?: () => void;
}) {
  const read = useCallback(() => memory.get(account, projectId)?.preferences ?? null, [memory, account, projectId]);
  const state = useSyncExternalStore(memory.subscribe, read, hidden);
  const [continuing, setContinuing] = useState(false);
  useEffect(() => memory.connectPreferences(account, projectId, saved, context), [memory, account, projectId, saved, context]);
  if (!state) return <p role="status">Loading Naming choices…</p>;
  const value = state.draft;
  const parsed = namingPreferencesV2Schema.safeParse({ ...value, sourceLanguages: value.sourceLanguages.filter(item => item.trim()), requiredText: value.requiredText.filter(item => item.trim()), excludedText: value.excludedText.filter(item => item.trim()) });
  const readiness = parsed.success ? getNamingPreferencesReadiness(parsed.data) : { ready: false, missing: [] };
  const patch = (next: Partial<NamingPreferencesV2>) => memory.editPreferences(account, projectId, { ...value, ...next });
  async function proceed() {
    if (continuing || blocked || !runtimeReady || !readiness.ready) return;
    setContinuing(true);
    try { if (await memory.flushPreferences(account, projectId) && memory.isCurrent(account)) await onContinue(); }
    finally { if (memory.isCurrent(account)) setContinuing(false); }
  }
  return <section className="naming-approach-widgets" aria-label="Naming choices">
    <NamingRecoveryNotice memory={memory} account={account} />
    <div className="naming-widget-message"><span className="project-naming-eyebrow">Embel</span><h2 id="project-naming-preferences-heading" tabIndex={-1}>Which approaches would you like to explore?</h2><p>Your saved Strategy guides the names. Choose as many approaches as you like.</p>
      <details className="naming-inherited-strategy"><summary>Saved brand personality</summary><p>{context.personality ? Object.entries(context.personality).filter(([, weight]) => weight > 0).map(([dimension, weight]) => `${dimension}: ${weight}`).join(" · ") : "No brand personality has been saved. Naming uses the context you have provided."}</p></details>
    </div>
    <div className="naming-approach-options" role="group" aria-label="Naming approaches">{NAMING_APPROACHES.map(approach => <button type="button" key={approach.id} className="naming-approach-option" aria-pressed={value.approaches.includes(approach.id)} disabled={blocked} onClick={() => patch({ approaches: value.approaches.includes(approach.id) ? value.approaches.filter(id => id !== approach.id) : [...value.approaches, approach.id] })}><strong>{approach.label}</strong><span>{approach.description}</span>{approach.id === "real_words" ? <span>Explore metaphor, symbolism and unexpected associations.</span> : null}{approach.examples.length ? <small>{approach.examples.join(", ")}</small> : null}</button>)}</div>
    <fieldset className="naming-directness" role="radiogroup" aria-label="Name directness"><legend>How closely should names connect to the business?</legend>{directness.map((choice, index) => <button tabIndex={value.directness === choice.id || value.directness === null && index === 0 ? 0 : -1} onKeyDown={event => { const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0; if (!delta && event.key !== "Home" && event.key !== "End") return; event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? directness.length - 1 : (index + delta + directness.length) % directness.length; patch({ directness: directness[next]!.id }); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus(); }} role="radio" type="button" key={choice.id} aria-checked={value.directness === choice.id} disabled={blocked} onClick={() => patch({ directness: choice.id })}><strong>{choice.label}</strong><span>{choice.description}</span></button>)}</fieldset>
    {value.approaches.includes("other_languages") || value.approaches.includes("classical_roots") ? <label>Source languages <small>Optional · one per line</small><textarea aria-label="Source languages" rows={2} maxLength={960} value={value.sourceLanguages.join("\n")} disabled={blocked} onChange={event => patch({ sourceLanguages: event.target.value.split("\n") })} placeholder="For example, French or Latin" /></label> : null}
    {value.approaches.includes("people_places") ? <label>Heritage and places <small>Optional</small><textarea rows={3} maxLength={2000} value={value.heritageNotes} disabled={blocked} onChange={event => patch({ heritageNotes: event.target.value })} placeholder="Any connections you want to explore" /></label> : null}
    {value.approaches.includes("stories_culture") ? <label>Stories and cultural references <small>Optional</small><textarea rows={3} maxLength={2000} value={value.culturalNotes} disabled={blocked} onChange={event => patch({ culturalNotes: event.target.value })} placeholder="References or traditions that matter to you" /></label> : null}
    <details className="naming-optional"><summary>Language, length and other preferences</summary>
      <label>Creative language<input value={value.creativeLocale} maxLength={30} disabled={blocked} onChange={event => patch({ creativeLocale: event.target.value })} /></label>
      <div className="project-naming-lengths"><label>Minimum characters<input type="number" min={1} max={160} step={1} value={value.minimumGraphemes ?? ""} disabled={blocked} onChange={event => patch({ minimumGraphemes: event.target.value === "" ? null : Number(event.target.value) })} /></label><label>Maximum characters<input type="number" min={1} max={160} step={1} value={value.maximumGraphemes ?? ""} disabled={blocked} onChange={event => patch({ maximumGraphemes: event.target.value === "" ? null : Number(event.target.value) })} /></label></div>
      <p>Length counts complete written characters, including combined letters and emoji.</p>
      <label>Include these text fragments<textarea rows={2} maxLength={3200} value={value.requiredText.join("\n")} disabled={blocked} onChange={event => patch({ requiredText: event.target.value.split("\n") })} /></label>
      <label>Exclude these text fragments<textarea rows={2} maxLength={3200} value={value.excludedText.join("\n")} disabled={blocked} onChange={event => patch({ excludedText: event.target.value.split("\n") })} /></label><p>One fragment per line. Matches include parts of words and ignore letter case; accents and punctuation still matter.</p>
      <label>Anything else to consider?<textarea rows={3} maxLength={2000} value={value.notes} disabled={blocked} onChange={event => patch({ notes: event.target.value })} /></label>
    </details>
    <p className="naming-save-status" role="status">{state.status === "saved" ? state.saved?.preferences.version === 2 ? "Saved" : "Your choices save automatically." : state.status === "saving" ? "Saving…" : "Changes need attention"}</p>
    {state.error ? <div className="project-naming-notice" role="alert"><p>{state.error}</p>{state.status === "conflict" ? <><button type="button" className="text-link" onClick={onCheckSaved}>Check saved choices</button><button type="button" className="button secondary small" onClick={() => memory.resolvePreferences(account, projectId, false)}>Use saved choices</button><button type="button" className="button secondary small" onClick={() => memory.resolvePreferences(account, projectId, true)}>Save my edits as the next version</button></> : <button type="button" className="button secondary small" onClick={() => void memory.flushPreferences(account, projectId, true)}>Retry saving choices</button>}</div> : null}
    {readiness.missing.includes("conflicting_text") || readiness.missing.includes("impossible_length") ? <p role="alert">Review the required text, excluded text and length limits so they can work together.</p> : null}
    {!runtimeReady ? <p className="project-naming-muted">New Naming exploration is not available for this account yet. You can still edit your choices and browse saved names.</p> : null}
    <button type="button" className="button primary" disabled={blocked || continuing || !runtimeReady || !readiness.ready || state.status === "error" || state.status === "conflict"} onClick={() => void proceed()}>{continuing ? "Saving and continuing…" : "Continue"}</button>
  </section>;
}
