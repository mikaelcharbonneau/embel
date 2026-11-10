"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { Icon } from "@/components/ui/icon";
import { competitorWebsiteSchema, type ContextSnapshot } from "@/domain/projects";
import { ConversationReferences } from "./conversation-references";
import type { LocalCompetitor, LocalDraft } from "./local-drafts";
import {
  competitorReviewValidationMessage,
  draftCompetitors,
  isCompetitorReviewComplete,
} from "./project-draft-adapter";
import "@/styles/competitors.css";

type CompetitorReviewProps = {
  draft: LocalDraft;
  onChange: (competitors: LocalCompetitor[]) => void;
  onComplete: () => void;
  onBack: () => void;
  inline?: boolean;
  savedContext?: ContextSnapshot;
};

export function CompetitorReview({
  draft,
  onChange,
  onComplete,
  onBack,
  inline = false,
  savedContext = draft.preservedContext,
}: CompetitorReviewProps) {
  const competitors = draftCompetitors(draft);
  const retained = competitors.filter((competitor) => competitor.selected);
  const complete = isCompetitorReviewComplete(draft);
  const [noneConfirmed, setNoneConfirmed] = useState(complete && retained.length === 0);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [attemptedReview, setAttemptedReview] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const focusName = useRef<string | null>(null);
  const id = useId();

  function updateCompetitors(next: LocalCompetitor[]) {
    onChange(next);
    setNoneConfirmed(false);
    setError("");
    setAttemptedReview(false);
  }

  function addCompetitor() {
    if (competitors.length >= 50) return;
    const competitorId = crypto.randomUUID();
    focusName.current = competitorId;
    updateCompetitors([...competitors, { id: competitorId, name: "", relevance: "", url: "", selected: false }]);
  }

  function updateCompetitor(competitorId: string, patch: Partial<LocalCompetitor>) {
    updateCompetitors(
      competitors.map((competitor) => (competitor.id === competitorId ? { ...competitor, ...patch } : competitor)),
    );
  }

  function keepCompetitor(competitorId: string) {
    setConfirmRemove(null);
    requestAnimationFrame(() => document.getElementById(`competitor-${competitorId}-remove`)?.focus());
  }

  function removeCompetitor(competitorId: string) {
    const index = competitors.findIndex((competitor) => competitor.id === competitorId);
    const next = competitors.filter((competitor) => competitor.id !== competitorId);
    updateCompetitors(next);
    setConfirmRemove(null);
    requestAnimationFrame(() => {
      const nextCompetitor = next[Math.min(index, next.length - 1)];
      if (nextCompetitor) document.getElementById(`competitor-${nextCompetitor.id}-name`)?.focus();
      else addRef.current?.focus();
    });
  }

  function finishReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationError = competitorReviewValidationMessage(draft);
    const reviewError =
      validationError ||
      (!retained.length && !noneConfirmed
        ? "Retain a competitor, or confirm that you have no relevant competitors to retain."
        : "");
    if (reviewError) {
      setError(reviewError);
      setAttemptedReview(true);
      requestAnimationFrame(() => {
        const field = formRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>('[aria-invalid="true"]');
        (field ?? errorRef.current)?.focus();
      });
      return;
    }
    setError("");
    onComplete();
  }

  return (
    <form className="competitor-review" ref={formRef} onSubmit={finishReview} noValidate>
      <p className="editor-intro">Add the competitors you know, then retain the ones that matter for this project.</p>
      {!inline && (
        <div className="competitor-research-note">
          <Icon name="offline" size={17} />
          <p>
            <strong>Research is not connected.</strong> You can add your own notes or continue without competitors.
          </p>
        </div>
      )}

      {!competitors.length && (
        <div className="audience-empty competitor-empty">
          <span className="empty-icon">
            <Icon name="brands" size={24} />
          </span>
          <h2>Who offers something similar?</h2>
          <p>Include alternatives your audience might choose and why they are relevant.</p>
          <button ref={addRef} className="button secondary" type="button" onClick={addCompetitor}>
            <Icon name="plus" size={16} />
            Add competitor
          </button>
        </div>
      )}

      <div className="segment-list competitor-list">
        {competitors.map((competitor, index) => {
          const nameInvalid = attemptedReview && competitor.selected && !competitor.name.trim();
          const relevanceInvalid = attemptedReview && competitor.selected && !competitor.relevance.trim();
          const websiteInvalid =
            attemptedReview &&
            Boolean(competitor.url.trim()) &&
            !competitorWebsiteSchema.safeParse(competitor.url.trim()).success;
          const fieldId = `competitor-${competitor.id}`;
          const saved = savedContext?.competitors.find((item) => item.id === competitor.id);
          const edited = Boolean(
            saved &&
            (saved.origin === "user" ||
              saved.name !== competitor.name.trim() ||
              saved.relevance !== competitor.relevance.trim() ||
              (saved.url ?? "") !== competitor.url.trim()),
          );
          return (
            <fieldset
              className={`segment-card competitor-card ${competitor.selected ? "is-selected" : ""}`}
              key={competitor.id}
            >
              <legend className="sr-only">Competitor {index + 1}</legend>
              <div className="segment-top">
                <label className="target-toggle">
                  <input
                    type="checkbox"
                    checked={competitor.selected}
                    onChange={(event) => updateCompetitor(competitor.id, { selected: event.target.checked })}
                  />
                  <span>{competitor.selected ? "Retained competitor" : "Retain competitor"}</span>
                </label>
                <button
                  id={`${fieldId}-remove`}
                  type="button"
                  className="icon-button subtle"
                  aria-label={`Remove competitor ${index + 1}`}
                  aria-expanded={confirmRemove === competitor.id}
                  aria-controls={confirmRemove === competitor.id ? `${fieldId}-confirmation` : undefined}
                  onClick={() => {
                    setConfirmRemove(competitor.id);
                    requestAnimationFrame(() => document.getElementById(`${fieldId}-keep`)?.focus());
                  }}
                >
                  <Icon name="close" size={17} />
                </button>
              </div>
              <label className="field-label" htmlFor={`${fieldId}-name`}>
                Competitor name
              </label>
              <input
                id={`${fieldId}-name`}
                ref={(node) => {
                  if (node && focusName.current === competitor.id) {
                    node.focus();
                    focusName.current = null;
                  }
                }}
                className="competitor-input"
                value={competitor.name}
                maxLength={160}
                placeholder="A company, product, or alternative"
                aria-invalid={nameInvalid || undefined}
                aria-describedby={nameInvalid ? `${fieldId}-name-error` : undefined}
                onChange={(event) => updateCompetitor(competitor.id, { name: event.target.value })}
              />
              {nameInvalid && (
                <p id={`${fieldId}-name-error`} className="competitor-field-error">
                  Add a name for this retained competitor.
                </p>
              )}
              <div className="competitor-field">
                <label className="field-label" htmlFor={`${fieldId}-relevance`}>
                  Why is it relevant?
                </label>
                <textarea
                  id={`${fieldId}-relevance`}
                  className="competitor-input competitor-relevance"
                  value={competitor.relevance}
                  maxLength={2000}
                  placeholder="What overlaps with your offering or audience?"
                  aria-invalid={relevanceInvalid || undefined}
                  aria-describedby={relevanceInvalid ? `${fieldId}-relevance-error` : undefined}
                  onChange={(event) => updateCompetitor(competitor.id, { relevance: event.target.value })}
                />
                {relevanceInvalid && (
                  <p id={`${fieldId}-relevance-error`} className="competitor-field-error">
                    Explain why this retained competitor matters.
                  </p>
                )}
              </div>
              <div className="competitor-field">
                <label className="field-label" htmlFor={`${fieldId}-website`}>
                  Website<span className="optional">Optional</span>
                </label>
                <input
                  id={`${fieldId}-website`}
                  className="competitor-input"
                  type="url"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={competitor.url}
                  maxLength={2048}
                  placeholder="https://example.com"
                  aria-invalid={websiteInvalid || undefined}
                  aria-describedby={`${fieldId}-website-hint${websiteInvalid ? ` ${fieldId}-website-error` : ""}`}
                  onChange={(event) => updateCompetitor(competitor.id, { url: event.target.value })}
                />
                <p className="field-hint" id={`${fieldId}-website-hint`}>
                  Include http:// or https://. Websites are not checked.
                </p>
                {websiteInvalid && (
                  <p id={`${fieldId}-website-error`} className="competitor-field-error">
                    Enter a valid HTTP or HTTPS website without login details.
                  </p>
                )}
              </div>
              <ConversationReferences sources={saved?.sources} edited={edited} />
              {confirmRemove === competitor.id && (
                <div
                  className="inline-confirm competitor-remove-confirm"
                  id={`${fieldId}-confirmation`}
                  role="group"
                  aria-label={`Confirm removal of competitor ${index + 1}`}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      keepCompetitor(competitor.id);
                    }
                  }}
                >
                  <span>Remove this competitor from the draft?</span>
                  <div>
                    <button
                      id={`${fieldId}-keep`}
                      className="button secondary small"
                      type="button"
                      onClick={() => keepCompetitor(competitor.id)}
                    >
                      Keep it
                    </button>
                    <button
                      className="button danger small"
                      type="button"
                      onClick={() => removeCompetitor(competitor.id)}
                    >
                      Remove competitor
                    </button>
                  </div>
                </div>
              )}
            </fieldset>
          );
        })}
      </div>

      {competitors.length > 0 && competitors.length < 50 && (
        <button ref={addRef} className="add-audience" type="button" onClick={addCompetitor}>
          <Icon name="plus" size={17} />
          Add another competitor
        </button>
      )}
      {competitors.length >= 50 && (
        <p className="field-hint competitor-limit">
          You have reached 50 competitors. Remove one before adding another.
        </p>
      )}

      {!retained.length && (
        <div className="competitor-none">
          <label className="target-toggle">
            <input
              type="checkbox"
              checked={noneConfirmed}
              aria-invalid={(attemptedReview && !noneConfirmed) || undefined}
              aria-describedby={`${id}-none-hint${attemptedReview && !noneConfirmed ? ` ${id}-error` : ""}`}
              onChange={(event) => {
                if (complete) onChange(competitors);
                setNoneConfirmed(event.target.checked);
                setError("");
                setAttemptedReview(false);
              }}
            />
            <span>I have no relevant competitors to retain</span>
          </label>
          <p id={`${id}-none-hint`}>You can add competitors to this conversation later.</p>
        </div>
      )}

      {complete && !inline && (
        <div className="review-complete">
          <Icon name="check" size={20} />
          <div>
            <strong>Competitor review complete</strong>
            <p>
              {retained.length
                ? `${retained.length} ${retained.length === 1 ? "competitor is" : "competitors are"} retained with your brief.`
                : "You chose to continue without retained competitors."}
            </p>
          </div>
        </div>
      )}
      {error && (
        <p id={`${id}-error`} className="form-error" role="alert" ref={errorRef} tabIndex={-1}>
          {error}
        </p>
      )}
      <div className="form-actions">
        <button className={inline ? "text-link" : "button secondary"} type="button" onClick={onBack}>
          {inline ? "Continue later" : "Back"}
        </button>
        <button className="button primary" type="submit">
          {inline ? "Keep competitors" : complete ? "Continue to audience" : "Finish competitor review"}
          <Icon name={inline ? "check" : "arrow"} size={16} />
        </button>
      </div>
    </form>
  );
}
