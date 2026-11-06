"use client";
import { NamingLengthRange } from "./naming-length-range";
import { ContextDetails } from "@/components/ui/context-details";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { GuidedThinking } from "@/components/workspace/guided-thinking";
import { projectStrategyHref } from "@/domain/project-handoff";
import { ProjectArtwork } from "@/components/ui/project-artwork";
import type { NamingComposerLayout } from "./use-naming-composer-layout";
import { FloatingComposer } from "@/components/workspace/floating-composer";
import { ConversationComposer } from "@/components/workspace/conversation-composer";
import { NAMING_APPROACHES, getNamingPreferencesReadiness, namingPreferencesV2Schema, type NamingDirectness, type NamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import { explicitNamingLanguage } from "@/domain/naming-language";
import type { ContextSnapshot } from "@/domain/projects";
import type { NamingPreferenceRevision } from "@/domain/project-naming";
import type { NamingChatCheckpoint } from "@/domain/naming-chat-checkpoint";
import type { NamingAccount, NamingBrainMemory } from "./naming-brain-memory";
import { confirmNamingChatQuestion, initialNamingChatProgress, namingChatCheckpoint, namingChatQuestions, resolveNamingChatProgress, type NamingChatStep as Step } from "./naming-chat-progress";
import { EmbelIdentity } from "@/components/workspace/embel-identity";
import { journeyPartLabel } from "@/domain/journey";
import styles from "./naming-chat.module.css";
import "@/styles/conversation.css";
import "@/styles/guided-interview.css";
import "@/styles/guided-conversation.css";

/** A saved Strategy conversation already owns the transcript and bottom composer. */
export type InlineNamingConversation = {
  messages: HTMLDivElement | null;
  composer: HTMLDivElement | null;
  onQuestion: (id: string | null) => void;
  onCanvas: (visible: boolean) => void;
};

export function inlineNamingMessage(host: InlineNamingConversation, content: ReactNode) {
  return host.messages && createPortal(content, host.messages);
}

const hidden = () => null;
const directness: { id: NamingDirectness; label: string; description: string }[] = [
  { id: "direct", label: "Direct", description: "Make the offering easy to recognize." },
  { id: "suggestive", label: "Suggestive", description: "Hint at an outcome, feeling or association." },
  { id: "open_ended", label: "Open-ended", description: "Leave room for an unexpected connection." },
  { id: "all", label: "Explore all", description: "Explore across these degrees of connection." },
];
const questions: Record<Step, string> = {
  approaches: "Which approaches would you like to explore?", directness: "How closely should names connect to the business?",
  language: "Which language should the names work in?", length: "Any length limits or text to include or avoid?", fragments: "Any text to include or avoid?", review: "Your naming direction",
};
function answer(step: Step, value: NamingPreferencesV2) {
  switch (step) {
    case "approaches": return NAMING_APPROACHES.filter(item => value.approaches.includes(item.id)).map(item => item.label).join(" · ");
    case "directness": return directness.find(item => item.id === value.directness)?.label ?? "Not chosen";
    case "language": return value.creativeLocale;
    case "length": return [(value.minimumGraphemes === null && value.maximumGraphemes === null ? "Flexible length" : `${value.minimumGraphemes ?? 1}–${value.maximumGraphemes ?? 160} characters`), value.requiredText.filter(Boolean).length ? `Include: ${value.requiredText.filter(Boolean).join(", ")}` : "No required text", value.excludedText.filter(Boolean).length ? `Avoid: ${value.excludedText.filter(Boolean).join(", ")}` : "No excluded text"].join(" · ");
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
  return <div className="guided-assistant-message"><EmbelIdentity label={journeyPartLabel("voice", "Name")} />{children}</div>;
}
export function NamingApproachWidgets({ memory, account, projectId, context, saved, savedChat, blocked, runtimeReady, exploring = false, canSteer = false, onSteer, onContinue, onCheckSaved, onSaveProgress, generationStatus, generationUnavailable = false, compact = false, onToggleConversation, composerLayout, onComposerLayoutChange, conversationHistory, inline, manualName }: {
  memory: NamingBrainMemory; account: NamingAccount; projectId: string; context: ContextSnapshot; saved: NamingPreferenceRevision | null;
  inline?: InlineNamingConversation; manualName?: ReactNode; conversationHistory?: ReactNode; compact?: boolean; onToggleConversation?: (open: boolean) => void; composerLayout?: NamingComposerLayout; onComposerLayoutChange?: (patch: Partial<NamingComposerLayout>) => void; generationStatus?: ReactNode; generationUnavailable?: boolean; savedChat?: NamingChatCheckpoint; onSaveProgress: (checkpoint: NamingChatCheckpoint) => Promise<boolean>;
  blocked: boolean; runtimeReady: boolean; exploring?: boolean; canSteer?: boolean; onSteer?: (ids: string[], instruction: string | null) => Promise<boolean>; onContinue: () => Promise<boolean>; onCheckSaved?: () => void;
}) {
  const read = useCallback(() => memory.get(account, projectId), [memory, account, projectId]);
  const record = useSyncExternalStore(memory.subscribe, read, hidden), state = record?.preferences;
  const connected = Boolean(state);
  const resolvedProgress = state ? resolveNamingChatProgress(state.draft, record?.chatProgress ?? initialNamingChatProgress(state.saved?.preferences.version === 2 ? state.saved.preferences : null)) : null;
  const step = resolvedProgress?.activeStep ?? "approaches";
  const [working, setWorking] = useState(false), [composerError, setComposerError] = useState<string | undefined>(), [progressError, setProgressError] = useState<string | null>(null);
  const lock = useRef(false), active = useRef<HTMLDivElement>(null), transcript = useRef<HTMLDivElement>(null);
  const transitionFocus = useRef<{ step: Step; from: Element | null } | null>(null);
  const id = useId();
  const questionId = `${id}-naming-${step}`;
  const embedded = Boolean(inline);
  const onInlineQuestion = inline?.onQuestion;
  useLayoutEffect(() => {
    if (!connected || !onInlineQuestion) return;
    onInlineQuestion(questionId);
    return () => onInlineQuestion(null);
  }, [connected, onInlineQuestion, questionId]);
  const [appliedChoices, setAppliedChoices] = useState<string | null>(null);
  useEffect(() => memory.connectPreferences(account, projectId, saved, context, savedChat), [memory, account, projectId, saved, context, savedChat]);
  useLayoutEffect(() => {
    const transition = transitionFocus.current;
    if (!transition || transition.step !== step) return;
    transitionFocus.current = null;
    // Announce the committed question before paint. A save may have been pending
    // while the user moved to the composer, so only retain the original focus intent.
    if (document.activeElement === transition.from || document.activeElement === document.body) active.current?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: embedded });
  }, [step, embedded]);
  useEffect(() => {
    const area = transcript.current, target = active.current;
    if (!embedded && area && target) area.scrollTo?.({ top: Math.max(0, area.scrollTop + target.getBoundingClientRect().top - area.getBoundingClientRect().top - 20), behavior: "instant" });
  }, [step, connected, exploring, embedded]);
  if (!state || !record || !resolvedProgress) return inline ? inlineNamingMessage(inline, <GuidedThinking label="Opening naming choices…" />) : <p role="status">Loading Naming choices…</p>;
  const appliedVersion = record.feed.feed?.activeRun?.preferencesVersion ?? record.feed.feed?.preferencesVersion;
  if (appliedChoices === null) setAppliedChoices(JSON.stringify(state.saved?.preferences ?? state.draft));
  const hasUpdatedChoices = JSON.stringify(state.draft) !== (appliedChoices ?? JSON.stringify(state.saved?.preferences ?? state.draft)) || Boolean(appliedVersion !== undefined && state.saved && state.saved.version !== appliedVersion);
  const progress = resolvedProgress;
  const value = state.draft, sequence = namingChatQuestions(), instruction = record.steeringDraft.instruction, seeds = record.steeringDraft.candidateIds;
  const parsed = namingPreferencesV2Schema.safeParse({ ...value, sourceLanguages: value.sourceLanguages.filter(item => item.trim()), requiredText: value.requiredText.filter(item => item.trim()), excludedText: value.excludedText.filter(item => item.trim()) });
  const readiness = parsed.success ? getNamingPreferencesReadiness(parsed.data) : { ready: false, missing: [] };
  const patch = (next: Partial<NamingPreferencesV2>) => memory.editPreferences(account, projectId, { ...value, ...next });
  const invalid = !parsed.success || step === "approaches" && !value.approaches.length || step === "directness" && !value.directness || step === "length" && !readiness.ready;
  const saveBlocked = state.status === "error" || state.status === "conflict";
  async function confirm() {
    if (lock.current || blocked || invalid || saveBlocked || step === "review") return;
    const focusFrom = document.activeElement;
    lock.current = true; setWorking(true); setProgressError(null);
    try {
      if (!await memory.flushPreferences(account, projectId) || !memory.isCurrent(account)) return;
      const acknowledged = memory.get(account, projectId)?.preferences?.saved;
      if (acknowledged?.preferences.version !== 2) return;
      const next = confirmNamingChatQuestion(progress, step, acknowledged.preferences);
      if (!await onSaveProgress(namingChatCheckpoint(next, acknowledged.preferences, acknowledged.version))) {
        if (memory.isCurrent(account)) setProgressError("This answer could not be confirmed as saved. Check saved choices, then continue again. Your choices are kept.");
        return;
      }
      if (!memory.isCurrent(account)) return;
      transitionFocus.current = { step: next.activeStep, from: focusFrom };
      memory.setChatProgress(account, projectId, next);
      // Generation is part of submitting the last answer, not a second CTA.
      // Only this acknowledged user action may start it; reloads never dispatch.
      if (step === "length" && next.activeStep === "review" && !exploring && runtimeReady) {
        if (!await onContinue() && memory.isCurrent(account)) setProgressError("Your choices are saved, but generation has not started. Check the request status below before retrying.");
      }
    } catch {
      if (memory.isCurrent(account)) setProgressError("This answer could not be confirmed as saved. Check saved choices, then continue again. Your choices are kept.");
    } finally { lock.current = false; if (memory.isCurrent(account)) setWorking(false); }
  }
  async function proceed() {
    if (lock.current || blocked || !runtimeReady || !readiness.ready || saveBlocked || step !== "review" || sequence.some(question => !progress.confirmed[question])) return;
    lock.current = true; setWorking(true);
    try { if (await memory.flushPreferences(account, projectId) && memory.isCurrent(account)) { if (await onContinue()) setAppliedChoices(JSON.stringify(value)); } }
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
      const requestedLanguage = explicitNamingLanguage(instruction);
      patch({ notes, ...(requestedLanguage ? { creativeLocale: requestedLanguage } : {}) });
      if (await memory.flushPreferences(account, projectId) && memory.isCurrent(account)) memory.setSteeringDraft(account, projectId, draft => ({ ...draft, instruction: draft.instruction === sent ? "" : draft.instruction }));
    } finally { lock.current = false; if (memory.isCurrent(account)) setWorking(false); }
  }
  function revisit(next: Step) { transitionFocus.current = { step: next, from: document.activeElement }; memory.setChatProgress(account, projectId, { ...progress, activeStep: next }); }
  const messages = <>
      {!inline && conversationHistory}
      <NamingRecoveryNotice memory={memory} account={account} />
      {!inline && <ContextDetails className={styles.context} title={<>Saved project context</>}><p>{context.description}</p><p>Saved brand personality: {context.personality ? Object.entries(context.personality).filter(([, weight]) => weight > 0).map(([dimension, weight]) => `${dimension}: ${weight}`).join(" · ") : "Not specified"}</p><p>Audience: {context.audienceSegments.filter(segment => segment.selected).map(segment => segment.label).join(", ") || context.knownAudience || "Not specified"}</p><p>Offering: {context.offering || "Not specified"}</p><p>Positioning: {context.positioning || "Not specified"}</p><Link className="text-link" href={projectStrategyHref(projectId)}>Open the Strategy conversation</Link></ContextDetails>}
      {saved?.preferences.version === 1 ? <ContextDetails className={styles.context} aria-label="Earlier Naming choices" title={<>Earlier Naming choices · v{saved.version}</>}><p>Creative language: {saved.preferences.creativeLocale}</p><p>Length: {saved.preferences.minimumGraphemes ?? "Flexible"}–{saved.preferences.maximumGraphemes ?? "Flexible"} characters</p><p>{saved.preferences.notes}</p><p>Earlier choices stay saved. New approaches and directness have not been chosen.</p></ContextDetails> : null}
      {!inline && <Assistant><p className="guided-assistant-copy">{exploring ? "Your choices guide this exploration. Open a name for its story, save your favorites, or refine your direction here." : "Let’s find a name that feels right. Your saved project context is here; we’ll shape the naming direction one choice at a time."}</p></Assistant>}
      {sequence.filter(item => progress.confirmed[item] && item !== step).map(item => <section className={`guided-choice-answer ${styles.answer}`} key={item} aria-label={`Your answer: ${questions[item]}`}><div className="guided-choice-answer-copy"><h3>{questions[item]}</h3><p>{answer(item, value)}</p></div><button type="button" className="text-link" disabled={blocked || working} aria-label={`Edit answer: ${questions[item]}`} onClick={() => revisit(item)}>Edit</button></section>)}
      <div ref={active} id={inline ? questionId : undefined} tabIndex={inline ? -1 : undefined} className={`${styles.active}${inline ? " flow-enter " + styles.inlineTurn : ""}`}>
        <Assistant><div className={inline ? styles.questionCard : undefined}><h2 id="project-naming-preferences-heading" tabIndex={-1}>{questions[step]}</h2>
          {step === "approaches" ? <div className="guided-choice-widget"><p className={styles.hint}>Choose as many as you like. Each approach leaves room for unusual connections.</p><div className="naming-approach-options" role="group" aria-label="Naming approaches">{NAMING_APPROACHES.map(approach => <button type="button" key={approach.id} className="naming-approach-option" aria-pressed={value.approaches.includes(approach.id)} disabled={blocked || working} onClick={() => patch({ approaches: value.approaches.includes(approach.id) ? value.approaches.filter(item => item !== approach.id) : [...value.approaches, approach.id] })}><strong>{approach.label}</strong><span>{approach.description}</span>{approach.id === "real_words" ? <span>Explore metaphor, symbolism and unexpected associations.</span> : null}{approach.examples.length ? <small>{approach.examples.join(", ")}</small> : null}</button>)}</div></div> : null}
          {step === "directness" ? <fieldset className="naming-directness" role="radiogroup" aria-label="Name directness"><legend className="sr-only">{questions.directness}</legend>{directness.map((choice, index) => <button tabIndex={value.directness === choice.id || value.directness === null && index === 0 ? 0 : -1} onKeyDown={event => { const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0; if (!delta && event.key !== "Home" && event.key !== "End") return; event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? directness.length - 1 : (index + delta + directness.length) % directness.length; patch({ directness: directness[next]!.id }); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus(); }} role="radio" type="button" key={choice.id} aria-checked={value.directness === choice.id} disabled={blocked || working} onClick={() => patch({ directness: choice.id })}><strong>{choice.label}</strong><span>{choice.description}</span></button>)}</fieldset> : null}

          {step === "length" && <div className={styles.lengthForm}>
            <NamingLengthRange value={value} disabled={blocked || working} onChange={patch} />
            <div className={styles.fragmentFields}>
              <label>Text to include <span>(optional)</span>
                <textarea rows={2} maxLength={3200} value={value.requiredText.join("\n")} disabled={blocked || working} aria-describedby={`${id}-fragments`} onChange={event => patch({ requiredText: event.target.value.split("\n") })} />
              </label>
              <label>Text to avoid <span>(optional)</span>
                <textarea rows={2} maxLength={3200} value={value.excludedText.join("\n")} disabled={blocked || working} aria-describedby={`${id}-fragments`} onChange={event => patch({ excludedText: event.target.value.split("\n") })} />
              </label>
            </div>
            <p id={`${id}-fragments`} className={styles.hint}>Enter one fragment per line. Matches include parts of words and ignore case. Accents and punctuation still matter.</p>
          </div>}
          {step === "review" && !generationUnavailable ? <p className="guided-assistant-copy">{exploring ? "Edit any answer to change the direction for upcoming names. Earlier names keep their original context." : "Your naming choices are saved and ready to use."}</p> : null}
          {readiness.missing.includes("conflicting_text") || readiness.missing.includes("impossible_length") ? <p role="alert">Review required text, excluded text and length limits so they can work together.</p> : null}
          <div className={styles.stepActions}><p className={`naming-save-status ${styles.save}`} role="status">{state.status === "saved" ? state.saved?.preferences.version === 2 ? <><ProjectArtwork name="check" />Saved</> : "Your choices save automatically" : state.status === "saving" ? "Saving…" : "Changes need attention"}</p>{step !== "review" ? <button type="button" className="button primary" disabled={blocked || working || invalid || saveBlocked} onClick={() => void confirm()}>{working ? "Saving…" : "Continue"}</button> : !generationUnavailable && (!exploring || hasUpdatedChoices) ? <button type="button" className="button primary" disabled={blocked || working || !runtimeReady || !readiness.ready || saveBlocked} onClick={() => void proceed()}>{working ? "Checking generation…" : exploring ? "Apply updated choices" : record.feed.pending || record.feed.outcome || record.feed.error ? "Retry generation" : "Generate names"}</button> : null}</div>
          {step === "review" && generationUnavailable && generationStatus}
        </div></Assistant>
      </div>
      {value.notes ? <section className={styles.guidance} aria-label="Naming guidance"><div><strong>Naming guidance</strong><button type="button" className="text-link" onClick={() => { const input = document.getElementById(`${id}-guidance`); input?.focus(); }}>Edit</button></div><textarea id={`${id}-guidance`} aria-label="Saved Naming guidance" rows={2} maxLength={2000} value={value.notes} disabled={blocked} onChange={event => patch({ notes: event.target.value })} /><small>{state.dirty ? "Changes save automatically" : "Saved with your Naming choices"}</small></section> : null}
      {step === "review" && !generationUnavailable && generationStatus}
      {progressError ? <div className="project-naming-notice" role="alert"><p>{progressError}</p><button type="button" className="text-link" onClick={onCheckSaved}>Check saved choices</button></div> : null}
      {state.error ? <div className="project-naming-notice" role="alert"><p>{state.error}</p>{state.status === "conflict" ? <><button type="button" className="text-link" onClick={onCheckSaved}>Check saved choices</button><button type="button" className="button secondary small" onClick={() => memory.resolvePreferences(account, projectId, false)}>Use saved choices</button><button type="button" className="button secondary small" onClick={() => memory.resolvePreferences(account, projectId, true)}>Save my edits as the next version</button></> : <button type="button" className="button secondary small" onClick={() => void memory.flushPreferences(account, projectId, true)}>Retry saving choices</button>}</div> : null}
      {step !== "review" && generationUnavailable && <p className={styles.hint}>You can finish your choices while name generation is unavailable.</p>}
      {inline && manualName && <details className={styles.inlineManual}><summary>Add your own name</summary>{manualName}</details>}
    </>;
  const composer = <>
      {seeds.length ? <div className={styles.seedSummary}><p>{seeds.length} {seeds.length === 1 ? "name" : "names"} will guide upcoming exploration.</p><button type="button" className="text-link" disabled={working} onClick={() => memory.setSteeringDraft(account, projectId, draft => ({ ...draft, candidateIds: [] }))}>Clear selection</button></div> : null}
      <ConversationComposer project value={instruction} onChange={text => { if (text.length <= 2000) { setComposerError(undefined); memory.setSteeringDraft(account, projectId, draft => ({ ...draft, instruction: text })); } else setComposerError("Keep Naming guidance within 2,000 characters."); }} onSend={() => void send()} label="Naming message" placeholder={seeds.length ? "What do you like about these names?" : "Add a thought or naming guidance…"} sendLabel={seeds.length ? "Send naming direction" : "Save naming guidance"} hint={seeds.length ? "Steers the next exploration" : inline || compact ? null : "Saves guidance for upcoming names"} disabled={blocked || working || !instruction.trim() && !seeds.length || saveBlocked || Boolean(seeds.length && !canSteer)} error={composerError} />
    </>;
  if (inline) return <>{inlineNamingMessage(inline, messages)}{inline.composer && createPortal(composer, inline.composer)}</>;
  const chatHistory = <div ref={transcript} className={`guided-interview-scroll ${styles.transcript}`}
    data-naming-chat-scroll tabIndex={0} aria-label="Naming conversation messages">{messages}</div>;
  return <section className={`naming-approach-widgets ${styles.conversation}`} aria-label="Naming choices">
    {!compact && chatHistory}
    <FloatingComposer label="Naming composer" history={compact ? chatHistory : undefined}
      expanded={compact && (composerLayout?.expanded ?? true)} onExpandedChange={onToggleConversation}
      defaultPosition={composerLayout?.position} onPositionChange={position => onComposerLayoutChange?.({ position })}
      minimized={composerLayout?.minimized} onMinimizedChange={minimized => onComposerLayoutChange?.({ minimized })} expandLabel="Open chat" collapseLabel="Close chat">
      {composer}
    </FloatingComposer>
  </section>;
}
