"use client";

import { useId, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { Icon } from "@/components/ui/icon";
import type { Personality } from "@/domain/projects";
import type { LocalDraft } from "./local-drafts";
import {
  draftCompetitors, draftPersonality, draftPositioning,
  isPersonalityReviewComplete, isPositioningReviewComplete,
  personalityReviewValidationMessage, positioningReviewValidationMessage,
} from "./project-draft-adapter";
import "@/styles/strategy.css";

const dimensions: { key: keyof Personality; label: string; description: string }[] = [
  { key: "sincerity", label: "Sincerity", description: "Warm and straightforward" },
  { key: "excitement", label: "Excitement", description: "Lively and imaginative" },
  { key: "competence", label: "Competence", description: "Reliable and capable" },
  { key: "sophistication", label: "Sophistication", description: "Polished and refined" },
  { key: "ruggedness", label: "Ruggedness", description: "Outdoorsy and sturdy" },
];

const startingProfile: Personality = { sincerity: 50, excitement: 50, competence: 50, sophistication: 50, ruggedness: 50 };

type ReviewProps = {
  draft: LocalDraft;
  notice: string;
  onComplete: () => void;
  onBack: () => void;
  inline?: boolean;
};

function ReviewNotice({ complete, hasValue, notice, subject }: { complete: boolean; hasValue: boolean; notice: string; subject: string }) {
  if (complete || !hasValue) return null;
  return <div className="strategy-review-notice"><Icon name="clock" size={17} /><p><strong>Review needed</strong><span>{notice || `Confirm this ${subject} when it fits the current strategy inputs.`}</span></p></div>;
}

export function PersonalityReview({ draft, notice, onChange, onComplete, onBack, onSkip, inline = false }: ReviewProps & { onChange: (profile: Personality) => void; onSkip: () => void }) {
  const personality = draftPersonality(draft);
  const complete = isPersonalityReviewComplete(draft);
  const [startedHere, setStartedHere] = useState(false);
  const [error, setError] = useState("");
  const firstSlider = useRef<HTMLInputElement>(null);
  const focusNewProfile = useRef(false);
  const startButton = useRef<HTMLButtonElement>(null);
  const id = useId();

  function startProfile() {
    focusNewProfile.current = true;
    onChange({ ...startingProfile });
    setStartedHere(true);
    setError("");
  }

  function confirmProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationError = personalityReviewValidationMessage(draft);
    if (validationError) {
      setError(validationError);
      (personality ? firstSlider.current : startButton.current)?.focus();
      return;
    }
    setError("");
    onComplete();
  }

  return <form className="strategy-review personality-review" onSubmit={confirmProfile} noValidate>
    <p className="editor-intro">Shape how the brand comes across through Aaker’s five personality dimensions.</p>
    {!inline && <div className="strategy-provider-note"><Icon name="offline" size={17} /><p><strong>AI proposals are not connected.</strong> You can enter your own profile or return to this step later.</p></div>}
    {!personality ? <div className="strategy-empty">
      <span className="empty-icon"><Icon name="layers" size={24} /></span>
      <h2>No personality profile yet</h2>
      <p>Start your own profile with equal emphasis at 50 for each dimension. This is a starting point for your edits.</p>
      <button ref={startButton} type="button" className="button secondary" onClick={startProfile}>Enter my own profile<Icon name="pencil" size={15} /></button>
    </div> : <>
      <ReviewNotice complete={complete} hasValue notice={notice} subject="profile" />
      <div className="personality-panel">
        <div className="personality-panel-heading"><h2>{startedHere ? "Your starting point" : "Current profile"}</h2><span className="small-badge">0–100 emphasis</span></div>
        <p className="personality-scale-hint" id={`${id}-scale`}>Each dimension is independent. Higher values mean more emphasis, not better quality.</p>
        <fieldset className="personality-dimensions"><legend className="sr-only">Personality profile</legend>{dimensions.map((dimension, index) => <div className="personality-dimension" key={dimension.key}>
          <div className="personality-dimension-heading"><div><label htmlFor={`${id}-${dimension.key}`}>{dimension.label}</label><p id={`${id}-${dimension.key}-hint`}>{dimension.description}</p></div><span className="personality-value" aria-hidden="true">{personality[dimension.key]}</span></div>
          <input ref={index === 0 ? (node) => { firstSlider.current = node; if (node && focusNewProfile.current) { node.focus(); focusNewProfile.current = false; } } : undefined} id={`${id}-${dimension.key}`} className="personality-slider" type="range" min={0} max={100} step={1} value={personality[dimension.key]} aria-describedby={`${id}-${dimension.key}-hint ${id}-scale`} aria-valuetext={`${personality[dimension.key]} out of 100 emphasis`} style={{ "--emphasis": `${personality[dimension.key]}%` } as CSSProperties} onChange={(event) => { onChange({ ...personality, [dimension.key]: Number(event.target.value) }); setError(""); setStartedHere(false); }} />
          <div className="personality-range-labels" aria-hidden="true"><span>Less emphasis</span><span>More emphasis</span></div>
        </div>)}</fieldset>
      </div>
    </>}
    {complete && !inline && <div className="review-complete"><Icon name="check" size={20} /><div><strong>Personality review complete</strong><p>Your confirmed profile stays with this brief.</p></div></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions">{inline ? <button className="text-link" type="button" onClick={onSkip}>Continue later</button> : <button className="button secondary" type="button" onClick={onBack}>Back</button>}{personality ? <button className="button primary" type="submit">{inline ? "Keep personality" : complete ? "Continue to positioning" : "Confirm personality"}<Icon name={inline ? "check" : "arrow"} size={16} /></button> : !inline && <button className="button secondary" type="button" onClick={onSkip}>Continue without a profile<Icon name="arrow" size={16} /></button>}</div>
  </form>;
}

export function PositioningReview({ draft, notice, onChange, onComplete, onBack, inline = false }: ReviewProps & { onChange: (statement: string) => void }) {
  const positioning = draftPositioning(draft);
  const complete = isPositioningReviewComplete(draft);
  const personalityComplete = isPersonalityReviewComplete(draft);
  const [error, setError] = useState("");
  const statementRef = useRef<HTMLTextAreaElement>(null);
  const personalityButton = useRef<HTMLButtonElement>(null);
  const id = useId();

  function confirmPositioning(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationError = positioningReviewValidationMessage(draft);
    if (validationError) {
      setError(validationError);
      if (!positioning.trim() || personalityComplete) statementRef.current?.focus();
      else personalityButton.current?.focus();
      return;
    }
    setError("");
    onComplete();
  }

  return <form className="strategy-review positioning-review" onSubmit={confirmPositioning} noValidate>
    <p className="editor-intro">Keep one clear statement of who the brand serves, what it offers, and why it matters.</p>
    {!inline && <div className="strategy-provider-note"><Icon name="offline" size={17} /><p><strong>AI proposals are not connected.</strong> You can write and refine your own statement here.</p></div>}
    {!personalityComplete && <div className="strategy-prerequisite"><div><strong>Personality needs review</strong><p>You can draft your statement now. Confirm the personality profile before finishing this review.</p></div><button ref={personalityButton} className="button secondary small" type="button" onClick={onBack}>Review personality</button></div>}
    <ReviewNotice complete={complete} hasValue={Boolean(positioning.trim())} notice={notice} subject="statement" />
    <div className="form-panel positioning-panel">
      <label className="field-label" htmlFor={`${id}-statement`}>Positioning statement</label>
      <textarea ref={statementRef} id={`${id}-statement`} className="positioning-input" value={positioning} maxLength={5000} placeholder="Write your positioning statement" aria-invalid={Boolean(error) && !positioning.trim() || undefined} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} onChange={(event) => { onChange(event.target.value); setError(""); }} />
      <div className="positioning-input-footer"><p id={`${id}-hint`}>Use the selected strategy inputs alongside your statement.</p><span aria-label={`${positioning.length} of 5000 characters`}>{positioning.length.toLocaleString("en-US")} / 5,000</span></div>
    </div>
    {complete && !inline && <div className="review-complete"><Icon name="check" size={20} /><div><strong>Positioning review complete</strong><p>Your confirmed statement stays with this brief.</p></div></div>}
    {error && <p className="form-error" id={`${id}-error`} role="alert">{error}</p>}
    <div className="form-actions">{inline ? <span /> : <button className="button secondary" type="button" onClick={onBack}>Back</button>}<button className="button primary" type="submit">{inline ? "Keep positioning" : "Confirm positioning"}<Icon name="check" size={16} /></button></div>
  </form>;
}

