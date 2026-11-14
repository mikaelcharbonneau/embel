"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { DirectionTypeSample } from "./direction-type-sample";
import { EmbelIdentity } from "@/components/workspace/embel-identity";
import { journeyPartLabel } from "@/domain/journey";
import { Button, IconButton, Spinner } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { WorkAreaLayer } from "@/components/workspace/work-area-layer";
import { useWorkspaceOverlayHost, useWorkspaceResultRows } from "@/components/workspace/workspace-slots";
import { EmptyState } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/icon";
import { InlineMessage } from "@/components/ui/message";
import { MediaFrame } from "@/components/ui/media-frame";
import styles from "./visual-directions-view.module.css";

export type VisualDirectionCard = {
  id: string;
  title: string;
  summary?: string;
  swatches?: readonly { name: string; hex: string }[];
  sampleStyle?: { family: string; weight: number; style: string } | null;
  preview: ReactNode;
  selected?: boolean;
  stale?: boolean;
  pending?: boolean;
  disabledReason?: string;
  onChoose?: () => void;
  onDownload?: () => void;
  downloadBusy?: boolean;
};

export type VisualDirectionGeneration = {
  status: "idle" | "queued" | "running" | "stopping" | "partial" | "complete" | "failed" | "uncertain" | "cancelled";
  completed: number;
  usageLabel?: string | null;
  error?: string | null;
  disabledReason?: string | null;
  busy?: boolean;
  onGenerate?: () => void;
  onCheck?: () => void;
  onStop?: () => void;
};

export type VisualDirectionsViewProps = {
  brandName: string;
  logoPreview: ReactNode;
  backHref?: string;
  cards: readonly [VisualDirectionCard | null, VisualDirectionCard | null, VisualDirectionCard | null];
  generation: VisualDirectionGeneration;
  selectionCheck?: { busy: boolean; onCheck(): void };
  selectionStatus?: string | null;
  selectionError?: string | null;
  finalAction?: ReactNode;
  history?: ReactNode;
  /** In the project conversation, the step sits in the chat column instead of its own page frame. */
  variant?: "page" | "conversation";
  /** A Send-driven reply box moves the step on: the step hides its own message, Stop and Continue. */
  reply?: "inline" | "external";
  /** Credits in place (D-014, D-015): the Out-of-credits message or the 0-credits note, at More directions. */
  creditsNotice?: ReactNode;
};

const progressMessages: Record<VisualDirectionGeneration["status"], string | null> = {
  idle: null,
  queued: "Your directions are queued.",
  running: "Creating your directions. Completed boards stay available.",
  stopping: "Stopping after work already in progress.",
  partial: "This set is incomplete. Its saved boards are still available.",
  complete: "Your saved directions are ready to compare.",
  failed: "This set could not finish. Your saved work is kept.",
  uncertain: "Check the existing request before starting another. Saved boards stay available.",
  cancelled: "Generation stopped. Any completed boards are kept.",
};

/**
 * Creative direction: three direction boards in one row, each with its number, name, palette and typography and a
 * real Choose button (decision 10: the cards keep their design; the design system's look marks the chosen one with
 * the ring only). Enlarge opens a larger view with previous, next and Choose this direction.
 * Presentation only. Callers supply verified previews, saved choices and request state.
 */
