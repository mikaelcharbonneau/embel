"use client";

import { useId, useState } from "react";
import { Icon } from "@/components/ui/icon";
import type { GuidedReply } from "@/domain/guided-interview";

type SloganReply = Extract<GuidedReply, { kind: "choices" }>;
export type SloganDecision = { optionId: string } | { own: string };

/** Voice · Slogan (optional). Choosing a line or writing your own only
 * selects it; Continue saves the decision and Skip for now saves none. */
export function GuidedSloganWidget({ reply, brandName, disabled = false, answered, answer, onContinue, onSkip, onMore, canMore = false, onRevisit }: {
  reply: SloganReply; brandName: string; disabled?: boolean;
  /** Set once decided: the saved slogan, null when skipped, undefined when newer suggestions replaced these. */
  answered?: boolean; answer?: string | null;
  onContinue: (decision: SloganDecision) => void; onSkip: () => void; onMore?: () => void; canMore?: boolean; onRevisit?: () => void;
}) {
  const id = useId();
  const [chosen, setChosen] = useState<string | "own" | null>(null);
  const [own, setOwn] = useState("");
  const slogans = reply.options.flatMap(option => option.stage === "slogan" ? [{ id: option.id, text: option.payload.slogan }] : []);

  if (answered) return <section className="guided-choice-answer" aria-labelledby={`${id}-question`}>
    <div className="guided-choice-answer-copy">
      <h3 id={`${id}-question`}>{reply.question}</h3>
      {answer ? <ul aria-label="Your answer"><li><Icon name="check" size={13} /><span>{answer}</span></li></ul>
        : <p>{answer === null ? "Skipped for now. You can add a slogan later." : "Newer suggestions are below."}</p>}
    </div>
    {onRevisit && <button className="button secondary small" type="button" disabled={disabled} aria-label={`Edit your answer: ${reply.question}`} onClick={onRevisit}>Edit answer</button>}
  </section>;

  const ownText = own.trim();
  const preview = chosen === "own" ? ownText : slogans.find(item => item.id === chosen)?.text ?? "";
  const ready = chosen === "own" ? ownText.length > 0 : Boolean(chosen);
  return <fieldset className="guided-slogan-widget" aria-describedby={`${id}-hint`}>
    <legend className="sr-only">{reply.question}</legend>
    <section className="guided-slogan-preview" aria-label="Preview">
      <span className="guided-slogan-preview-label">Preview</span>
      <span className="guided-slogan-preview-name">{brandName}</span>
      <span className={`guided-slogan-preview-line${preview ? "" : " is-empty"}`} role="status">{preview || (chosen === "own" ? "Your slogan will appear here" : "No slogan yet")}</span>
    </section>
    <div className="guided-choice-intro">
      <h3 aria-hidden="true">{reply.question}</h3>
      <p id={`${id}-hint`}>Choose one, write your own, or skip for now.</p>
    </div>
    <div className="guided-slogan-options">
      {slogans.map(item => <label key={item.id} className={`guided-slogan-option${chosen === item.id ? " is-selected" : ""}`}>
        <input type="radio" name={`${id}-slogan`} checked={chosen === item.id} disabled={disabled} onChange={() => setChosen(item.id)} />
        <span>{item.text}</span>
      </label>)}
    </div>
    <div className={`guided-slogan-own${chosen === "own" ? " is-selected" : ""}`}>
      <input id={`${id}-own-choice`} type="radio" name={`${id}-slogan`} checked={chosen === "own"} disabled={disabled} onChange={() => setChosen("own")} aria-label="Use your own slogan" />
      <label htmlFor={`${id}-own`} className="sr-only">Your own slogan</label>
      <input id={`${id}-own`} type="text" maxLength={120} value={own} disabled={disabled} placeholder="Write your own slogan…" onChange={event => { setOwn(event.target.value); setChosen("own"); }} />
    </div>
    <div className="guided-choice-actions">
      {onMore && <button type="button" className="button secondary small guided-slogan-more" disabled={disabled || !canMore} onClick={onMore}><Icon name="refresh" size={14} />More slogans</button>}
      <span className="guided-choice-count">Next: Identity</span>
      <button type="button" className="button secondary" disabled={disabled} onClick={onSkip}>Skip for now</button>
      <button type="button" className="button primary" disabled={disabled || !ready} onClick={() => {
        if (disabled || !ready) return;
        onContinue(chosen === "own" ? { own: ownText } : { optionId: chosen! });
      }}>Continue<Icon name="arrow" size={14} /></button>
    </div>
  </fieldset>;
}
