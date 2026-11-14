"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LogoConceptBatch } from "../../domain/logo-jobs";
import type { IdentityAssetReceipt } from "../../domain/logo-deliverables";
import type { LogoRasterSource } from "../../domain/logo-workspace";
import type { AccountLogoClient } from "../identity/account-logo-client";
import { ArtworkChoice } from "@/components/ui/choice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { MediaFrame } from "@/components/ui/media-frame";
import { useLogoReveal } from "@/features/logo-reveal/use-logo-reveal";
import { logoCandidateKey } from "./candidate-review";
import type { LogoCardVersion } from "./concept-versions";
import { acceptedConceptAttempt, CONCEPT_ORDINALS } from "./presentation";
import { useVerifiedPreview } from "./verified-preview";
import styles from "./logo-creation.module.css";

/** What one of the six tiles shows. Display only: the workspace owns requests and saving. */
type ConceptTile = {
  ordinal: number;
  slotId: string | null;
  /** The version the tile shows (the chosen one, the one picked in the version menu, or the latest). */
  version: LogoCardVersion | null;
  preview: IdentityAssetReceipt | null;
  source: LogoRasterSource | null;
  state: "ready" | "drawing" | "waiting" | "failed" | "loading" | "unavailable";
  selected: boolean;
};

/** The tile's version: the one viewed in the menu, else the chosen one when it is the newest choice, else the latest. */
export function shownVersion(
  history: readonly LogoCardVersion[],
  viewed: { key: string; count: number } | undefined,
  selectedVersion: LogoRasterSource | null,
  selectionAt: string | undefined,
): LogoCardVersion | undefined {
  const latest = history.at(-1);
  const saved = selectedVersion
    ? history.find((version) => version.key === logoCandidateKey(selectedVersion))
    : undefined;
  return (
    (viewed?.count === history.length ? history.find((item) => item.key === viewed.key) : undefined) ??
    (saved && selectionAt && latest && Date.parse(selectionAt) >= Date.parse(latest.createdAt) ? saved : latest)
  );
}

function conceptTiles({
  batch,
  versions,
  viewedVersions,
  selectedVersion,
  selectionAt,
  drawingSlotIds,
  undrawnSlotIds,
  savedBatchLoading,
  savedBatchUnavailable,
}: {
  batch: LogoConceptBatch | null;
  versions: Record<string, LogoCardVersion[]>;
  viewedVersions: Record<string, { key: string; count: number }>;
  selectedVersion: LogoRasterSource | null;
  selectionAt?: string;
  drawingSlotIds?: ReadonlySet<string>;
  undrawnSlotIds?: ReadonlySet<string>;
  savedBatchLoading: boolean;
  savedBatchUnavailable: boolean;
}): ConceptTile[] {
  return CONCEPT_ORDINALS.map((ordinal) => {
    const slot = batch?.slots.find((item) => item.ordinal === ordinal);
    const attempt = slot?.attempts.at(-1);
    const accepted = slot ? acceptedConceptAttempt(slot) : null;
    const history = slot ? (versions[slot.id] ?? []) : [];
    const version =
      (slot ? shownVersion(history, viewedVersions[slot.id], selectedVersion, selectionAt) : undefined) ?? null;
    const source: LogoRasterSource | null =
      version?.source ??
      (batch && slot && accepted
        ? { kind: "concept", batchId: batch.id, slotId: slot.id, attemptId: accepted.id }
        : null);
    const preview = version?.preview ?? accepted?.preview ?? null;
    const drawing = Boolean(slot && drawingSlotIds?.has(slot.id)) || attempt?.state === "running";
    const state: ConceptTile["state"] =
      preview && accepted
        ? "ready"
        : drawing
          ? "drawing"
          : attempt?.state === "queued"
            ? "waiting"
            : attempt?.state === "failed" ||
                attempt?.state === "cancelled" ||
                attempt?.state === "needs_reconciliation" ||
                (slot && undrawnSlotIds?.has(slot.id))
              ? "failed"
              : savedBatchUnavailable
                ? "unavailable"
                : batch && slot && !attempt
                  ? "waiting"
                  : "loading";
    return {
      ordinal,
      slotId: slot?.id ?? null,
      version,
      preview,
      source,
      state: savedBatchLoading && !batch ? "loading" : state,
      selected: Boolean(source && selectedVersion && logoCandidateKey(source) === logoCandidateKey(selectedVersion)),
    };
  });
}

