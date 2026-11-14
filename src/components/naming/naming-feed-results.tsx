"use client";
import { useId, useState, type ReactNode } from "react";
import { Button, IconButton } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/feedback";
import type { ProjectNameEntry } from "@/domain/project-naming";
import { NAMING_RUN_TARGET } from "@/domain/naming-generation";
import type { NamingFeed } from "./use-naming-feed";
import styles from "./naming-chat.module.css";

/** Names shown at once; "Show 40 more names" reveals the next ones. The engine writes 100 names a run. */
export const NAMES_PAGE = 40;

/**
 * The Name step's work: every name as a compact one-row card, four across in the work area. The whole name is the
 * choice (a radio, visually hidden; the ring alone shows the chosen one); Details and the heart are quiet icon
 * buttons. Choosing marks the name; Send in the reply box moves on.
 */
export function NamingFeedResults({
  entries,
  feed,
  selectedId,
  strategyKey,
  pending,
  blocked,
  onRetain,
  onSelect,
  onInspect,
  manual,
}: {
  entries: readonly ProjectNameEntry[];
  feed: NamingFeed;
  selectedId?: string;
  strategyKey: string;
  pending: boolean;
  blocked: boolean;
  onRetain: (entry: ProjectNameEntry, field: "favorite" | "saved") => void;
  onSelect: (entry: ProjectNameEntry) => void;
  onInspect: (entry: ProjectNameEntry) => void;
  /** The "Add your own name" form, when names can be added. */
  manual?: ReactNode;
}) {
  const group = useId();
  const [onlySaved, setOnlySaved] = useState(false);
  const [limit, setLimit] = useState(NAMES_PAGE);
  const [manualOpen, setManualOpen] = useState(false);
  const kept = (entry: ProjectNameEntry) => entry.retention.favorite || entry.retention.saved;
  const savedCount = entries.filter(kept).length;
  const list = onlySaved ? entries.filter(kept) : entries;
  const shown = list.slice(0, limit);
  const run = feed.state?.feed?.run;
  const writing = feed.status.kind === "active" || feed.status.kind === "starting";
  // While names are being written, the rest of the page shows their final shape.
  const coming = writing ? Math.max(0, run ? run.target - run.savedCount : NAMING_RUN_TARGET) : 0;
  const skeletons = onlySaved ? 0 : Math.max(0, Math.min(limit, entries.length + coming) - shown.length);
  const hidden = list.length - shown.length;
  return (
    <section className={styles.names} aria-label="Naming exploration">
      <div className={styles.namesHead}>
        <h2 id="project-naming-results-heading" tabIndex={-1}>
          Which name feels right?
        </h2>
        {entries.length > 0 && (
          <div className="e-segmented" role="group" aria-label="Show">
            <button
              type="button"
              className="e-segmented__item"
              aria-pressed={!onlySaved}
              onClick={() => setOnlySaved(false)}
            >
              All {entries.length}
            </button>
            <button
              type="button"
              className="e-segmented__item"
              aria-pressed={onlySaved}
              onClick={() => setOnlySaved(true)}
            >
              Saved {savedCount}
            </button>
          </div>
        )}
        <p className={styles.namesHint}>
          {entries.length || writing
            ? "Pick the one you like best. Details shows each name’s story and more checks."
            : "Names will follow the choices in your conversation."}
        </p>
      </div>
      {onlySaved && !savedCount ? (
        <div className={styles.namesEmpty}>
          <p>You haven’t saved any names yet. Press the heart on a name to keep it here.</p>
          <div>
            <Button size="sm" onClick={() => setOnlySaved(false)}>
              Show all {entries.length} names
            </Button>
          </div>
        </div>
      ) : (
        (shown.length > 0 || skeletons > 0) && (
          <div className="e-name-grid" role="radiogroup" aria-label="Names" aria-busy={writing || undefined}>
            {shown.map((entry) => (
              <NameCard
                key={entry.candidate.id}
                group={group}
                entry={entry}
                selected={selectedId === entry.candidate.id}
                earlierContext={entry.candidate.strategyKey !== strategyKey}
                pending={pending}
                blocked={blocked}
                onFavorite={() => onRetain(entry, "favorite")}
                onSelect={() => onSelect(entry)}
                onInspect={() => onInspect(entry)}
              />
            ))}
            {Array.from({ length: skeletons }, (_, index) => (
              <div key={`skeleton-${index}`} className="e-name-card e-name-card--skeleton" aria-hidden="true">
                <Skeleton width={60} className={styles.skeletonLine} />
              </div>
            ))}
          </div>
        )
      )}
      <div className={styles.namesActions}>
        <Button
          icon={writing ? undefined : "refresh"}
          loading={writing}
          disabled={!feed.canMore || blocked}
          onClick={() => void feed.more()}
        >
          Suggest more names
        </Button>
        {manual && (
          <Button icon="plus" aria-expanded={manualOpen} onClick={() => setManualOpen((open) => !open)}>
            Add your own name
          </Button>
        )}
        {hidden > 0 && (
          <Button icon="chevron-down" onClick={() => setLimit((value) => value + NAMES_PAGE)}>
            Show {Math.min(NAMES_PAGE, hidden)} more names
          </Button>
        )}
        {list.length > 0 && (
          <span className={styles.namesCount}>
            {shown.length} of {list.length} names
          </span>
        )}
      </div>
      {manual && manualOpen && <div>{manual}</div>}
    </section>
  );
}