/** Selected inputs only; no inferred strategy or provider claims. */
export function StrategyContext({ draft }: { draft: LocalDraft }) {
  const audience = draft.segments.filter((segment) => segment.selected);
  const competitors = draftCompetitors(draft).filter((competitor) => competitor.selected);
  const personality = draftPersonality(draft);
  return <dl className="strategy-inputs">
    <div><dt>Offering</dt><dd>{draft.offering.trim() || "Not specified"}</dd></div>
    <div><dt>Selected audience</dt><dd>{audience.length ? <><p>{audience.map((segment) => segment.name.trim() || "Unnamed audience").join(", ")}</p><details><summary>Needs and reasons</summary><ul>{audience.map((segment) => <li key={segment.id}><strong>{segment.name.trim() || "Unnamed audience"}</strong><p>{segment.needs.trim() || "Needs not specified"}</p>{segment.reason.trim() && <p>{segment.reason}</p>}</li>)}</ul></details></> : "No audience selected"}</dd></div>
    <div><dt>Retained competitors</dt><dd>{competitors.length ? <><p>{competitors.map((competitor) => competitor.name.trim() || "Unnamed competitor").join(", ")}</p><details><summary>Why they are relevant</summary><ul>{competitors.map((competitor) => <li key={competitor.id}><strong>{competitor.name.trim() || "Unnamed competitor"}</strong><p>{competitor.relevance.trim() || "Relevance not specified"}</p></li>)}</ul></details></> : "No competitors retained"}</dd></div>
    {draft.stage === "positioning" && <div><dt>Personality emphasis</dt><dd>{personality ? <><ul className="strategy-profile-summary">{dimensions.map((dimension) => <li key={dimension.key}><span>{dimension.label}</span><span>{personality[dimension.key]} / 100</span></li>)}</ul><p className="strategy-context-review">{isPersonalityReviewComplete(draft) ? "Personality confirmed" : "Personality not reviewed"}</p></> : "No profile yet"}</dd></div>}
  </dl>;
}
