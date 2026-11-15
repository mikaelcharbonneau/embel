"use client";

import { useId, type ReactNode } from "react";
import type { GuidedOption, GuidedReply, GuidedStage } from "@/domain/guided-interview";
import { competitorWebsiteSchema } from "@/domain/projects";
import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceGroup } from "@/components/ui/choice";
import { EmptyState, LoadingRegion, Skeleton } from "@/components/ui/feedback";
import { Icon, type IconName } from "@/components/ui/icon";
import { CompetitorLogo } from "./competitor-logo";
import { withoutScoreScaleNote } from "./guided-interview-client";

type ChoiceReply = Extract<GuidedReply, { kind: "choices" }>;

/** The question each step asks in the work area, before its options arrive. */
export const stageQuestions: Record<GuidedStage, string> = {
  competitors: "Which competitors should we keep in mind?",
  audience: "Who should the brand speak to first?",
  positioning: "Which positioning fits best?",
  personality: "Which personality feels right?",
  slogan: "Which slogan do you like?",
};
/** What the step's work area holds while it is empty. */
const emptyStates: Record<GuidedStage, { icon: IconName; title: string }> = {
  competitors: { icon: "search", title: "No competitors yet" },
  audience: { icon: "user", title: "No audiences yet" },
  positioning: { icon: "layers", title: "No positioning yet" },
  personality: { icon: "type", title: "No personalities yet" },
  slogan: { icon: "type", title: "No slogans yet" },
};
function Tags({ items }: { items: readonly string[] }) {
  return (
    <span className="e-cluster guided-option__tags">
      {items.map((item, index) => (
        <span key={`${item}-${index}`} className="e-badge">
          {item}
        </span>
      ))}
    </span>
  );
}

/** What a card shows beyond its title and description. Phrasing content only: it sits inside the card's label. */
function OptionDetails({ option, recommended }: { option: GuidedOption; recommended: boolean }) {
  const badge = recommended ? <span className="e-badge guided-option__recommended">Recommended</span> : null;
  if (option.stage === "audience")
    return (
      <>
        {badge}
        {option.payload.needs.length > 0 && <Tags items={option.payload.needs} />}
      </>
    );
  if (option.stage === "positioning")
    return (
      <>
        {badge}
        <Tags items={option.payload.leads} />
      </>
    );
  if (option.stage === "personality")
    return (
      <>
        {badge}
        {option.payload.traits.length > 0 && <Tags items={option.payload.traits} />}
        <span className="guided-option__tone">“{option.payload.toneExample}”</span>
      </>
    );
  return badge;
}

