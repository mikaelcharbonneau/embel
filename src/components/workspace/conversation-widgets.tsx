"use client";

import { useRef, useState, type FormEvent } from "react";
import { Icon } from "@/components/ui/icon";
import type { ConversationWidget } from "@/domain/conversation";
import type { ContextSnapshot } from "@/domain/projects";
import { ConversationReferences } from "./conversation-references";
import type { LocalDraft, LocalSegment } from "./local-drafts";
import { draftCompetitors, draftPersonality, draftPositioning } from "./project-draft-adapter";

export const widgetLabels: Record<ConversationWidget, string> = {
  competitors: "Competitors",
  audience: "Audience",
  personality: "Personality",
  positioning: "Positioning",
};

export function WidgetSummary({
  widget,
  draft,
  reviewed,
}: {
  widget: ConversationWidget;
  draft: LocalDraft;
  reviewed: boolean;
}) {
  if (widget === "competitors") {
    const retained = draftCompetitors(draft).filter((item) => item.selected);
    return retained.length ? (
      <ul className="conversation-selection-summary">
        {retained.map((item) => (
          <li key={item.id}>
            <strong>{item.name.trim() || "Unnamed competitor"}</strong>
            {item.relevance.trim() && <p>{item.relevance}</p>}
          </li>
        ))}
      </ul>
    ) : (
      <p className="conversation-empty-summary">
        {reviewed ? "No competitors retained." : "No competitors selected yet."}
      </p>
    );
  }
  if (widget === "audience") {
    const selected = draft.segments.filter((item) => item.selected);
    return selected.length ? (
      <ul className="conversation-selection-summary">
        {selected.map((item) => (
          <li key={item.id}>
            <strong>{item.name.trim() || "Unnamed audience"}</strong>
            {item.needs.trim() && <p>{item.needs}</p>}
          </li>
        ))}
      </ul>
    ) : (
      <p className="conversation-empty-summary">No audience selected yet.</p>
    );
  }
  if (widget === "personality") {
    const profile = draftPersonality(draft);
    return profile ? (
      <dl className="conversation-profile-summary">
        {Object.entries(profile).map(([key, value]) => (
          <div key={key}>
            <dt>{key.charAt(0).toUpperCase() + key.slice(1)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    ) : (
      <p className="conversation-empty-summary">No personality profile selected yet.</p>
    );
  }
  const statement = draftPositioning(draft);
  return statement.trim() ? (
    <p className="conversation-positioning-summary">{statement}</p>
  ) : (
    <p className="conversation-empty-summary">No positioning statement yet.</p>
  );
}

export function AudienceConversationWidget({
  draft,
  onChange,
  onComplete,
  onContinue,
  savedContext = draft.preservedContext,
}: {
  draft: LocalDraft;
  onChange: (segments: LocalSegment[]) => void;
  onComplete: () => void;
  onContinue: () => void;
  savedContext?: ContextSnapshot;
}) {
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const pendingAddFocus = useRef(false);
  const pendingRemoveFocus = useRef<string | null>(null);
  const pendingConfirmFocus = useRef<string | null>(null);

  function addButtonRef(node: HTMLButtonElement | null) {
    if (node && pendingAddFocus.current) {
      node.focus();
      pendingAddFocus.current = false;
    }
  }

  function update(segments: LocalSegment[]) {
    onChange(segments);
    setError("");
  }

  function addSegment(fromNotes = false) {
    if (draft.segments.length >= 30) return;
    const id = crypto.randomUUID();
    pendingFocus.current = id;
    update([
      ...draft.segments,
      { id, name: fromNotes ? draft.knownAudience.slice(0, 180) : "", needs: "", reason: "", selected: false },
    ]);
  }

  function updateSegment(id: string, patch: Partial<LocalSegment>) {
    update(draft.segments.map((segment) => (segment.id === id ? { ...segment, ...patch } : segment)));
  }

  function keepSegment(id: string) {
    pendingRemoveFocus.current = id;
    setConfirmRemove(null);
  }

  function removeSegment(id: string) {
    const index = draft.segments.findIndex((segment) => segment.id === id);
    const remaining = draft.segments.filter((segment) => segment.id !== id);
    const adjacent = remaining[Math.min(index, remaining.length - 1)];
    if (adjacent) pendingFocus.current = adjacent.id;
    else pendingAddFocus.current = true;
    update(remaining);
    setConfirmRemove(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selected = draft.segments.filter((segment) => segment.selected);
    if (!selected.length) {
      setError("Choose at least one target audience, or continue and return to this later.");
      return;
    }
    const incomplete = selected.find(
      (segment) => !segment.name.trim() || !segment.needs.trim() || !segment.reason.trim(),
    );
    if (incomplete) {
      setError("Add a name, needs, and a reason for every selected audience.");
      document.getElementById(`audience-${incomplete.id}`)?.focus();
      return;
    }
    setError("");
    onComplete();
  }

  return (
    <form className="audience-conversation-widget" onSubmit={submit} noValidate>
      <p className="editor-intro">
        Select the people you want to reach. You can adjust each group’s needs and reasons.
      </p>
      {draft.knownAudience && !draft.segments.length && (
        <div className="audience-notes">
          <div>
            <span>Saved audience notes</span>
            <p>{draft.knownAudience}</p>
          </div>
          <button className="button secondary small" type="button" onClick={() => addSegment(true)}>
            Use as a starting point
          </button>
        </div>
      )}
      {!draft.segments.length && (
        <div className="conversation-widget-empty">
          <p>No audience suggestions yet. You can add a group you already have in mind.</p>
          <button ref={addButtonRef} type="button" className="button secondary small" onClick={() => addSegment()}>
            <Icon name="plus" size={15} />
            Add audience
          </button>
        </div>
      )}
      <div className="segment-list">
        {draft.segments.map((segment, index) => {
          const saved = savedContext?.audienceSegments.find((item) => item.id === segment.id);
          const edited = Boolean(
            saved &&
            (saved.origin === "user" ||
              saved.label !== segment.name.trim() ||
              saved.needs.join("\n") !== segment.needs.trim() ||
              saved.reason !== segment.reason.trim()),
          );
          return (
            <fieldset className={`segment-card ${segment.selected ? "is-selected" : ""}`} key={segment.id}>
              <legend className="sr-only">Audience {index + 1}</legend>
              <div className="segment-top">
                <label className="target-toggle">
                  <input
                    type="checkbox"
                    checked={segment.selected}
                    onChange={(event) => updateSegment(segment.id, { selected: event.target.checked })}
                  />
                  <span>{segment.selected ? "Selected target" : "Select as target"}</span>
                </label>
                <button
                  type="button"
                  ref={(node) => {
                    if (node && pendingRemoveFocus.current === segment.id) {
                      node.focus();
                      pendingRemoveFocus.current = null;
                    }
                  }}
                  className="icon-button subtle"
                  aria-label={`Remove audience ${index + 1}`}
                  aria-expanded={confirmRemove === segment.id}
                  aria-controls={confirmRemove === segment.id ? `audience-${segment.id}-confirmation` : undefined}
                  onClick={() => {
                    pendingConfirmFocus.current = segment.id;
                    setConfirmRemove(segment.id);
                  }}
                >
                  <Icon name="close" size={17} />
                </button>
              </div>
              <label className="field-label">
                Audience name
                <input
                  id={`audience-${segment.id}`}
                  ref={(node) => {
                    if (node && pendingFocus.current === segment.id) {
                      node.focus();
                      pendingFocus.current = null;
                    }
                  }}
                  value={segment.name}
                  maxLength={180}
                  placeholder="Who is this group?"
                  onChange={(event) => updateSegment(segment.id, { name: event.target.value })}
                />
              </label>
              <div className="segment-fields">
                <label className="field-label">
                  What do they need?
                  <textarea
                    className="short-textarea"
                    value={segment.needs}
                    maxLength={24011}
                    placeholder="Their needs, one per line"
                    onChange={(event) => updateSegment(segment.id, { needs: event.target.value })}
                  />
                </label>
                <label className="field-label">
                  Why are they a fit?
                  <textarea
                    className="short-textarea"
                    value={segment.reason}
                    maxLength={2000}
                    placeholder="How your offering is relevant to them"
                    onChange={(event) => updateSegment(segment.id, { reason: event.target.value })}
                  />
                </label>
              </div>
              <ConversationReferences sources={saved?.sources} edited={edited} />
              {confirmRemove === segment.id && (
                <div
                  className="inline-confirm"
                  id={`audience-${segment.id}-confirmation`}
                  role="group"
                  aria-label={`Confirm removal of audience ${index + 1}`}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      keepSegment(segment.id);
                    }
                  }}
                >
                  <span>Remove this audience?</span>
                  <div>
                    <button
                      type="button"
                      ref={(node) => {
                        if (node && pendingConfirmFocus.current === segment.id) {
                          node.focus();
                          pendingConfirmFocus.current = null;
                        }
                      }}
                      className="button secondary small"
                      onClick={() => keepSegment(segment.id)}
                    >
                      Keep it
                    </button>
                    <button type="button" className="button danger small" onClick={() => removeSegment(segment.id)}>
                      Remove audience
                    </button>
                  </div>
                </div>
              )}
            </fieldset>
          );
        })}
      </div>
      {draft.segments.length > 0 && draft.segments.length < 30 && (
        <button ref={addButtonRef} className="add-audience" type="button" onClick={() => addSegment()}>
          <Icon name="plus" size={17} />
          Add another audience
        </button>
      )}
      {draft.segments.length >= 30 && <p className="field-hint">This brief can keep up to 30 audience segments.</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="text-link" onClick={onContinue}>
          Continue later
        </button>
        <button type="submit" className="button primary">
          Keep audience
          <Icon name="check" size={16} />
        </button>
      </div>
    </form>
  );
}
