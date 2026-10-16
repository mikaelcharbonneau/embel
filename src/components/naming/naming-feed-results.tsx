"use client";
import { useState } from "react";
import type { ProjectNameEntry } from "@/domain/project-naming";
import { ProjectNameCard } from "./naming-results";
import type { useNamingFeed } from "./use-naming-feed";
export function NamingFeedResults({ feed, selectedId, strategyKey, pending, blocked, onRetain, onSelect, onInspect, onWorkshop, onModify, onHistory }: {
  feed: ReturnType<typeof useNamingFeed>; selectedId?: string; strategyKey: string; pending: boolean; blocked: boolean;
  onRetain: (entry: ProjectNameEntry, field: "favorite" | "saved") => void; onSelect: (entry: ProjectNameEntry) => void; onInspect: (entry: ProjectNameEntry) => void; onWorkshop: (entry: ProjectNameEntry) => void; onModify: () => void; onHistory: () => void;
}) {
  const [seeds, setSeeds] = useState<string[]>([]), [instruction, setInstruction] = useState("");
  const state = feed.state;
  return <section className="project-naming-results naming-continuous-results" aria-label="Naming exploration">
    <div className="project-naming-section-heading"><div><h2 id="project-naming-results-heading" tabIndex={-1}>Explore names</h2><p>{feed.entries.length ? `${feed.entries.length} distinct names` : "Choose your approaches, then continue to explore 100 names."}</p></div><div className="project-naming-actions"><button className="button secondary small" type="button" onClick={onHistory}>Saved names &amp; history</button><button className="button secondary small" type="button" onClick={onModify}>Naming choices</button></div></div>
    {seeds.length ? <div className="naming-steering-bar"><p>{seeds.length} {seeds.length === 1 ? "name" : "names"} selected to guide upcoming exploration. Your other approaches remain included.</p><label>Anything to emphasize? <small>Optional</small><input maxLength={2000} value={instruction} onChange={event => setInstruction(event.target.value)} /></label><div className="project-naming-actions"><button className="button primary small" type="button" disabled={blocked || !feed.canExplore || Boolean(state?.steering)} onClick={() => void feed.steer(seeds, instruction.trim() || null).then(ok => { if (ok) { setSeeds([]); setInstruction(""); } })}>{state?.steering ? "Saving direction…" : "More like these"}</button><button className="text-link" type="button" disabled={Boolean(state?.steering)} onClick={() => setSeeds([])}>Clear selection</button></div></div> : null}
    <div className="project-naming-grid">{feed.entries.map(row => <div className="naming-feed-card" key={row.entryId}><ProjectNameCard entry={row.entry} selected={selectedId === row.entry.candidate.id} earlierContext={row.entry.candidate.strategyKey !== strategyKey} pending={pending} blockSelection={blocked} onFavorite={() => onRetain(row.entry, "favorite")} onSave={() => onRetain(row.entry, "saved")} onSelect={() => onSelect(row.entry)} onInspect={() => onInspect(row.entry)} onWorkshop={() => onWorkshop(row.entry)} /><label className="naming-steering-choice"><input type="checkbox" checked={seeds.includes(row.entry.candidate.id)} disabled={blocked || !feed.canExplore || Boolean(state?.steering) || seeds.length >= 5 && !seeds.includes(row.entry.candidate.id)} onChange={() => setSeeds(values => values.includes(row.entry.candidate.id) ? values.filter(id => id !== row.entry.candidate.id) : [...values, row.entry.candidate.id])} />More like this<span className="sr-only">: {row.entry.candidate.value}</span></label></div>)}</div>
    <div ref={element => feed.attachSentinel(element)} className="naming-feed-tail" aria-live="polite" aria-atomic="true">
      <NamingFeedTail feed={feed} blocked={blocked} onModify={onModify} />
    </div>
  </section>;
}