/**
 * The six logo concepts (decision 4): artwork only, the whole picture chooses it, Enlarge in the corner, the logo
 * inset 12%. Two rows of three, sized from their own container so all six stay in view (decision 1). A concept being
 * made is a drawing frame; one that arrives while on screen draws itself from its own pixels (decision 5).
 * No polling, persistence or generation lives in this view.
 */
export function LogoConceptGridView({
  batch = null,
  client = null,
  title,
  subtitle,
  actions,
  notice,
  drawingSlotIds,
  undrawnSlotIds,
  savedBatchUnavailable = false,
  savedBatchLoading = false,
  versions = {},
  selectedVersion = null,
  selectionAt,
  viewedVersions = {},
  onSelectVersion,
}: {
  batch?: LogoConceptBatch | null;
  /** Verifies and loads each private preview as a blob URL. */
  client?: AccountLogoClient | null;
  title: ReactNode;
  /** The ready count or the chosen concept, under the title. */
  subtitle: ReactNode;
  /** The heading row's actions: the version menu, Download PNG, More concepts, Retry. */
  actions?: ReactNode;
  /** One message between the heading and the tiles (a failure with its retry, an out-of-credits message). */
  notice?: ReactNode;
  /** Slots a running round is still drawing (generation engine). */
  drawingSlotIds?: ReadonlySet<string>;
  /** Slots its round ended without drawing (stopped or timed out). */
  undrawnSlotIds?: ReadonlySet<string>;
  /** Saved concepts could not be verified; this is not a confirmed empty workspace. */
  savedBatchUnavailable?: boolean;
  /** Saved reads are incomplete; absence is not yet a confirmed empty workspace. */
  savedBatchLoading?: boolean;
  versions?: Record<string, LogoCardVersion[]>;
  selectedVersion?: LogoRasterSource | null;
  selectionAt?: string;
  viewedVersions?: Record<string, { key: string; count: number }>;
  /** Choosing is not final: Send (or Continue) commits it. Absent while a choice cannot be saved. */
  onSelectVersion?: (source: LogoRasterSource) => void;
}) {
  const tiles = conceptTiles({
    batch,
    versions,
    viewedVersions,
    selectedVersion,
    selectionAt,
    drawingSlotIds,
    undrawnSlotIds,
    savedBatchLoading,
    savedBatchUnavailable,
  });
  const [urls, setUrls] = useState<Record<number, string>>({});
  const [enlarged, setEnlarged] = useState<number | null>(null);
  const viewable = tiles.filter((tile) => tile.state === "ready" && urls[tile.ordinal]);
  const shown = enlarged === null ? null : (viewable.find((tile) => tile.ordinal === enlarged) ?? null);
  const position = shown ? viewable.indexOf(shown) : -1;
  return (
    <section className={styles.step} aria-label="Logo concepts" aria-busy={savedBatchLoading}>
      <header className={styles.stepHeader}>
        <div className="e-stack e-stack--xs">
          <h2 className={styles.stepTitle}>{title}</h2>
          <p className="e-muted" role="status" aria-live="polite">
            {subtitle}
          </p>
        </div>
        {actions ? <div className={styles.stepActions}>{actions}</div> : null}
      </header>
      {notice}
      <div className={styles.results}>
        <ol className={`${styles.resultGrid} e-grid-results`}>
          {tiles.map((tile) => (
            <li key={tile.ordinal} data-concept-ordinal={tile.ordinal} data-concept-slot={tile.slotId ?? undefined}>
              <ConceptTileView
                tile={tile}
                client={client}
                onUrl={(url) =>
                  setUrls((previous) =>
                    previous[tile.ordinal] === url
                      ? previous
                      : url
                        ? { ...previous, [tile.ordinal]: url }
                        : Object.fromEntries(
                            Object.entries(previous).filter(([ordinal]) => Number(ordinal) !== tile.ordinal),
                          ),
                  )
                }
                onChoose={tile.source && onSelectVersion ? () => onSelectVersion(tile.source!) : undefined}
                onEnlarge={() => setEnlarged(tile.ordinal)}
              />
            </li>
          ))}
        </ol>
      </div>
      {shown ? (
        <Dialog
          size="lg"
          media
          title={`Concept ${shown.ordinal + 1}`}
          onClose={() => setEnlarged(null)}
          footer={
            <>
              <Button
                icon="chevron-left"
                disabled={viewable.length < 2}
                onClick={() => setEnlarged(viewable[(position - 1 + viewable.length) % viewable.length]!.ordinal)}
              >
                Previous
              </Button>
              <Button
                disabled={viewable.length < 2}
                onClick={() => setEnlarged(viewable[(position + 1) % viewable.length]!.ordinal)}
              >
                Next
                <Icon name="chevron-right" size="sm" />
              </Button>
              <Button
                variant={shown.selected ? "secondary" : "primary"}
                aria-pressed={shown.selected}
                disabled={!onSelectVersion || !shown.source}
                onClick={() => {
                  if (shown.source && !shown.selected) onSelectVersion?.(shown.source);
                  setEnlarged(null);
                }}
              >
                {shown.selected ? "Chosen" : "Choose this concept"}
              </Button>
            </>
          }
        >
          <MediaFrame ratio="16x9" contain src={urls[shown.ordinal]} alt={`Concept ${shown.ordinal + 1}, enlarged`} />
          <p className="e-muted">
            {position + 1} of {viewable.length} concepts
          </p>
        </Dialog>
      ) : null}
    </section>
  );
}

