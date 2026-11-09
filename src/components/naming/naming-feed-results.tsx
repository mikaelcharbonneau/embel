"use client";
import { useState } from "react";
import type { ProjectNameEntry } from "@/domain/project-naming";
import { ProjectNameCard } from "./naming-results";
import type { NamingFeed } from "./use-naming-feed";

export function NamingFeedResults({ entries, feed, selectedId, strategyKey, pending, blocked, onRetain, onSelect, onInspect }: {
  entries: readonly ProjectNameEntry[]; feed: NamingFeed; selectedId?: string; strategyKey: string; pending: boolean; blocked: boolean;
  onRetain: (entry: ProjectNameEntry, field: "favorite" | "saved") => void; onSelect: (entry: ProjectNameEntry) => void; onInspect: (entry: ProjectNameEntry) => void;
}) {
  const [onlySaved, setOnlySaved] = useState(false);
  const kept = (entry: ProjectNameEntry) => entry.retention.favorite || entry.retention.saved;
  const shown = onlySaved ? entries.filter(kept) : entries;
  return <section className="project-naming-results naming-continuous-results" aria-label="Naming exploration">
    <div className="project-naming-section-heading">
      <h2 id="project-naming-results-heading" tabIndex={-1}>Which name feels right?</h2>
      {entries.length > 0 && <div className="naming-filter" role="group" aria-label="Show">
        <button type="button" aria-pressed={!onlySaved} onClick={() => setOnlySaved(false)}>All {entries.length}</button>
        <button type="button" aria-pressed={onlySaved} onClick={() => setOnlySaved(true)}>Saved {entries.filter(kept).length}</button>
      </div>}
      <p>{entries.length ? "Pick the one you like best. Details shows each name’s story and more checks." : "Names will follow the choices in your conversation."}</p>
    </div>
    <div className="project-naming-grid">{shown.map(entry => <div className="naming-feed-card" key={entry.candidate.id}><ProjectNameCard compact entry={entry} selected={selectedId === entry.candidate.id} earlierContext={entry.candidate.strategyKey !== strategyKey} pending={pending} blockSelection={blocked} onFavorite={() => onRetain(entry, "favorite")} onSave={() => onRetain(entry, "saved")} onSelect={() => onSelect(entry)} onInspect={() => onInspect(entry)} /></div>)}</div>
    <div className="naming-feed-tail" aria-live="polite" aria-atomic="true"><NamingFeedStatus feed={feed} blocked={blocked} /></div>
  </section>;
}

/** Generation status in plain words: progress with Stop, Stopped, a failure with Try again, or unavailable. */
export function NamingFeedStatus({ feed, blocked }: { feed: NamingFeed; blocked: boolean }) {
  const status = feed.status;
  switch (status.kind) {
    case "idle": return null;
    case "active": return <><p>{status.message}</p><button className="text-link" type="button" disabled={!feed.canStop} onClick={() => void feed.stop()}>Stop</button></>;
    case "starting": case "stopping": case "stopped": return <p>{status.message}</p>;
    case "unavailable": return <div className="project-naming-notice" role="status"><p>{status.message}</p><button type="button" className="text-link" disabled={blocked} onClick={() => void feed.refresh()}>Check again</button></div>;
    case "failed": case "error": return <div role="alert"><p>{status.message}</p><button type="button" className="button secondary small" disabled={blocked} onClick={() => void feed.retry()}>Try again</button></div>;
  }
}