function NamingFeedTail({ feed, blocked, onModify }: { feed: ReturnType<typeof useNamingFeed>; blocked: boolean; onModify: () => void }) {
  const state = feed.state, active = state?.feed?.activeRun, prior = state?.outcome;
  const outcome = prior && prior.status === state?.status && !("run" in prior && active && (active.runId !== prior.run.runId || active.revision > prior.run.revision)) ? prior : null;
  if (state?.error) return <div role="alert"><p>{state.error}</p>{state.stopConflict ? <div className="project-naming-actions"><button type="button" className="button secondary small" onClick={() => void feed.refresh()}>Check saved state</button><button type="button" className="button secondary small" disabled={!state.stop || !state.feed || state.feed.demandSequence <= state.stop.expectedDemandSequence} onClick={() => void feed.stopCurrent()}>Stop current exploration</button></div> : <button type="button" className="button secondary small" onClick={() => void feed.retry()}>{state.stop ? "Retry stopping exploration" : state.pending || state.steering ? "Retry the same request" : "Check saved names"}</button>}</div>;
  if (state?.stop) return <p>Saving your pause… Names already created remain available.</p>;
  if (active?.canResume && active.preparedSetId && active.fulfillment?.status === "complete" && (state?.feed?.paused || state?.feed?.preparedSetId)) return <><p>Your next names are saved and ready to explore.</p><button type="button" className="button secondary small" disabled={blocked || !feed.canResume} onClick={() => void feed.resume()}>Continue with saved names</button></>;
  if (outcome?.status === "incomplete") return <>
    <p>{outcome.message}</p><p>{outcome.fulfillment.acceptedCount} of 100 names saved. Earlier names stay available.</p>
    {(active ?? outcome.run).canResume ? <button type="button" className="button secondary small" disabled={blocked || !feed.canResume} onClick={() => void feed.resume()}>Resume unfinished exploration</button> : <p>This outcome needs resolution before another request can start.</p>}
  </>;
  if (outcome?.status === "blocked" || outcome?.status === "paused") return <>
    <p>{outcome.message}</p>{outcome.action === "retry" ? <button type="button" className="button secondary small" onClick={() => void feed.retry()}>Retry this request</button> : <button type="button" className="text-link" onClick={outcome.action === "review_preferences" ? onModify : () => void feed.refresh()}>Check {outcome.action === "review_preferences" ? "Naming choices" : "saved state"}</button>}
  </>;
  if (active && ["queued", "running", "cancel_requested"].includes(active.state)) return <>
    <p>{active.state === "queued" ? "Preparing your next names…" : active.state === "cancel_requested" ? "Stopping at a safe point. Completed names stay saved." : "Exploring your next names…"}</p>
    <button className="text-link" type="button" onClick={() => void feed.stop()} disabled={active.state === "cancel_requested"}>Stop exploration</button>
  </>;
  if (active && ["partial", "failed", "cancelled", "needs_reconciliation"].includes(active.state)) return <>
    <p>{active.state === "needs_reconciliation" ? "A previous request has an unconfirmed outcome. Saved names are retained." : active.fulfillment?.message ?? "This exploration stopped before a complete set was saved. Earlier names remain available."}</p>
    {active.canResume ? <button type="button" className="button secondary small" disabled={blocked || !feed.canResume} onClick={() => void feed.resume()}>Resume unfinished exploration</button> : <button type="button" className="button secondary small" onClick={() => void feed.refresh()}>Check saved result</button>}
  </>;
  if (state?.status === "pending") return <><p>Checking your next names…</p><button type="button" className="text-link" onClick={() => void feed.stop()}>Stop exploration</button></>;
  if (state?.feed?.availability.status === "unavailable") return <p>New Naming exploration is unavailable. You can keep working with saved names.</p>;
  if (state?.status === "blocked") return <><p>New exploration is paused. Your saved names remain available.</p><button type="button" className="text-link" onClick={() => void feed.refresh()}>Check saved state</button></>;
  if (state?.stopped && (feed.entries.length || state.feed?.paused)) return <><p>Exploration is paused. Your names are saved.</p><button type="button" className="button secondary small" disabled={blocked || !feed.canExplore} onClick={() => void feed.start()}>Continue exploring</button></>;
  if (state?.status === "loading") return <p>Loading saved names…</p>;
  if (feed.entries.length && !feed.canExplore) return <><p>Review and save your Naming choices to continue exploration.</p><button className="text-link" type="button" onClick={onModify}>Review Naming choices</button></>;
  return feed.entries.length ? <><p>{feed.interacting ? "Keep scrolling to explore more names." : "Exploration pauses while you are away. Scroll to continue."}</p><button type="button" className="text-link" onClick={() => void feed.stop()}>Pause exploration</button></> : null;
}
