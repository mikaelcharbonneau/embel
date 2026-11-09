"use client";
import { ContextDetails } from "@/components/ui/context-details";

import { Icon } from "@/components/ui/icon";
import { NameSymbol } from "./name-candidate-card";
import type { ProjectNameEntry } from "@/domain/project-naming";
import styles from "./naming-chat.module.css";
import { DotComStatus } from "./dot-com-status";

export function ProjectNameCard({ entry, selected, earlierContext, pending, blockSelection, onFavorite, onSave, onSelect, onInspect, compact = false }: {
  entry: ProjectNameEntry; selected: boolean; earlierContext: boolean; pending: boolean; blockSelection: boolean;
  onFavorite: () => void; onSave: () => void; onSelect: () => void; onInspect?: () => void; compact?: boolean;
}) {
  const { candidate, retention } = entry;
  const origin = candidate.origin;
  // Compact cards: click to choose the name. Only the name, its .com status and
  // the heart are shown; Details opens its story and the other checks.
  if (compact && onInspect) return <article id={`project-name-${candidate.id}`} className={`project-naming-card ${styles.compactCard}${selected ? " is-selected" : ""}`} tabIndex={-1}>
    <h3 className="sr-only">{candidate.value}</h3>
    <button type="button" className={styles.openName} aria-pressed={selected} disabled={pending || blockSelection} onClick={onSelect}>
      <span className={styles.nameRadio} aria-hidden="true" />
      <span className={styles.nameValue}>{candidate.value}</span>
      <DotComStatus name={candidate.value} />
      {earlierContext && <span className={styles.nameNote}>Earlier strategy</span>}
      <span className="sr-only">{[selected ? "Chosen name" : "Choose this name", retention.saved ? "Saved" : ""].filter(Boolean).join(" · ")}</span>
    </button>
    <button className={`project-naming-favorite ${styles.heart}`} type="button" aria-label={`${retention.favorite ? "Unfavorite" : "Favorite"} ${candidate.value}`} aria-pressed={retention.favorite} disabled={pending} onClick={onFavorite}>
      {/* Exact original Figma heart export, native 16 × 16. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/naming/heart.svg" width={16} height={16} alt="" aria-hidden="true" />
    </button>
    <button type="button" className={styles.nameDetails} onClick={onInspect} aria-haspopup="dialog" aria-label={`Inspect name ${candidate.value}`}>Details</button>
  </article>;
  return <article id={`project-name-${candidate.id}`} className={`project-naming-card${selected ? " is-selected" : ""}`} tabIndex={-1}>
    <div className="project-naming-card-title"><h3>{candidate.value}</h3><button className="project-naming-favorite" type="button" aria-label={`${retention.favorite ? "Unfavorite" : "Favorite"} ${candidate.value}`} aria-pressed={retention.favorite} disabled={pending} onClick={onFavorite}><NameSymbol name="favorite" /></button></div>
    <div className="project-naming-badges">{selected ? <span className="is-selected">Selected</span> : null}{retention.favorite ? <span>Favorite</span> : null}{retention.saved ? <span>Saved</span> : null}{earlierContext ? <span>Earlier strategy</span> : null}</div>
    {origin.kind === "brainstorm" ? <span className="project-naming-muted">Unchecked brainstorm</span> : null}
    <p>{candidate.rationale}</p>
    {candidate.caution ? <p>{candidate.caution}</p> : null}
    <div className="project-naming-actions">{onInspect && <button className="button secondary small" type="button" onClick={onInspect} aria-haspopup="dialog">Inspect name<span className="sr-only"> {candidate.value}</span></button>}<button className="button secondary small" type="button" disabled={pending || blockSelection || selected} onClick={onSelect}>{selected ? "Selected name" : "Use this name"}{selected ? <Icon name="check" size={13} /> : null}</button><button className="text-link" type="button" disabled={pending} aria-pressed={retention.saved} onClick={onSave}>{retention.saved ? "Unsave" : "Save"}</button></div>
    <ContextDetails  title={<>Origin and tools</>}><p>{origin.kind === "brainstorm" ? "Unchecked brainstorm · research your shortlist before use." : origin.kind === "generated" ? `Generated with ${origin.model} · saved strategy version ${candidate.contextRevision}` : origin.kind === "local_import" ? "User-supplied name, entered directly or imported with its captured context." : origin.kind === "transform" ? `Deterministic workshop · ${origin.history.length} recorded transformation ${origin.history.length === 1 ? "step" : "steps"}` : "Copied from another account project with its original context and history."}</p>{origin.kind === "transform" || origin.kind === "account_copy" ? origin.history.map(step => <p key={step.transformId}>{step.input.kind}: {step.output}</p>) : null}</ContextDetails>
  </article>;
}
