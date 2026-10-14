"use client";

import { useId } from "react";
import { AppMark } from "@/components/ui/app-mark";
import { ProjectArtwork } from "@/components/ui/project-artwork";
import type { GuidedOption, GuidedReply } from "@/domain/guided-interview";
import { competitorWebsiteSchema } from "@/domain/projects";

type ChoiceReply = Extract<GuidedReply, { kind: "choices" }>;

export type GuidedChoiceWidgetProps = {
  reply: ChoiceReply;
  selectedIds: readonly string[];
  onSelectionChange: (ids: string[]) => void;
  onContinue: () => void;
  disabled?: boolean;
  answered?: boolean;
  onRevisit?: () => void;
};

export type ResearchLoadingScreenProps = {
  message?: string;
  onCancel?: () => void;
  cancelPending?: boolean;
};

/** A real pending research operation; its lifetime is owned by the caller. */
export function ResearchLoadingScreen({ message = "Finding relevant brands and the sources behind them.", onCancel, cancelPending = false }: ResearchLoadingScreenProps) {
  const id = useId();

  return <section className="guided-research-screen" aria-labelledby={`${id}-title`}>
    <div className="guided-research-mark" aria-hidden="true"><span className="guided-research-mark-motion"><AppMark /></span></div>
    <div className="guided-research-copy" role="status" aria-live="polite" aria-atomic="true">
      <h1 id={`${id}-title`}>{cancelPending ? "Cancelling research…" : "Researching your competitors"}</h1>
      <p>{message}</p>
    </div>
    {onCancel && <button className="button secondary small guided-research-cancel" type="button" onClick={onCancel} disabled={cancelPending}>{cancelPending ? "Cancelling…" : "Cancel research"}</button>}
  </section>;
}

function OptionDetails({ option }: { option: GuidedOption }) {
  if (option.stage === "competitors") {
    return option.payload.relevance.trim() !== option.description.trim()
      ? <span className="guided-choice-detail"><span className="guided-choice-detail-label">Why it matters</span><span>{option.payload.relevance}</span></span>
      : null;
  }
  if (option.stage === "audience") {
    return <span className="guided-choice-details">
      {option.payload.needs.length > 0 && <span className="guided-choice-detail"><span className="guided-choice-detail-label">What they need</span><span>{option.payload.needs.join(" · ")}</span></span>}
      {option.payload.reason.trim() !== option.description.trim() && <span className="guided-choice-detail"><span className="guided-choice-detail-label">Why they fit</span><span>{option.payload.reason}</span></span>}
    </span>;
  }
  return <span className="guided-choice-details">
    {option.payload.traits.length > 0 && <span className="guided-choice-traits">{option.payload.traits.map((trait, index) => <span key={`${trait}-${index}`}>{trait}</span>)}</span>}
    {option.payload.expression.trim() !== option.description.trim() && <span className="guided-choice-detail"><span className="guided-choice-detail-label">How it comes to life</span><span>{option.payload.expression}</span></span>}
    <span className="guided-choice-detail"><span className="guided-choice-detail-label">Example tone</span><span className="guided-choice-tone">“{option.payload.toneExample}”</span></span>
  </span>;
}

function OptionReferences({ option }: { option: GuidedOption }) {
  if (option.stage !== "competitors") return null;
  const website = competitorWebsiteSchema.safeParse(option.payload.url);
  const sources = option.payload.sources.filter((source) => competitorWebsiteSchema.safeParse(source.url).success);
  if (!website.success && !sources.length) return null;

  return <div className="guided-choice-references" role="group" aria-label={`References for ${option.label}`}>
    {website.success && <a className="guided-choice-website" href={website.data} target="_blank" rel="noopener noreferrer">Visit website<span className="sr-only"> for {option.label} (opens in a new tab)</span></a>}
    {sources.length > 0 && <div className="guided-choice-sources"><span className="guided-choice-source-label">Sources</span><ul>{sources.map((source, index) => <li key={`${source.url}-${index}`}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}<span className="sr-only"> (opens in a new tab)</span></a></li>)}</ul></div>}
  </div>;
}

