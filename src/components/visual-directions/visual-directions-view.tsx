"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { isDialogBackdropClick } from "@/components/ui/dialog-backdrop";
import { DirectionTypeSample } from "./direction-type-sample";
import stage from "@/styles/branding-stage.module.css";
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
  logoDownload?: ReactNode;
  backHref?: string;
  cards: readonly [VisualDirectionCard | null, VisualDirectionCard | null, VisualDirectionCard | null];
  generation: VisualDirectionGeneration;
  selectionCheck?: { busy: boolean; onCheck(): void };
  selectionStatus?: string | null;
  selectionError?: string | null;
  finalAction?: ReactNode;
  history?: ReactNode;
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

/** Presentation only. Callers supply verified previews, saved choices and request state. */
export function VisualDirectionsView({ brandName, logoPreview, logoDownload, backHref, cards, generation, selectionCheck,
  selectionStatus, selectionError, finalAction, history }: VisualDirectionsViewProps) {
  const titleId = useId(), generationId = useId(), reasonId = useId(), dialogTitleId = useId();
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), triggers = useRef(new Map<string, HTMLButtonElement>());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expanded = cards.find(card => card?.id === expandedId) ?? null;
  if (expandedId && !expanded) setExpandedId(null);
  const previousExpanded = useRef<string | null>(null);
  const unresolved = ["queued", "running", "stopping", "uncertain"].includes(generation.status);
  const canGenerate = Boolean(generation.onGenerate && !generation.busy && !generation.disabledReason && !unresolved);
  const completed = Math.max(0, Math.min(3, Math.floor(generation.completed)));
  const comparing = cards.some(Boolean);
  const finished = generation.status === "complete" && completed === 3;
  const progress = progressMessages[generation.status];

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (expanded) {
      previousExpanded.current = expanded.id;
      if (!element.open) element.showModal();
    } else if (element.open) {
      element.close();
      const trigger = previousExpanded.current ? triggers.current.get(previousExpanded.current) : undefined;
      (trigger ?? heading.current)?.focus({ preventScroll: true });
      previousExpanded.current = null;
    }
  }, [expanded]);

  function choose(card: VisualDirectionCard) {
    if (!card.selected && !card.stale && !card.pending && !card.disabledReason) card.onChoose?.();
  }

  return <section className={`${stage.frame} ${styles.workspace}`} aria-labelledby={titleId}>
    <header className={styles.header}>
      <div>
        <p className={stage.eyebrow}>Build your brand · Step 2 of 3</p>
        <h1 className={stage.title} ref={heading} id={titleId} tabIndex={-1}>Visual direction</h1>
        <p className={stage.intro}>Compare three ways to bring {brandName} to life.</p>
      </div>
      <ol className={styles.steps} aria-label="Branding steps">
        <li><span>1</span> Logo concept</li>
        <li aria-current="step"><span>2</span> Visual direction</li>
        <li><span>3</span> Brand assets</li>
      </ol>
    </header>

    <section className={styles.logoStrip} aria-label="Chosen logo">
      <div className={styles.logoPreview}>{logoPreview}</div>
      <div className={styles.logoDescription}><p className={styles.label}>Chosen logo</p><h2 className={stage.sectionHeading}>{brandName}</h2><p>Each direction builds on this concept.</p></div>
      {backHref && <Link className={styles.textButton} href={backHref}>Change logo <span aria-hidden="true">↗</span></Link>}
      {logoDownload && <div className={styles.logoDownload}>{logoDownload}</div>}
    </section>

    <section className={styles.generation} aria-labelledby={generationId}>
      <div className={styles.generationHeading}><div><h2 className={stage.sectionHeading} id={generationId}>{comparing ? "Compare visual directions" : "Explore three directions"}</h2>
        {selectionStatus ? <p className={styles.selectionStatus} role="status">{selectionStatus}</p> : <p>{comparing ? "Choose the look that fits your brand." : "Color, typography and example uses, together in one board."}</p>}</div>
        <div className={styles.generationControls}>
          {finalAction && <div className={styles.finalAction}>{finalAction}</div>}
          <div className={styles.generateAction}>
            <button className={comparing || finalAction ? styles.secondaryButton : styles.primaryButton} type="button" disabled={!canGenerate}
              aria-describedby={generation.disabledReason ? reasonId : undefined}
              onClick={() => { if (canGenerate) generation.onGenerate?.(); }}>
              {unresolved ? generation.status === "stopping" ? "Stopping…" : generation.status === "uncertain" ? "Checking request…" : "Creating directions…"
                : generation.busy ? "Please wait…" : generation.status === "idle" ? "Generate three directions" : "Generate another set"}
            </button>
          </div>
        </div>
      </div>
      {generation.disabledReason && <p id={reasonId} className={styles.helper}>{generation.disabledReason}</p>}
      {generation.error && <p className={styles.error} role="alert">{generation.error}</p>}
      {(!progress || finished) && generation.onCheck && (generation.disabledReason || generation.error) && <button type="button" className={styles.textButton} disabled={generation.busy} onClick={generation.onCheck}>Check availability</button>}
      {finished && <div className={styles.finishedStatus} role="status"><span>3 of 3 ready</span>{generation.usageLabel && <span>{generation.usageLabel}</span>}</div>}
      {progress && !finished && <div className={styles.progressArea}>
        <div className={styles.progressCopy} role="status"><span className={styles.progressCount}>{completed} of 3 ready</span><p>{progress}</p></div>
        <div className={styles.progressActions}>
          {generation.onCheck && <button type="button" className={styles.textButton} disabled={generation.busy} onClick={generation.onCheck}>Check progress</button>}
          {unresolved && generation.onStop && <button type="button" className={styles.secondaryButton} disabled={generation.busy || generation.status === "stopping"} onClick={generation.onStop}>{generation.status === "stopping" ? "Stop requested" : "Stop generation"}</button>}
        </div>
      </div>}
      {!finished && generation.usageLabel && <p className={styles.usage}>{generation.usageLabel}</p>}
    </section>

    {selectionCheck && cards.some(Boolean) && <div className={styles.progressActions}>
      <button type="button" className={styles.secondaryButton} disabled={selectionCheck.busy} onClick={selectionCheck.onCheck}>
        {selectionCheck.busy ? "Checking saved choice…" : "Check saved choice"}
      </button>
    </div>}
    {selectionError && <p className={styles.error} role="alert">{selectionError}</p>}

    <div className={styles.cards} aria-label="Direction comparison">
      {cards.map((card, index) => card ? <article key={card.id} className={styles.card} data-selected={Boolean(card.selected && !card.stale)}>
        <div className={styles.cardTop}><span className={styles.cardNumber}>Direction {index + 1}</span>
          {card.stale ? <span className={styles.staleBadge}>Earlier inputs</span> : card.selected && <span className={styles.selectedBadge}><CheckIcon /> Chosen</span>}
        </div>
        <header className={styles.cardIntro}>
          <div className={styles.cardTitle}><h3 className={stage.subheading}>{card.title}</h3><button type="button" className={styles.expandButton} aria-label={`View ${card.title} larger`}
            ref={node => { if (node) triggers.current.set(card.id, node); else triggers.current.delete(card.id); }}
            onClick={() => setExpandedId(card.id)}><ExpandIcon /></button></div>
          {card.summary && <p className={styles.summary}>{card.summary}</p>}
        </header>
        {(card.swatches?.length || card.sampleStyle) ? <div className={styles.designDetails}>
          {!!card.swatches?.length && <div><p className={styles.detailLabel}>Palette</p><ul className={styles.swatches} aria-label="Color palette">
            {card.swatches.map(({ name, hex }, index) => <li key={index} title={`${name} ${hex}`} style={{ backgroundColor: hex }}>
              <span className={styles.visuallyHidden}>{name} {hex}</span>
            </li>)}
          </ul></div>}
          {card.sampleStyle && <div><p className={styles.detailLabel}>Typography</p>
            <DirectionTypeSample style={card.sampleStyle} brandName={brandName} />
          </div>}
        </div> : null}
        <div className={styles.preview}>{card.preview}</div>
        <div className={styles.cardBody}>
          {card.stale && <p className={styles.cardNotice}>This board uses earlier inputs. Generate directions for the current logo.</p>}
          {card.disabledReason && <p className={styles.cardNotice}>{card.disabledReason}</p>}
          <div className={styles.cardActions}>
            <button type="button" className={card.selected && !card.stale ? styles.chosenButton : styles.secondaryButton}
              disabled={!card.onChoose || card.selected || card.stale || card.pending || Boolean(card.disabledReason)} onClick={() => choose(card)}>
              {card.pending ? "Saving choice…" : card.selected && !card.stale ? <><CheckIcon /> Chosen direction</> : "Choose direction"}
            </button>
            {card.onDownload && <button type="button" className={styles.textButton} disabled={card.downloadBusy} onClick={card.onDownload}>{card.downloadBusy ? "Preparing…" : "Download preview"}</button>}
          </div>
        </div>
      </article> : <article key={`empty-${index}`} className={`${styles.card} ${styles.emptyCard}`} aria-label={`Direction ${index + 1}`}>
        <div className={styles.cardTop}><span className={styles.cardNumber}>Direction {index + 1}</span></div>
        <div className={styles.placeholder}><BoardIcon /><p>{unresolved ? "Your board will appear here" : generation.status === "idle" ? "A new point of view" : "No board saved for this direction"}</p></div>
        <div className={styles.emptyCaption}>{unresolved ? "Created around your chosen logo" : generation.status === "idle" ? "Generate your directions to start comparing." : "Your other completed boards stay available."}</div>
      </article>)}
    </div>

    {!finalAction && <p className={styles.nextHint}>Choose a direction to continue to your brand assets.</p>}
    {history}

    <dialog ref={dialog} className={styles.dialog} aria-labelledby={dialogTitleId}
      onCancel={event => { event.preventDefault(); setExpandedId(null); }} onClose={() => setExpandedId(null)}
      onClick={event => { if (isDialogBackdropClick(event)) setExpandedId(null); }}>
      {expanded && <><header className={styles.dialogHeader}><div><p className={styles.label}>Visual direction</p><h2 className={stage.sectionHeading} id={dialogTitleId}>{expanded.title}</h2></div>
        <button type="button" className={styles.closeButton} aria-label="Close larger preview" onClick={() => setExpandedId(null)}>×</button></header>
        <div className={styles.dialogPreview}>{expanded.preview}</div>
        {expanded.summary && <p className={styles.dialogSummary}>{expanded.summary}</p>}
      </>}
    </dialog>
  </section>;
}

function CheckIcon() { return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="m3.5 8 3 3 6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function ExpandIcon() { return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M10.5 3.5h4v4m0-4L10 8M7.5 14.5h-4v-4m0 4L8 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function BoardIcon() { return <svg aria-hidden="true" width="52" height="52" viewBox="0 0 52 52" fill="none"><rect x="7" y="7" width="38" height="38" rx="5" stroke="currentColor" strokeWidth="1.2" /><path d="M7 29h38M29 7v22" stroke="currentColor" strokeWidth="1.2" /><circle cx="18" cy="18" r="4" stroke="currentColor" strokeWidth="1.2" /><path d="M34 16h6m-6 5h4M14 35h12m-12 4h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>; }