function ConceptTileView({
  tile,
  client,
  onUrl,
  onChoose,
  onEnlarge,
}: {
  tile: ConceptTile;
  client: AccountLogoClient | null;
  onUrl: (url: string | null) => void;
  onChoose?: () => void;
  onEnlarge: () => void;
}) {
  const label = `Concept ${tile.ordinal + 1}`;
  const preview = useVerifiedPreview(client, tile.state === "ready" ? tile.preview : null);
  const report = useRef(onUrl);
  useEffect(() => {
    report.current = onUrl;
  });
  useEffect(() => {
    report.current(preview.url);
  }, [preview.url]);
  const host = useRef<HTMLDivElement>(null);
  const drawing = tile.state === "drawing" || tile.state === "waiting";
  // A concept that has arrived keeps its drawing frame until its picture is loaded, so it reveals in one movement.
  const ready = tile.state === "ready" && Boolean(preview.url);
  const reveal = useLogoReveal(host, drawing, ready);
  const frameState =
    tile.state === "ready"
      ? preview.url
        ? "loaded"
        : preview.failed
          ? "failed"
          : reveal.arriving
            ? "drawing"
            : "loading"
      : tile.state === "drawing" || tile.state === "waiting"
        ? "drawing"
        : tile.state === "failed" || tile.state === "unavailable"
          ? "failed"
          : "loading";
  return (
    <div ref={host} className={styles.tile}>
      <ArtworkChoice
        label={label}
        src={preview.url ?? undefined}
        state={frameState}
        status={tile.state === "waiting" ? "Waiting" : "Drawing"}
        failedText={
          tile.state === "ready"
            ? `${label} couldn’t be shown. It is still saved.`
            : tile.state === "unavailable"
              ? `${label} is unavailable right now.`
              : `${label} couldn’t be drawn.`
        }
        selected={tile.selected}
        disabled={!onChoose}
        onChoose={() => onChoose?.()}
        onEnlarge={onEnlarge}
        mediaClassName={reveal.className}
        overlay={
          reveal.revealing ? (
            <>
              <span className="e-media__handles" aria-hidden="true" />
              <span className="e-media__label" aria-hidden="true">
                {label}
              </span>
              <span className="e-media__status" aria-hidden="true">
                {reveal.status}
              </span>
            </>
          ) : null
        }
      />
    </div>
  );
}