export function VisualDirectionsView({
  brandName,
  logoPreview,
  backHref,
  cards,
  generation,
  selectionCheck,
  selectionStatus,
  selectionError,
  finalAction,
  history,
  variant = "page",
  reply = "inline",
  creditsNotice,
}: VisualDirectionsViewProps) {
  const titleId = useId(),
    reasonId = useId();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // In the Workspace the larger view opens over the work area only, so the chat stays usable beside it.
  const overlay = useWorkspaceOverlayHost();
  // In the Workspace the work column narrows so the row of three boards stays in view (decision 1).
  useWorkspaceResultRows(1);
  const ready = cards.flatMap((card, index) => (card ? [{ card, index }] : []));
  const expanded = ready.find(({ card }) => card.id === expandedId) ?? null;
  if (expandedId && !expanded) setExpandedId(null);
  const unresolved = ["queued", "running", "stopping", "uncertain"].includes(generation.status);
  const canGenerate = Boolean(generation.onGenerate && !generation.busy && !generation.disabledReason && !unresolved);
  const completed = Math.max(0, Math.min(3, Math.floor(generation.completed)));
  const comparing = ready.length > 0;
  const finished = generation.status === "complete" && completed === 3;
  const progress = progressMessages[generation.status];
  const chosen = ready.find(({ card }) => card.selected && !card.stale)?.card;
  const external = reply === "external";

  function choose(card: VisualDirectionCard) {
    if (!card.selected && !card.stale && !card.pending && !card.disabledReason) card.onChoose?.();
  }
  const heading =
    unresolved && !finished
      ? "Drawing your directions"
      : chosen
        ? "Your direction"
        : comparing
          ? "Choose the direction that feels right"
          : "Creative directions";
  const subtitle = chosen && !unresolved ? `${chosen.title} · ${ready.length} directions` : `${completed} of 3 ready`;

  // In the project conversation the brand's name is the page's heading and the step is a second-level heading.
  const StepHeading = variant === "conversation" ? "h2" : "h1";
  return (
    <section
      className={variant === "conversation" ? styles.workspace : `${styles.page} ${styles.workspace}`}
      aria-labelledby={titleId}
    >
      <StepHeading className="sr-only" id={titleId} tabIndex={-1}>
        Creative direction
      </StepHeading>
      {!external && (
        <div className="guided-assistant-message identity-conversation-message">
          <EmbelIdentity label={journeyPartLabel("identity", "Creative direction")} />
          <p className="guided-assistant-copy">
            Here are three ways to bring {brandName} to life, each built on your chosen logo. Choose the one that feels
            right.
          </p>
          <section className={`identity-chosen-logo-row ${styles.chosenLogo}`} aria-label="Chosen logo">
            <div className="identity-chosen-logo">{logoPreview}</div>
            <span className={styles.chosenLogoLabel}>Your logo</span>
            {backHref && (
              <Link className="e-link" href={backHref}>
                Change logo
              </Link>
            )}
          </section>
        </div>
      )}

      <section className={styles.generation} aria-label="Creative directions">
        <header className={styles.header}>
          <div className="e-stack e-stack--xs">
            <h2 className={styles.title}>{heading}</h2>
            <p className="e-muted">
              {/* Its own element: "3 of 3 ready" is read as one status. */}
              <span>{subtitle}</span>
            </p>
          </div>
          <div className={styles.actions}>
            {/* With the reply box, progress is told in the chat; Check progress stays for an uncertain request. */}
            {progress && !finished && generation.onCheck && (!external || generation.status === "uncertain") && (
              <Button variant="quiet" disabled={generation.busy} onClick={generation.onCheck}>
                Check progress
              </Button>
            )}
            {!external && progress && !finished && unresolved && generation.onStop && (
              <Button disabled={generation.busy || generation.status === "stopping"} onClick={generation.onStop}>
                {generation.status === "stopping" ? "Stop requested" : "Stop generation"}
              </Button>
            )}
            {/* After a set that could not be drawn, Try again in the chat is the one way to start again. */}
            {!(external && !comparing && generation.status === "failed") && (
              <Button
                variant={comparing || finalAction || external ? "secondary" : "primary"}
                disabled={!canGenerate}
                aria-describedby={generation.disabledReason ? reasonId : undefined}
                onClick={() => {
                  if (canGenerate) generation.onGenerate?.();
                }}
              >
                {unresolved && !external
                  ? generation.status === "stopping"
                    ? "Stopping…"
                    : generation.status === "uncertain"
                      ? "Checking request…"
                      : "Creating directions…"
                  : generation.busy
                    ? "Please wait…"
                    : generation.status === "idle"
                      ? "Create three directions"
                      : "More directions"}
              </Button>
            )}
          </div>
        </header>
        {/* With the reply box the chat says what is happening and the heading what is chosen. */}
        {!external && (
          <div className={styles.messages} role="status" aria-live="polite">
            {selectionStatus && <span className="e-muted">{selectionStatus}</span>}
            {progress && !finished && <span className="e-muted">{progress}</span>}
            {generation.usageLabel && <span className="e-muted">{generation.usageLabel}</span>}
          </div>
        )}
        {generation.disabledReason && (
          <p id={reasonId} className="e-muted">
            {generation.disabledReason}
          </p>
        )}
        {creditsNotice}
        {generation.error && (
          <InlineMessage
            tone="danger"
            actions={
              (!progress || finished) && generation.onCheck ? (
                <Button icon="refresh-cw" disabled={generation.busy} onClick={generation.onCheck}>
                  Check availability
                </Button>
              ) : undefined
            }
          >
            {generation.error}
          </InlineMessage>
        )}
        {!generation.error && (!progress || finished) && generation.onCheck && generation.disabledReason && (
          <Button variant="quiet" disabled={generation.busy} onClick={generation.onCheck}>
            Check availability
          </Button>
        )}
        {selectionCheck && comparing && (
          <Button disabled={selectionCheck.busy} onClick={selectionCheck.onCheck}>
            {selectionCheck.busy ? "Checking saved choice…" : "Check saved choice"}
          </Button>
        )}
        {selectionError && <InlineMessage tone="warning">{selectionError}</InlineMessage>}

        {!comparing && !unresolved && generation.status !== "idle" ? (
          <EmptyState
            icon="palette"
            variant="results"
            headingLevel={3}
            title="No directions yet"
            text="They appear here when the boards are drawn."
          />
        ) : (
          <div className={styles.results}>
            <div className={`${styles.cards} e-grid-results`} aria-label="Direction comparison">
              {cards.map((card, index) =>
                card ? (
                  <DirectionCard
                    key={card.id}
                    card={card}
                    index={index}
                    brandName={brandName}
                    onChoose={() => choose(card)}
                    onEnlarge={() => setExpandedId(card.id)}
                  />
                ) : (
                  <article
                    key={`empty-${index}`}
                    className="e-choice e-choice--image"
                    aria-label={`Direction ${index + 1}`}
                    aria-busy={unresolved || undefined}
                  >
                    <div className="e-media" data-state="loading" aria-hidden="true" />
                    <div className={styles.cardBody}>
                      <div className={styles.cardTop}>
                        <span className={styles.cardTitle}>Direction {index + 1}</span>
                        {unresolved ? (
                          <span className={styles.drawing}>
                            <Spinner /> Drawing
                          </span>
                        ) : null}
                      </div>
                      {!unresolved && (
                        <p className="e-muted">
                          {generation.status === "idle"
                            ? "Generate your directions to start comparing."
                            : "No board saved for this direction. Your other completed boards stay available."}
                        </p>
                      )}
                    </div>
                  </article>
                ),
              )}
            </div>
          </div>
        )}
      </section>

      {!external && (
        <div className={styles.footer}>
          {!finalAction && <p className="e-muted">Choose a direction to continue to your brand assets.</p>}
          {finalAction}
        </div>
      )}
      {history}

      {expanded ? (
        <WorkAreaLayer host={overlay} onEscape={() => setExpandedId(null)}>
          <Dialog
            size="lg"
            media
            modal={!overlay}
            title={expanded.card.title}
            description={`Direction ${expanded.index + 1} of 3`}
            onClose={() => setExpandedId(null)}
            footer={
              <>
                <Button
                  icon="chevron-left"
                  disabled={ready.length < 2}
                  onClick={() => {
                    const at = ready.indexOf(expanded);
                    setExpandedId(ready[(at - 1 + ready.length) % ready.length]!.card.id);
                  }}
                >
                  Previous
                </Button>
                <Button
                  disabled={ready.length < 2}
                  onClick={() => {
                    const at = ready.indexOf(expanded);
                    setExpandedId(ready[(at + 1) % ready.length]!.card.id);
                  }}
                >
                  Next
                  <Icon name="chevron-right" size="sm" />
                </Button>
                <Button
                  variant={expanded.card.selected ? "secondary" : "primary"}
                  aria-pressed={Boolean(expanded.card.selected && !expanded.card.stale)}
                  disabled={
                    !expanded.card.onChoose ||
                    expanded.card.stale ||
                    expanded.card.pending ||
                    Boolean(expanded.card.disabledReason)
                  }
                  onClick={() => {
                    choose(expanded.card);
                    setExpandedId(null);
                  }}
                >
                  {expanded.card.selected && !expanded.card.stale ? "Chosen" : "Choose this direction"}
                </Button>
              </>
            }
          >
            <div className={styles.enlarged}>{expanded.card.preview}</div>
            {expanded.card.summary && <p className="e-muted">{expanded.card.summary}</p>}
          </Dialog>
        </WorkAreaLayer>
      ) : null}
    </section>
  );
}