function NameCard({
  group,
  entry,
  selected,
  earlierContext,
  pending,
  blocked,
  onFavorite,
  onSelect,
  onInspect,
}: {
  group: string;
  entry: ProjectNameEntry;
  selected: boolean;
  earlierContext: boolean;
  pending: boolean;
  blocked: boolean;
  onFavorite: () => void;
  onSelect: () => void;
  onInspect: () => void;
}) {
  const { candidate, retention } = entry;
  return (
    <div id={`project-name-${candidate.id}`} className="e-name-card" data-selected={selected || undefined}>
      <label className="e-check">
        <input
          type="radio"
          className="e-box"
          name={group}
          value={candidate.id}
          checked={selected}
          disabled={pending || blocked}
          onChange={onSelect}
        />
        <span className="e-name-card__name">
          {candidate.value}
          {earlierContext && <span className={styles.nameNote}>Earlier strategy</span>}
          {retention.saved && <span className="e-sr"> · Saved</span>}
        </span>
      </label>
      <IconButton
        size="sm"
        icon="info"
        label={`Details for ${candidate.value}`}
        aria-haspopup="dialog"
        tooltip={false}
        onClick={onInspect}
      />
      <IconButton
        size="sm"
        icon="heart"
        label={`${retention.favorite ? "Unfavorite" : "Favorite"} ${candidate.value}`}
        pressed={retention.favorite}
        tooltip={false}
        disabled={pending}
        onClick={onFavorite}
      />
    </div>
  );
}

/** Generation status in plain words for the chat: progress (with Stop), Stopped, a failure with Try again, or
 * unavailable. `stopInReplyBox` leaves Stop to the reply box. */
export function NamingFeedStatus({
  feed,
  blocked,
  stopInReplyBox = false,
}: {
  feed: NamingFeed;
  blocked: boolean;
  stopInReplyBox?: boolean;
}) {
  const status = feed.status;
  switch (status.kind) {
    case "idle":
      return null;
    case "active":
      return (
        <div className="e-progress">
          <div className="e-progress__row">
            <p className="e-progress__status">{status.message}</p>
            {!stopInReplyBox && (
              <button className="text-link" type="button" disabled={!feed.canStop} onClick={() => void feed.stop()}>
                Stop
              </button>
            )}
          </div>
          <div className="e-progress__track" aria-hidden="true" />
        </div>
      );
    case "starting":
    case "stopping":
    case "stopped":
      return <p>{status.message}</p>;
    case "unavailable":
      return (
        <div className="project-naming-notice" role="status">
          <p>{status.message}</p>
          <button type="button" className="text-link" disabled={blocked} onClick={() => void feed.refresh()}>
            Check again
          </button>
        </div>
      );
    case "failed":
    case "error":
      return (
        <div role="alert">
          <p>{status.message}</p>
          <button type="button" className="button secondary small" disabled={blocked} onClick={() => void feed.retry()}>
            Try again
          </button>
        </div>
      );
  }
}
