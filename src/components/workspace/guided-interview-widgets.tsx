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
export function stageHint(stage: GuidedStage, single: boolean) {
  if (stage === "slogan") return "Choose one, write your own, or skip for now.";
  return single ? "Choose one, then press Send." : "Choose one or more, then press Send.";
}

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .normalize("NFKC")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 3),
  );
/** Whether a second text mostly repeats the first, so showing it adds nothing. */
function repeats(first: string, second: string) {
  const a = first.trim().toLowerCase(),
    b = second.trim().toLowerCase();
  if (!b || a.includes(b) || b.includes(a)) return true;
  const shown = words(a),
    extra = [...words(b)];
  return extra.length > 0 && extra.filter((word) => shown.has(word)).length / extra.length >= 0.5;
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="guided-option__detail">
      <span className="guided-option__label">{label}</span>
      <span>{children}</span>
    </span>
  );
}
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

/** What a card says beyond its title and description. Phrasing content only: it sits inside the card's label. */
function OptionDetails({ option, recommended }: { option: GuidedOption; recommended: boolean }) {
  const badge = recommended ? <span className="e-badge guided-option__recommended">Recommended</span> : null;
  const reason =
    recommended &&
    option.recommendationReason &&
    option.stage !== "competitors" &&
    option.stage !== "positioning" ? (
      <Detail label="Why we recommend it">{option.recommendationReason}</Detail>
    ) : null;
  if (option.stage === "competitors")
    return badge || !repeats(option.description, option.payload.relevance) ? (
      <>
        {badge}
        {!repeats(option.description, option.payload.relevance) && (
          <Detail label="Why it matters">{option.payload.relevance}</Detail>
        )}
      </>
    ) : null;
  if (option.stage === "audience")
    return (
      <>
        {badge}
        {option.payload.needs.length > 0 && <Detail label="What they need">{option.payload.needs.join(" · ")}</Detail>}
        {option.payload.reason.trim() !== option.description.trim() && (
          <Detail label="Why they fit">{option.payload.reason}</Detail>
        )}
        {reason}
      </>
    );
  if (option.stage === "positioning")
    return (
      <>
        {badge}
        <Detail label="Why it works">{option.payload.why}</Detail>
        <Detail label="What you’ll lead with">
          <Tags items={option.payload.leads} />
        </Detail>
      </>
    );
  if (option.stage === "personality")
    return (
      <>
        {badge}
        {option.payload.traits.length > 0 && (
          <Detail label="Traits">
            <Tags items={option.payload.traits} />
          </Detail>
        )}
        {option.payload.expression.trim() !== option.description.trim() && (
          <Detail label="How it comes to life">{option.payload.expression}</Detail>
        )}
        <Detail label="Example tone">
          <span className="guided-option__tone">“{option.payload.toneExample}”</span>
        </Detail>
        {reason}
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

/** The step's heading in the work area: its question and how to answer. */
export function StepHeading({
  title,
  hint,
  hintId,
  aside,
}: {
  title: string;
  hint?: ReactNode;
  hintId?: string;
  aside?: ReactNode;
}) {
  return (
    <div className="e-cluster e-cluster--between e-cluster--top conversation-step__head">
      <div className="e-stack e-stack--xs">
        <h2 className="e-section__title">{title}</h2>
        {hint ? (
          <p className="e-section__hint" id={hintId}>
            {hint}
          </p>
        ) : null}
      </div>
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
      <StepHeading
        title={reply.question}
        hint={stageHint(reply.stage, single)}
        hintId={`${id}-hint`}
        aside={
          !single && !competitors ? (
            <span className="e-section__hint" role="status">
              {selected.length} selected
            </span>
          ) : undefined
        }
      />
      <span id={`${id}-title`} hidden>
        {reply.question}
      </span>
      {options.length > 0 ? (
        <ChoiceGroup
          legend={reply.question}
          hideLegend
          describedBy={`${id}-hint`}
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
          text="No options are available for this question yet. You can reply in the chat."
        />
      )}
      {additionalControls}
      {competitors && (
        <p className="e-section__hint" role="status">
          {selected.length} selected.
          {selected.length === 0 ? " Choose at least one competitor to continue." : ""}
        </p>
      )}
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
      <StepHeading
        title={title ?? stageQuestions[stage]}
        hint={stage === "competitors" ? undefined : stageHint(stage, stage !== "audience")}
      />
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
export function GuidedChoicesEmpty({ stage, title, research }: { stage: GuidedStage; title?: string; research?: boolean }) {
  return (
    <section className="e-stack e-stack--lg conversation-step" aria-label={title ?? stageQuestions[stage]}>
      <StepHeading
        title={title ?? stageQuestions[stage]}
        hint={stage === "competitors" ? undefined : stageHint(stage, stage !== "audience")}
      />
      <EmptyState
        variant="results"
        icon={emptyStates[stage].icon}
        title={emptyStates[stage].title}
        text={
          research
            ? "They appear here when the research finishes."
            : "They appear here when the response finishes. You can also reply in the chat."
        }
      />
    </section>
  );
}

/** One answer inside a folded group (Strategy, Voice), with its own Edit button. */
export function FoldedPart({
  label,
  answers,
  editLabel = "Edit answer",
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
      <p>{answers.length ? answers.join(", ") : "Skipped for now. You can add it later."}</p>
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
  editLabel = "Edit answer",
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