function DirectionCard({
  card,
  index,
  brandName,
  onChoose,
  onEnlarge,
}: {
  card: VisualDirectionCard;
  index: number;
  brandName: string;
  onChoose: () => void;
  onEnlarge: () => void;
}) {
  const titleId = useId();
  const selected = Boolean(card.selected && !card.stale);
  const blocked = !card.onChoose || card.stale || card.pending || Boolean(card.disabledReason);
  return (
    <article
      className="e-choice e-choice--image"
      data-selected={selected || undefined}
      aria-busy={card.pending || undefined}
      aria-label={`Direction ${index + 1}: ${card.title}`}
    >
      {/* The board keeps the simple blur reveal (decision 5: the drawing effect is for logo concepts only). */}
      <div className={`e-media ${styles.board}`}>{card.preview}</div>
      <span className="e-choice__enlarge">
        <IconButton
          icon="maximize-2"
          label={`Enlarge Direction ${index + 1}, ${card.title}`}
          variant="on-artwork"
          size="sm"
          onClick={onEnlarge}
        />
      </span>
      <div className={styles.cardBody}>
        <div className="e-stack e-stack--xs">
          <span className="e-muted">Direction {index + 1}</span>
          <h3 className={styles.cardTitle} id={titleId}>
            {card.title}
          </h3>
        </div>
        {card.swatches?.length || card.sampleStyle ? (
          <div className={styles.details}>
            {!!card.swatches?.length && (
              <div className="e-stack e-stack--xs">
                <p className="e-muted">Palette</p>
                <ul className={styles.swatches} aria-label="Color palette">
                  {card.swatches.map(({ name, hex }, swatch) => (
                    <li key={swatch} title={`${name} ${hex}`} style={{ backgroundColor: hex }}>
                      <span className="sr-only">
                        {name} {hex}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {card.sampleStyle && (
              <div className="e-stack e-stack--xs">
                <p className="e-muted">Typography</p>
                <DirectionTypeSample style={card.sampleStyle} brandName={brandName} />
              </div>
            )}
          </div>
        ) : null}
        {card.stale && (
          <p className="e-muted">This board uses earlier inputs. Generate directions for the current logo.</p>
        )}
        {card.disabledReason && !card.stale && <p className="e-muted">{card.disabledReason}</p>}
        <div className={styles.cardActions}>
          <Button
            size="sm"
            aria-pressed={selected}
            aria-describedby={titleId}
            loading={card.pending}
            disabled={!selected && blocked && !card.pending}
            onClick={() => {
              if (!selected) onChoose();
            }}
          >
            {selected ? "Chosen" : "Choose"}
          </Button>
          {card.onDownload && (
            <Button size="sm" variant="quiet" disabled={card.downloadBusy} onClick={card.onDownload}>
              {card.downloadBusy ? "Preparing…" : "Download preview"}
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

/**
 * A finished brand (IMG-021): "Your brand" with the chosen direction's board large, marked as chosen, and the chosen
 * logo beside it with its name. Change direction on the folded entry in the chat brings the three boards back.
 * Presentation only: callers supply verified previews.
 */
export function ChosenBrandView({
  title,
  board,
  enlarged,
  logo,
}: {
  /** The chosen direction's name ("Editorial Soft Shapes"). */
  title: string;
  board: ReactNode;
  /** The whole board for the larger view. */
  enlarged: ReactNode;
  logo: { url: string | null; failed: boolean; label: string | null };
}) {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const overlay = useWorkspaceOverlayHost();
  return (
    <section className={styles.workspace} aria-labelledby={titleId}>
      <h2 className={styles.title} id={titleId} tabIndex={-1}>
        Your brand
      </h2>
      <div className={styles.brand}>
        <article className="e-choice e-choice--image" data-selected aria-label={`Chosen direction: ${title}`}>
          <div className={`e-media ${styles.board}`}>{board}</div>
          <span className="e-choice__enlarge">
            <IconButton
              icon="maximize-2"
              label={`Enlarge ${title}`}
              variant="on-artwork"
              size="sm"
              onClick={() => setOpen(true)}
            />
          </span>
          <div className={styles.brandFooter}>
            <span className={styles.cardTitle}>{title}</span>
            <span className="e-badge">
              <Icon name="check" size="sm" />
              Chosen direction
            </span>
          </div>
        </article>
        <figure className={styles.brandLogo}>
          <MediaFrame
            ratio="16x9"
            contain
            inset
            src={logo.url ?? undefined}
            alt="Your logo"
            state={logo.url ? "loaded" : logo.failed ? "failed" : "loading"}
            failedText="Your logo couldn’t be shown. It is still saved."
          />
          <figcaption className="e-muted">Your logo{logo.label ? ` · ${logo.label}` : ""}</figcaption>
        </figure>
      </div>
      {open ? (
        <WorkAreaLayer host={overlay} onEscape={() => setOpen(false)}>
          <Dialog size="lg" media modal={!overlay} title={title} onClose={() => setOpen(false)}>
            <div className={styles.enlarged}>{enlarged}</div>
          </Dialog>
        </WorkAreaLayer>
      ) : null}
    </section>
  );
}
