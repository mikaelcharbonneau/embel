"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceGroup } from "@/components/ui/choice";
import { TextField } from "@/components/ui/field";
import type { GuidedReply } from "@/domain/guided-interview";
import { StepHeading, stageHint } from "./guided-interview-widgets";

type SloganReply = Extract<GuidedReply, { kind: "choices" }>;
export type SloganDecision = { optionId: string } | { own: string };
/** What is chosen while the slogan step is open: a suggestion, or the person's own line. */
export type SloganChoice = { turnId: string; chosen: string | "own" | null; own: string };

export const OWN_SLOGAN_MAX = 120;

/** The decision Send saves, or null while nothing usable is chosen. */
export function sloganDecision(choice: SloganChoice | null): SloganDecision | null {
  if (!choice?.chosen) return null;
  if (choice.chosen === "own") {
    const own = choice.own.trim();
    return own ? { own } : null;
  }
  return { optionId: choice.chosen };
}
/** The chosen line, as the reply box shows it. */
export function sloganText(reply: SloganReply, choice: SloganChoice | null): string | null {
  const decision = sloganDecision(choice);
  if (!decision) return null;
  if ("own" in decision) return decision.own;
  const option = reply.options.find((item) => item.id === decision.optionId);
  return option?.stage === "slogan" ? option.payload.slogan : null;
}

/** Voice · Slogan (optional), in the work area. Choosing a line or writing your own only selects it; Send saves the
 * decision and Skip for now saves none. */
export function GuidedSlogan({
  reply,
  brandName,
  choice,
  onChoice,
  disabled = false,
  onSkip,
  onMore,
  canMore = false,
}: {
  reply: SloganReply;
  brandName: string;
  choice: SloganChoice;
  onChoice: (choice: SloganChoice) => void;
  disabled?: boolean;
  onSkip: () => void;
  onMore?: () => void;
  canMore?: boolean;
}) {
  const id = useId();
  const slogans = reply.options.flatMap((option) =>
    option.stage === "slogan" ? [{ id: option.id, text: option.payload.slogan }] : [],
  );
  const preview = sloganText(reply, choice);
  return (
    <section className="e-stack e-stack--lg conversation-step" aria-labelledby={`${id}-title`}>
      <StepHeading title={reply.question} hint={stageHint("slogan", true)} hintId={`${id}-hint`} />
      <span id={`${id}-title`} hidden>
        {reply.question}
      </span>
      <section className="e-card guided-slogan__preview" aria-label="Preview">
        <span className="e-section__hint">Preview</span>
        <span className="guided-slogan__name">{brandName}</span>
        <span className="guided-slogan__line" role="status" data-empty={preview ? undefined : ""}>
          {preview || (choice.chosen === "own" ? "Your slogan will appear here" : "No slogan yet")}
        </span>
      </section>
      <ChoiceGroup legend={reply.question} hideLegend describedBy={`${id}-hint`} className="guided-choices">
        {slogans.map((item) => (
          <ChoiceCard
            key={item.id}
            name={`${id}-slogan`}
            value={item.id}
            title={item.text}
            checked={choice.chosen === item.id}
            disabled={disabled}
            onChange={(checked) => {
              if (checked) onChoice({ ...choice, chosen: item.id });
            }}
          />
        ))}
      </ChoiceGroup>
      <TextField
        label="Or write your own"
        className="e-field--bounded"
        value={choice.own}
        maxLength={OWN_SLOGAN_MAX}
        disabled={disabled}
        placeholder="Write your own slogan…"
        hint={`${choice.own.length} / ${OWN_SLOGAN_MAX}`}
        onChange={(event) => {
          const own = event.target.value;
          onChoice({ ...choice, own, chosen: own.trim() ? "own" : choice.chosen === "own" ? null : choice.chosen });
        }}
      />
      <div className="e-cluster">
        {onMore && (
          <Button icon="refresh-cw" disabled={disabled || !canMore} onClick={onMore}>
            More slogans
          </Button>
        )}
        <Button variant="quiet" disabled={disabled} onClick={onSkip}>
          Skip for now
        </Button>
      </div>
    </section>
  );
}
