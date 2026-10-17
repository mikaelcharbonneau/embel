"use client";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { AppMark } from "@/components/ui/app-mark";
import { ProjectArtwork } from "@/components/ui/project-artwork";
import { ConversationComposer } from "@/components/workspace/conversation-composer";
import { NAMING_APPROACHES, getNamingPreferencesReadiness, namingPreferencesV2Schema, type NamingDirectness, type NamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import type { ContextSnapshot } from "@/domain/projects";
import type { NamingPreferenceRevision } from "@/domain/project-naming";
import type { NamingAccount, NamingBrainMemory } from "./naming-brain-memory";
import styles from "./naming-chat.module.css";
import "@/styles/conversation.css";
import "@/styles/guided-interview.css";
import "@/styles/guided-conversation.css";

const hidden = () => null;
const directness: { id: NamingDirectness; label: string; description: string }[] = [
  { id: "direct", label: "Direct", description: "Make the offering easy to recognize." },
  { id: "suggestive", label: "Suggestive", description: "Hint at an outcome, feeling or association." },
  { id: "open_ended", label: "Open-ended", description: "Leave room for an unexpected connection." },
  { id: "all", label: "Explore all", description: "Explore across these degrees of connection." },
];
type Step = "approaches" | "directness" | "sourceLanguages" | "heritage" | "culture" | "language" | "length" | "fragments" | "review";
const questions: Record<Step, string> = {
  approaches: "Which approaches would you like to explore?", directness: "How closely should names connect to the business?",
  sourceLanguages: "Any languages or roots to draw from?", heritage: "Any people or places to draw from?", culture: "Any stories or cultural references to explore?",
  language: "Which language should the names work in?", length: "Do you have a length in mind?", fragments: "Any text to include or avoid?", review: "Ready to explore your names?",
};
function steps(value: NamingPreferencesV2): Step[] {
  return ["approaches", "directness", ...(value.approaches.some(id => id === "other_languages" || id === "classical_roots") ? ["sourceLanguages" as const] : []), ...(value.approaches.includes("people_places") ? ["heritage" as const] : []), ...(value.approaches.includes("stories_culture") ? ["culture" as const] : []), "language", "length", "fragments"];
}
function answer(step: Step, value: NamingPreferencesV2) {
  switch (step) {
    case "approaches": return NAMING_APPROACHES.filter(item => value.approaches.includes(item.id)).map(item => item.label).join(" · ");
    case "directness": return directness.find(item => item.id === value.directness)?.label ?? "Not chosen";
    case "sourceLanguages": return value.sourceLanguages.filter(Boolean).join(" · ") || "Open to relevant languages and roots";
    case "heritage": return value.heritageNotes || "No specific people or places";
    case "culture": return value.culturalNotes || "No specific cultural references";
    case "language": return value.creativeLocale;
    case "length": return value.minimumGraphemes === null && value.maximumGraphemes === null ? "Flexible length" : `${value.minimumGraphemes ?? 1}–${value.maximumGraphemes ?? 160} characters`;
    case "fragments": return [value.requiredText.filter(Boolean).length ? `Include: ${value.requiredText.filter(Boolean).join(", ")}` : "No required text", value.excludedText.filter(Boolean).length ? `Avoid: ${value.excludedText.filter(Boolean).join(", ")}` : "No excluded text"].join(" · ");
    case "review": return "";
  }
}
export function NamingRecoveryNotice({ memory, account }: { memory: NamingBrainMemory; account: NamingAccount }) {
  const read = useCallback(() => memory.getRecovery(account), [memory, account]);
  const recovery = useSyncExternalStore(memory.subscribe, read, hidden);
  if (!recovery) return null;
  return <div className="project-naming-notice" role="status"><strong>Unfinished Naming work is available</strong><p>Recover it into this verified account to check the saved version and confirm any unfinished request.</p><div className="project-naming-actions"><button type="button" className="button secondary small" onClick={() => memory.recover(account)}>Recover my Naming work</button><button type="button" className="text-link" onClick={() => memory.discardRecovery(account)}>Use saved account work</button></div></div>;
}
function Assistant({ children }: { children: ReactNode }) {
  return <div className="guided-assistant-message"><div className="guided-assistant-identity"><AppMark /><span>Embel</span></div>{children}</div>;
}
export function NamingApproachWidgets({ memory, account, projectId, context, saved, blocked, runtimeReady, exploring = false, canSteer = false, onSteer, onContinue, onCheckSaved }: {
  memory: NamingBrainMemory; account: NamingAccount; projectId: string; context: ContextSnapshot; saved: NamingPreferenceRevision | null;
  blocked: boolean; runtimeReady: boolean; exploring?: boolean; canSteer?: boolean; onSteer?: (ids: string[], instruction: string | null) => Promise<boolean>; onContinue: () => Promise<boolean>; onCheckSaved?: () => void;
}) {
  const read = useCallback(() => memory.get(account, projectId), [memory, account, projectId]);
  const record = useSyncExternalStore(memory.subscribe, read, hidden), state = record?.preferences;
  const connected = Boolean(state);
  const initial = saved?.preferences.version === 2 ? saved.preferences : null;
  const [step, setStep] = useState<Step>(() => initial?.approaches.length ? initial.directness ? "review" : "directness" : "approaches");
  const [completed, setCompleted] = useState<Step[]>(() => initial ? initial.directness && initial.approaches.length ? steps(initial) : initial.approaches.length ? ["approaches"] : [] : []);
  const [working, setWorking] = useState(false), [composerError, setComposerError] = useState<string | undefined>();
  const lock = useRef(false), revisiting = useRef(false), active = useRef<HTMLDivElement>(null), transcript = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => memory.connectPreferences(account, projectId, saved, context), [memory, account, projectId, saved, context]);
  useEffect(() => {
    const area = transcript.current, target = active.current;
    if (area && target) area.scrollTo?.({ top: Math.max(0, area.scrollTop + target.getBoundingClientRect().top - area.getBoundingClientRect().top - 20), behavior: "instant" });
  }, [step, connected, exploring]);
  if (!state || !record) return <p role="status">Loading Naming choices…</p>;
  const value = state.draft, sequence = steps(value), instruction = record.steeringDraft.instruction, seeds = record.steeringDraft.candidateIds;
  const parsed = namingPreferencesV2Schema.safeParse({ ...value, sourceLanguages: value.sourceLanguages.filter(item => item.trim()), requiredText: value.requiredText.filter(item => item.trim()), excludedText: value.excludedText.filter(item => item.trim()) });
  const readiness = parsed.success ? getNamingPreferencesReadiness(parsed.data) : { ready: false, missing: [] };
  const patch = (next: Partial<NamingPreferencesV2>) => memory.editPreferences(account, projectId, { ...value, ...next });
  const invalid = !parsed.success || step === "approaches" && !value.approaches.length || step === "directness" && !value.directness || step === "fragments" && !readiness.ready;
  const saveBlocked = state.status === "error" || state.status === "conflict";
  async function confirm() {
    if (lock.current || blocked || invalid || saveBlocked) return;
    lock.current = true; setWorking(true);
    try {
      if (!await memory.flushPreferences(account, projectId) || !memory.isCurrent(account)) return;
      const nextCompleted = [...new Set([...completed, step])]; setCompleted(nextCompleted);
      const next = revisiting.current ? sequence.find(item => !nextCompleted.includes(item)) : sequence[sequence.indexOf(step) + 1];
      revisiting.current = false; setStep(next ?? "review");
      requestAnimationFrame(() => active.current?.querySelector<HTMLElement>("h2")?.focus());
    } finally { lock.current = false; if (memory.isCurrent(account)) setWorking(false); }
  }
  async function proceed() {
    if (lock.current || blocked || !runtimeReady || !readiness.ready || saveBlocked) return;
    lock.current = true; setWorking(true);
    try { if (await memory.flushPreferences(account, projectId) && memory.isCurrent(account)) await onContinue(); }
    finally { lock.current = false; if (memory.isCurrent(account)) setWorking(false); }
  }
  async function send() {
    if (lock.current || blocked || !instruction.trim() && !seeds.length || saveBlocked) return;
    lock.current = true; setWorking(true); setComposerError(undefined);
    const sent = instruction;
    try {
      if (seeds.length) {
        if (!canSteer || !onSteer) { setComposerError("Return to exploration and save your choices before sending a direction for these names."); return; }
        await onSteer(seeds, instruction.trim() || null); return;
      }
      // Guidance is an actual saved preference, never an invented chat reply.
      // An uncertain save already contains this suffix and must replay without duplicating it.
      const notes = value.notes === instruction.trim() || value.notes.endsWith(`\n\n${instruction.trim()}`) ? value.notes : [value.notes, instruction.trim()].filter(Boolean).join("\n\n");
      if (notes.length > 2000) { setComposerError("Naming guidance can contain 2,000 characters. Edit the saved guidance below to make room."); return; }
      patch({ notes });
      if (await memory.flushPreferences(account, projectId) && memory.isCurrent(account)) memory.setSteeringDraft(account, projectId, draft => ({ ...draft, instruction: draft.instruction === sent ? "" : draft.instruction }));
    } finally { lock.current = false; if (memory.isCurrent(account)) setWorking(false); }
  }
  function revisit(next: Step) { revisiting.current = true; setStep(next); requestAnimationFrame(() => active.current?.querySelector<HTMLElement>("h2")?.focus()); }
  return <section className={`naming-approach-widgets ${styles.conversation}`} aria-label="Naming choices">
    <div ref={transcript} className={`guided-interview-scroll ${styles.transcript}`} data-naming-chat-scroll tabIndex={0} aria-label="Naming conversation messages">
      <NamingRecoveryNotice memory={memory} account={account} />
      <details className={styles.context}><summary>Saved project context</summary><p>{context.description}</p><p>Saved brand personality: {context.personality ? Object.entries(context.personality).filter(([, weight]) => weight > 0).map(([dimension, weight]) => `${dimension}: ${weight}`).join(" · ") : "Not specified"}</p><p>Audience: {context.audienceSegments.filter(segment => segment.selected).map(segment => segment.label).join(", ") || context.knownAudience || "Not specified"}</p><p>Offering: {context.offering || "Not specified"}</p><p>Positioning: {context.positioning || "Not specified"}</p><Link className="text-link" href={`/brands/account/${projectId}`}>Open the Strategy conversation</Link></details>
      {saved?.preferences.version === 1 ? <details className={styles.context} aria-label="Earlier Naming choices"><summary>Earlier Naming choices · v{saved.version}</summary><p>Creative language: {saved.preferences.creativeLocale}</p><p>Length: {saved.preferences.minimumGraphemes ?? "Flexible"}–{saved.preferences.maximumGraphemes ?? "Flexible"} characters</p><p>{saved.preferences.notes}</p><p>Earlier choices stay saved. New approaches and directness have not been chosen.</p></details> : null}
      <Assistant><p className="guided-assistant-copy">{exploring ? "Your choices guide this exploration. Open a name for its story, save your favorites, or refine your direction here." : "Let’s find a name that feels right. Your saved project context is here; we’ll shape the naming direction one choice at a time."}</p></Assistant>
      {sequence.filter(item => completed.includes(item) && item !== step).map(item => <section className={`guided-choice-answer ${styles.answer}`} key={item} aria-label={`Your answer: ${questions[item]}`}><div className="guided-choice-answer-copy"><h3>{questions[item]}</h3><p>{answer(item, value)}</p></div><button type="button" className="text-link" disabled={blocked || working} aria-label={`Edit answer: ${questions[item]}`} onClick={() => revisit(item)}>Edit</button></section>)}
      <div ref={active} className={styles.active}>
        <Assistant><h2 id="project-naming-preferences-heading" tabIndex={-1}>{questions[step]}</h2>
          {step === "approaches" ? <div className="guided-choice-widget"><p className={styles.hint}>Choose as many as you like. Each approach leaves room for unusual connections.</p><div className="naming-approach-options" role="group" aria-label="Naming approaches">{NAMING_APPROACHES.map(approach => <button type="button" key={approach.id} className="naming-approach-option" aria-pressed={value.approaches.includes(approach.id)} disabled={blocked || working} onClick={() => patch({ approaches: value.approaches.includes(approach.id) ? value.approaches.filter(item => item !== approach.id) : [...value.approaches, approach.id] })}><strong>{approach.label}</strong><span>{approach.description}</span>{approach.id === "real_words" ? <span>Explore metaphor, symbolism and unexpected associations.</span> : null}{approach.examples.length ? <small>{approach.examples.join(", ")}</small> : null}</button>)}</div></div> : null}
          {step === "directness" ? <fieldset className="naming-directness" role="radiogroup" aria-label="Name directness"><legend className="sr-only">{questions.directness}</legend>{directness.map((choice, index) => <button tabIndex={value.directness === choice.id || value.directness === null && index === 0 ? 0 : -1} onKeyDown={event => { const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0; if (!delta && event.key !== "Home" && event.key !== "End") return; event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? directness.length - 1 : (index + delta + directness.length) % directness.length; patch({ directness: directness[next]!.id }); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus(); }} role="radio" type="button" key={choice.id} aria-checked={value.directness === choice.id} disabled={blocked || working} onClick={() => patch({ directness: choice.id })}><strong>{choice.label}</strong><span>{choice.description}</span></button>)}</fieldset> : null}
          {step === "sourceLanguages" ? <label className={styles.field}>Source languages <small>Optional · one per line</small><textarea rows={3} maxLength={960} value={value.sourceLanguages.join("\n")} disabled={blocked} onChange={event => patch({ sourceLanguages: event.target.value.split("\n") })} placeholder="For example, French or Latin" /></label> : null}
          {step === "heritage" ? <label className={styles.field}>Heritage and places <small>Optional</small><textarea rows={3} maxLength={2000} value={value.heritageNotes} disabled={blocked} onChange={event => patch({ heritageNotes: event.target.value })} placeholder="Connections you want to explore" /></label> : null}
          {step === "culture" ? <label className={styles.field}>Stories and cultural references <small>Optional</small><textarea rows={3} maxLength={2000} value={value.culturalNotes} disabled={blocked} onChange={event => patch({ culturalNotes: event.target.value })} placeholder="References or traditions that matter to you" /></label> : null}
          {step === "language" ? <label className={styles.field}>Creative language<input aria-label="Creative language" value={value.creativeLocale} maxLength={30} disabled={blocked} onChange={event => patch({ creativeLocale: event.target.value })} /><small>Inherited from your saved project. You can change it here.</small></label> : null}
          {step === "length" ? <div className={styles.field}><p>Keep this flexible, or set a range.</p><div className="project-naming-lengths"><label>Minimum characters<input type="number" min={1} max={160} step={1} value={value.minimumGraphemes ?? ""} disabled={blocked} onChange={event => patch({ minimumGraphemes: event.target.value === "" ? null : Number(event.target.value) })} /></label><label>Maximum characters<input type="number" min={1} max={160} step={1} value={value.maximumGraphemes ?? ""} disabled={blocked} onChange={event => patch({ maximumGraphemes: event.target.value === "" ? null : Number(event.target.value) })} /></label></div><small>Counts complete written characters, including combined letters and emoji.</small></div> : null}
          {step === "fragments" ? <div className={styles.field}><label>Include these text fragments<textarea rows={2} maxLength={3200} value={value.requiredText.join("\n")} disabled={blocked} onChange={event => patch({ requiredText: event.target.value.split("\n") })} /></label><label>Exclude these text fragments<textarea rows={2} maxLength={3200} value={value.excludedText.join("\n")} disabled={blocked} onChange={event => patch({ excludedText: event.target.value.split("\n") })} /></label><small>Optional · one per line. Matches include parts of words and ignore case; accents and punctuation still matter.</small></div> : null}
          {step === "review" ? <p className="guided-assistant-copy">{exploring ? "Edit any answer to change the direction for upcoming names. Earlier names keep their original context." : "We’ll explore 100 names across your chosen approaches. All approaches stay in play as you browse."}</p> : null}
          {readiness.missing.includes("conflicting_text") || readiness.missing.includes("impossible_length") ? <p role="alert">Review required text, excluded text and length limits so they can work together.</p> : null}
          <div className={styles.stepActions}><p className={`naming-save-status ${styles.save}`} role="status">{state.status === "saved" ? state.saved?.preferences.version === 2 ? <><ProjectArtwork name="check" />Saved</> : "Your choices save automatically" : state.status === "saving" ? "Saving…" : "Changes need attention"}</p>{step !== "review" ? <button type="button" className="button primary" disabled={blocked || working || invalid || saveBlocked} onClick={() => void confirm()}>{working ? "Saving…" : "Continue"}</button> : <button type="button" className="button primary" disabled={blocked || working || !runtimeReady || !readiness.ready || saveBlocked} onClick={() => void proceed()}>{working ? "Starting exploration…" : exploring ? "Continue exploring" : "Start exploring"}</button>}</div>
        </Assistant>
      </div>
      {value.notes ? <section className={styles.guidance} aria-label="Naming guidance"><div><strong>Naming guidance</strong><button type="button" className="text-link" onClick={() => { const input = document.getElementById(`${id}-guidance`); input?.focus(); }}>Edit</button></div><textarea id={`${id}-guidance`} aria-label="Saved Naming guidance" rows={2} maxLength={2000} value={value.notes} disabled={blocked} onChange={event => patch({ notes: event.target.value })} /><small>{state.dirty ? "Changes save automatically" : "Saved with your Naming choices"}</small></section> : null}
      {state.error ? <div className="project-naming-notice" role="alert"><p>{state.error}</p>{state.status === "conflict" ? <><button type="button" className="text-link" onClick={onCheckSaved}>Check saved choices</button><button type="button" className="button secondary small" onClick={() => memory.resolvePreferences(account, projectId, false)}>Use saved choices</button><button type="button" className="button secondary small" onClick={() => memory.resolvePreferences(account, projectId, true)}>Save my edits as the next version</button></> : <button type="button" className="button secondary small" onClick={() => void memory.flushPreferences(account, projectId, true)}>Retry saving choices</button>}</div> : null}
      {!runtimeReady ? <p className={styles.hint}>New Naming exploration is not available for this account yet. You can still edit your choices and browse saved names.</p> : null}
    </div>
    <div className={`guided-interview-compose ${styles.compose}`}>
      {seeds.length ? <div className={styles.seedSummary}><p>{seeds.length} {seeds.length === 1 ? "name" : "names"} will guide upcoming exploration.</p><button type="button" className="text-link" disabled={working} onClick={() => memory.setSteeringDraft(account, projectId, draft => ({ ...draft, candidateIds: [] }))}>Clear selection</button></div> : null}
      <ConversationComposer project value={instruction} onChange={text => { if (text.length <= 2000) { setComposerError(undefined); memory.setSteeringDraft(account, projectId, draft => ({ ...draft, instruction: text })); } else setComposerError("Keep Naming guidance within 2,000 characters."); }} onSend={() => void send()} label="Naming message" placeholder={seeds.length ? "What do you like about these names?" : "Add a thought or naming guidance…"} sendLabel={seeds.length ? "Send naming direction" : "Save naming guidance"} hint={seeds.length ? "Steers the next exploration" : "Saves guidance for upcoming names"} disabled={blocked || working || !instruction.trim() && !seeds.length || saveBlocked || Boolean(seeds.length && !canSteer)} error={composerError} />
    </div>
  </section>;
}