/** Controlled choices only: selecting a card never answers or starts work. */
export function GuidedChoiceWidget({ reply, selectedIds, onSelectionChange, onContinue, disabled = false, answered = false, onRevisit }: GuidedChoiceWidgetProps) {
  const id = useId();
  const selected = reply.options.filter((option) => selectedIds.includes(option.id));
  const selectedOptions = reply.selectionMode === "single" ? selected.slice(0, 1) : selected;
  const selection = selectedOptions.map((option) => option.id);
  const instruction = reply.selectionMode === "single" ? "Choose one option, then continue." : "Choose one or more options, then continue.";

  function select(optionId: string, checked: boolean) {
    if (disabled || answered) return;
    if (reply.selectionMode === "single") {
      if (checked) onSelectionChange([optionId]);
      return;
    }
    onSelectionChange(checked ? [...selection.filter((selectedId) => selectedId !== optionId), optionId] : selection.filter((selectedId) => selectedId !== optionId));
  }

  if (answered) return <section className="guided-choice-answer" aria-labelledby={`${id}-question`}>
    <div className="guided-choice-answer-copy">
      <h3 id={`${id}-question`}>{reply.question}</h3>
      {selectedOptions.length ? <ul>{selectedOptions.map((option) => <li key={option.id}><ProjectArtwork name="check" /><span>{option.label}</span></li>)}</ul> : <p>Your answer is in the conversation.</p>}
    </div>
    {onRevisit && <button className="button secondary small" type="button" disabled={disabled} aria-label={`Edit your answer: ${reply.question}`} onClick={onRevisit}>Edit answer</button>}
  </section>;

  return <fieldset className={`guided-choice-widget guided-choice-widget-${reply.stage}`} aria-describedby={`${id}-hint`}>
    <legend className="sr-only">{reply.question}</legend>
    <div className="guided-choice-intro">
      <h3 aria-hidden="true">{reply.question}</h3>
      <p id={`${id}-hint`}>{instruction}</p>
    </div>
    {reply.options.length > 0 ? <div className="guided-choice-options">{reply.options.map((option, index) => {
      const optionId = `${id}-option-${index}`;
      const checked = selection.includes(option.id);
      return <div className={`guided-choice-card${checked ? " is-selected" : ""}${disabled ? " is-disabled" : ""}`} key={option.id}>
        <label className="guided-choice-target" htmlFor={optionId}>
          <input id={optionId} type={reply.selectionMode === "single" ? "radio" : "checkbox"} name={`${id}-choices`} checked={checked} disabled={disabled} aria-labelledby={`${optionId}-label`} aria-describedby={`${optionId}-detail`} onChange={(event) => select(option.id, event.target.checked)} />
          <span className="guided-choice-content">
            <span className="guided-choice-heading"><span className="guided-choice-label" id={`${optionId}-label`}>{option.label}</span>{option.recommended && <span className="guided-choice-recommended">Recommended</span>}</span>
            <span className="guided-choice-description" id={`${optionId}-detail`}>
              <span>{option.description}</span>
              <OptionDetails option={option} />
              {option.recommended && option.recommendationReason && <span className="guided-choice-reason"><span className="guided-choice-detail-label">Why we recommend it</span><span>{option.recommendationReason}</span></span>}
            </span>
          </span>
        </label>
        <OptionReferences option={option} />
      </div>;
    })}</div> : <p className="guided-choice-empty">No options are available for this question yet. You can reply in the conversation below.</p>}
    <div className="guided-choice-actions">
      <p>You can also write your own answer below.</p>
      <button className="button primary" type="button" disabled={disabled || !selection.length} onClick={() => { if (!disabled && selection.length) onContinue(); }}>Continue</button>
    </div>
  </fieldset>;
}