function OptionReferences({ option }: { option: GuidedOption }) {
  if (option.stage !== "competitors") return null;
  const website = competitorWebsiteSchema.safeParse(option.payload.url);
  const sources = option.payload.sources.filter((source) => competitorWebsiteSchema.safeParse(source.url).success);
  if (!website.success && !sources.length) return null;
  return (
    <div className="e-cluster guided-option__references" role="group" aria-label={`References for ${option.label}`}>
      {website.success && (
        <a className="e-link e-link--standalone" href={website.data} target="_blank" rel="noopener noreferrer">
          Visit website
          <Icon name="external-link" size="sm" />
          <span className="e-sr"> for {option.label} (opens in a new tab)</span>
        </a>
      )}
      {sources.length > 0 && (
        <span className="guided-option__sources">
          <span className="e-muted">Found on</span>
          <ul className="e-cluster">
            {sources.map((source, index) => (
              <li key={`${source.url}-${index}`}>
                <a className="e-link" href={source.url} target="_blank" rel="noopener noreferrer">
                  {source.title}
                  <span className="e-sr"> (opens in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>
        </span>
      )}
    </div>
  );
}

/** The step's heading in the work area: its question. */
export function StepHeading({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="e-cluster e-cluster--between e-cluster--top conversation-step__head">
      <h2 className="e-section__title">{title}</h2>
      {aside}
    </div>
  );
}

export type GuidedChoicesProps = {
  reply: ChoiceReply;
  selectedIds: readonly string[];
  onSelectionChange: (ids: string[]) => void;
  disabled?: boolean;
  /** Add a competitor, Suggest more. */
  additionalControls?: ReactNode;
  retainedOptions?: readonly GuidedOption[];
  /** Shows each competitor's site icon, fetched privately for this project. */
  projectId?: string;
};

/** The options of the step on screen, as text choice cards. Choosing only selects: the chosen options go into the
 * reply box, and Send confirms them. */
export function GuidedChoices({
  reply,
  selectedIds,
  onSelectionChange,
  disabled = false,
  additionalControls,
  retainedOptions = [],
  projectId,
}: GuidedChoicesProps) {
  const id = useId();
  const single = reply.selectionMode === "single";
  const options = [...reply.options, ...retainedOptions];
  const selected = selectedOptions(reply, retainedOptions, selectedIds).map((option) => option.id);
  // A badge on every card says nothing; it marks recommendations only among others.
  const markRecommended = options.some((option) => !option.recommended);
  const competitors = reply.stage === "competitors";

  function select(optionId: string, checked: boolean) {
    if (disabled) return;
    if (single) {
      if (checked) onSelectionChange([optionId]);
      return;
    }
    onSelectionChange(
      checked
        ? [...selectedIds.filter((selectedId) => selectedId !== optionId), optionId]
        : selectedIds.filter((selectedId) => selectedId !== optionId),
    );
  }

  return (
    <section className="e-stack e-stack--lg conversation-step" aria-labelledby={`${id}-title`}>
      <StepHeading title={reply.question} />
      <span id={`${id}-title`} hidden>
        {reply.question}
      </span>
      {options.length > 0 ? (
        <ChoiceGroup
          legend={reply.question}
          hideLegend
          columns={competitors ? "list" : 2}
          className={`guided-choices guided-choices--${reply.stage}`}
        >
          {options.map((option) => {
            const card = (
              <ChoiceCard
                key={option.id}
                name={`${id}-choices`}
                value={option.id}
                multiple={!single}
                checked={selected.includes(option.id)}
                disabled={disabled}
                leading={
                  projectId && option.stage === "competitors" ? (
                    <CompetitorLogo
                      projectId={projectId}
                      name={option.payload.name}
                      url={option.payload.url}
                      size={40}
                    />
                  ) : undefined
                }
                title={option.label}
                description={
                  option.stage === "positioning"
                    ? option.payload.statement
                    : option.stage === "personality"
                      ? withoutScoreScaleNote(option.description)
                      : option.description
                }
                onChange={(checked) => select(option.id, checked)}
              >
                <OptionDetails option={option} recommended={Boolean(option.recommended && markRecommended)} />
              </ChoiceCard>
            );
            return competitors ? (
              <div key={option.id} className="e-stack e-stack--xs guided-option">
                {card}
                <OptionReferences option={option} />
              </div>
            ) : (
              card
            );
          })}
        </ChoiceGroup>
      ) : (
        <EmptyState
          variant="results"
          icon={emptyStates[reply.stage].icon}
          title={emptyStates[reply.stage].title}
          text="You can reply in the chat."
        />
      )}
      {additionalControls}
    </section>
  );
}

/** The options a selection refers to, in the order shown; stale ids are left out. */
export function selectedOptions(
  reply: ChoiceReply,
  retainedOptions: readonly GuidedOption[],
  selectedIds: readonly string[],
) {
  const chosen = [...reply.options, ...retainedOptions].filter((option) => selectedIds.includes(option.id));
  return reply.selectionMode === "single" ? chosen.slice(0, 1) : chosen;
}

/** The step's work area while its options are being written: skeletons in their final shape. */
export function GuidedChoicesLoading({ stage, title }: { stage: GuidedStage; title?: string }) {
  const rows = stage === "competitors";
  return (
    <section className="e-stack e-stack--lg conversation-step" aria-label={title ?? stageQuestions[stage]}>
      <StepHeading title={title ?? stageQuestions[stage]} />
      <LoadingRegion label={rows ? "Researching competitors" : "Writing options"}>
        <div className={rows ? "e-stack e-stack--md" : "e-grid-choices"}>
          {[0, 1, 2].map((index) => (
            <div key={index} className={`e-choice guided-option--skeleton${rows ? " e-choice--leading" : ""}`}>
              {rows && <Skeleton shape="circle" />}
              <Skeleton shape="title" width={40} />
              <Skeleton width={rows ? 60 : 80} />
              {!rows && <Skeleton width={40} />}
            </div>
          ))}
        </div>
      </LoadingRegion>
    </section>
  );
}

/** The step's work area after a response did not finish: a quiet empty state; the recovery is in the chat. */
export function GuidedChoicesEmpty({
  stage,
  title,
  research,
}: {
  stage: GuidedStage;
  title?: string;
  research?: boolean;
}) {
  return (
    <section className="e-stack e-stack--lg conversation-step" aria-label={title ?? stageQuestions[stage]}>
      <StepHeading title={title ?? stageQuestions[stage]} />
      <EmptyState
        variant="results"
        icon={emptyStates[stage].icon}
        title={emptyStates[stage].title}
        text={research ? undefined : "You can reply in the chat."}
      />
    </section>
  );
}

/** A step of Strategy that is no longer confirmed although the conversation has moved past it. */
export type StrategyReviewStep = "brief" | Exclude<GuidedStage, "slogan">;
const reviewActions: Record<StrategyReviewStep, string> = {
  brief: "Edit brief",
  competitors: "Review competitors",
  audience: "Review audience",
  positioning: "Review positioning",
  personality: "Review personality",
};
/** The work area when Strategy has no confirmation although the conversation moved on: it says so and offers
 * the step to reopen, instead of waiting for a response nobody asked for. A brief edit used to cause this and no
 * longer does (owner decision, November 14, 2026); projects edited before that are still in this state. */
export function GuidedStrategyReview({
  step,
  disabled,
  onReview,
}: {
  step: StrategyReviewStep;
  disabled?: boolean;
  onReview: () => void;
}) {
  const title = "Your strategy needs another look";
  return (
    <section className="e-stack e-stack--lg conversation-step" aria-label={title}>
      <EmptyState
        variant="results"
        icon="rotate-ccw"
        title={title}
        action={
          <Button variant="primary" size="sm" disabled={disabled} onClick={onReview}>
            {reviewActions[step]}
          </Button>
        }
      />
    </section>
  );
}

/** One answer inside a folded group (Strategy, Voice), with its own Edit button. */
export function FoldedPart({
  label,
  answers,
  editLabel = "Change answer",
  editName,
  disabled,
  onEdit,
}: {
  label: string;
  answers: readonly string[];
  editLabel?: string;
  editName?: string;
  disabled?: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="e-stack e-stack--xs conversation-folded__part">
      <span className="e-answer__question">{label}</span>
      <p>{answers.length ? answers.join(", ") : "Skipped"}</p>
      <div>
        <Button size="sm" disabled={disabled} aria-label={editName} onClick={onEdit}>
          {editLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * A finished step in the chat: one line with the step's name and its answer as badges. Opening it shows what was
 * decided and its Edit button; while it is folded its controls are out of the keyboard order.
 */
export function FoldedAnswer({
  id,
  label,
  answers,
  thumbnail,
  editLabel = "Change answer",
  editName,
  onEdit,
  editDisabled,
  open,
  onToggle,
  children,
}: {
  id?: string;
  label: string;
  answers: readonly { text: string; icon?: IconName }[];
  thumbnail?: ReactNode;
  editLabel?: string;
  /** The Edit button's accessible name when the visible label is not enough. */
  editName?: string;
  onEdit?: () => void;
  editDisabled?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <details
      id={id}
      className="e-disclosure e-answer conversation-folded"
      open={open}
      onToggle={(event) => onToggle?.(event.currentTarget.open)}
    >
      <summary>
        <Icon name="chevron-right" className="e-disclosure__chevron" />
        <span className="e-answer__question">{label}</span>
        {thumbnail}
        {answers.length ? (
          answers.map((answer, index) => (
            <span key={`${answer.text}-${index}`} className="e-badge">
              <Icon name={answer.icon ?? "check"} size="sm" />
              {answer.text}
            </span>
          ))
        ) : (
          <span className="e-badge">Skipped</span>
        )}
      </summary>
      <div className="e-disclosure__content">
        {children}
        {onEdit && (
          <div>
            <Button size="sm" disabled={editDisabled} aria-label={editName} onClick={onEdit}>
              {editLabel}
            </Button>
          </div>
        )}
      </div>
    </details>
  );
}
