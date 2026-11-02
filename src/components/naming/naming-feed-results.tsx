"use client";
import type { ProjectNameEntry } from "@/domain/project-naming";
import { ProjectNameCard } from "./naming-results";
import type { useNamingFeed } from "./use-naming-feed";
export function NamingFeedResults({ feed, selectedId, strategyKey, pending, blocked, onRetain, onSelect, onInspect, onWorkshop, onModify, onHistory }: {
  feed: ReturnType<typeof useNamingFeed>; selectedId?: string; strategyKey: string; pending: boolean; blocked: boolean;
  onRetain: (entry: ProjectNameEntry, field: "favorite" | "saved") => void; onSelect: (entry: ProjectNameEntry) => void; onInspect: (entry: ProjectNameEntry) => void; onWorkshop: (entry: ProjectNameEntry) => void; onModify: () => void; onHistory: () => void;
}) {
  return <section className="project-naming-results naming-continuous-results" aria-label="Naming exploration">
    <div className="project-naming-section-heading"><div><h2 id="project-naming-results-heading" tabIndex={-1}>All names · {feed.entries.length}</h2><p>{feed.entries.length ? "Open a name to explore its story and variations." : "Your exploration starts from the choices in your conversation."}</p></div><div className="project-naming-actions"><button className="button secondary small" type="button" onClick={onHistory}>Saved names &amp; history</button><button className="button secondary small" type="button" onClick={onModify}>Naming choices</button></div></div>
    <div className="project-naming-grid">{feed.entries.map(row => <div className="naming-feed-card" key={row.entryId}><ProjectNameCard compact entry={row.entry} selected={selectedId === row.entry.candidate.id} earlierContext={row.entry.candidate.strategyKey !== strategyKey} pending={pending} blockSelection={blocked} onFavorite={() => onRetain(row.entry, "favorite")} onSave={() => onRetain(row.entry, "saved")} onSelect={() => onSelect(row.entry)} onInspect={() => onInspect(row.entry)} onWorkshop={() => onWorkshop(row.entry)} /></div>)}</div>
    <div ref={element => feed.attachSentinel(element)} className="naming-feed-tail" aria-live="polite" aria-atomic="true">
      <NamingFeedTail feed={feed} blocked={blocked} onModify={onModify} />
    </div>
  </section>;
}

type NamingFeedTailProps = { feed: ReturnType<typeof useNamingFeed>; blocked: boolean; onModify: () => void; onReviewSaved?: () => void };

// Persisted fulfillment messages can describe an earlier running snapshot.
// Terminal presentation follows the acknowledged run state, not that old copy.
function terminalMessage(state: string, recoveredNameCount = 0) {
  return state === "needs_reconciliation" ? recoveredNameCount > 0
    ? "Recovered names are saved and can be used. The remaining provider outcome or cost still needs verification."
    : "A previous request has an unconfirmed outcome. Saved names are retained."
    : state === "cancelled" ? "This exploration was stopped. Your saved names remain available."
      : state === "failed" ? "This exploration could not finish. Your saved names remain available."
        : "This exploration ended before a complete set was saved. Your saved names remain available.";
}

export function NamingFeedTail(props: NamingFeedTailProps) {
  const current = props.feed.state?.feed;
  return <>
    {current?.failure && current.availability.status === "available" && <p role="status">{current.failure.code === "provider_budget_control_unavailable" ? "A previous generation request could not start with its saved provider settings." : "The previous generation request was rejected by the provider."} Your saved names and choices are kept.</p>}
    <NamingFeedCurrentStatus {...props} />
  </>;
}

function NamingFeedCurrentStatus({ feed, blocked, onModify, onReviewSaved }: NamingFeedTailProps) {
  const state = feed.state, active = state?.feed?.activeRun, prior = state?.outcome;
  const outcome = prior && prior.status === state?.status && !("run" in prior && active && (active.runId !== prior.run.runId || active.revision > prior.run.revision)) ? prior : null;
  const incomplete = active?.fulfillment && active.fulfillment.status !== "complete"
    && ["partial", "failed", "cancelled", "needs_reconciliation"].includes(active.state) ? active.fulfillment : null;
  const incompleteSummary = incomplete ? <p><strong>Incomplete exploration.</strong> {incomplete.acceptedCount} of {incomplete.targetCount} names saved.{incomplete.missingCount === 0 && !incomplete.coverageSatisfied ? " Some selected naming approaches are still missing." : ""}</p> : null;
  const reviewSaved = incomplete && incomplete.acceptedCount > 0 && onReviewSaved
    ? <button type="button" className="button secondary small" onClick={onReviewSaved}>View saved names</button> : null;
  const configurationFailure = state?.feed?.availability.status === "unavailable"
    && (state.feed.availability.code === "provider_budget_control_unavailable" || state.feed.failure?.retryable === false);
  if (configurationFailure && !state?.stop && !active?.canResumeSaved && !active?.state.match(/^(queued|running|cancel_requested|needs_reconciliation)$/)) return <div role="alert"><strong>AI name generation is unavailable</strong><p>{state?.feed?.failure && state.feed.failure.code !== "provider_budget_control_unavailable" ? "The previous generation request was rejected by the provider. " : ""}The generation service is currently unavailable. Your saved names and choices are kept. Contact support if it remains unavailable.</p>{incomplete && incomplete.acceptedCount > 0 ? incompleteSummary : null}{reviewSaved}<button type="button" className="button secondary small" onClick={() => void feed.refresh()}>Check generation status</button></div>;
  if (state?.error) return <div role="alert"><p>{state.error}</p>{state.stopConflict ? <div className="project-naming-actions"><button type="button" className="button secondary small" onClick={() => void feed.refresh()}>Check saved state</button><button type="button" className="button secondary small" disabled={!state.stop || !state.feed || state.feed.demandSequence <= state.stop.expectedDemandSequence} onClick={() => void feed.stopCurrent()}>Stop current exploration</button></div> : <button type="button" className="button secondary small" onClick={() => void feed.retry()}>{state.stop ? "Retry stopping exploration" : state.pending || state.steering ? "Retry the same request" : "Check saved names"}</button>}</div>;
  if (state?.stop) return <p>Saving your pause… Names already created remain available.</p>;
  if (active?.canResumeSaved && (state?.feed?.paused || state?.feed?.preparedSetId)) return <>{incompleteSummary}<p>Saved names are ready to explore.</p>{reviewSaved}<button type="button" className="button secondary small" disabled={blocked || !feed.canResume} onClick={() => void feed.resume()}>Continue with saved names</button></>;
  if (outcome?.status === "incomplete") return <>
    <p>{terminalMessage((active ?? outcome.run).state, (active ?? outcome.run).recoveredNameCount)}</p><p><strong>Incomplete exploration.</strong> {outcome.fulfillment.acceptedCount} of {outcome.fulfillment.targetCount} names saved. Earlier names stay available.</p>{reviewSaved}
    {(active ?? outcome.run).canResume ? <button type="button" className="button secondary small" disabled={blocked || !feed.canResume} onClick={() => void feed.resume()}>Resume unfinished exploration</button> : <p>This outcome needs resolution before another request can start.</p>}
    <button type="button" className="text-link" onClick={onModify}>Review Naming choices</button>
  </>;
  if (outcome?.status === "blocked" || outcome?.status === "paused") return <>
    <p>{outcome.message}</p>{outcome.action === "retry" ? <button type="button" className="button secondary small" onClick={() => void feed.retry()}>Retry this request</button> : <button type="button" className="text-link" onClick={outcome.action === "review_preferences" ? onModify : () => void feed.refresh()}>Check {outcome.action === "review_preferences" ? "Naming choices" : "saved state"}</button>}
  </>;
  if (active && ["queued", "running", "cancel_requested"].includes(active.state)) return <>
    <p>{active.state === "queued" ? "Preparing your next names…" : active.state === "cancel_requested" ? "Stopping at a safe point. Completed names stay saved." : "Exploring your next names…"}</p>
    <button className="text-link" type="button" onClick={() => void feed.stop()} disabled={active.state === "cancel_requested"}>Stop exploration</button>
  </>;
  if (active?.generationProfile === "brainstorm_v1" && active.state === "succeeded") return <p>{active.fulfillment?.acceptedCount ?? active.progress} unchecked brainstorm names are saved. Research your shortlist before use.{active.fulfillment?.coverageSatisfied === false ? " Some selected naming approaches have fewer examples." : ""}</p>;
  if (active && ["partial", "failed", "cancelled", "needs_reconciliation"].includes(active.state)) return <>
    {incompleteSummary}{reviewSaved}
    <p>{terminalMessage(active.state, active.recoveredNameCount)}</p>
    {active.canResume ? <button type="button" className="button secondary small" disabled={blocked || !feed.canResume} onClick={() => void feed.resume()}>Resume unfinished exploration</button> : <button type="button" className="button secondary small" onClick={() => void feed.refresh()}>Check saved result</button>}
    {active.state !== "needs_reconciliation" ? <button type="button" className="text-link" onClick={onModify}>Review Naming choices</button> : null}
  </>;
  if (state?.status === "pending") return <><p>Checking your next names…</p><button type="button" className="text-link" onClick={() => void feed.stop()}>Stop exploration</button></>;
  if (state?.feed?.availability.status === "unavailable") return <p>New Naming exploration is unavailable. You can keep working with saved names.</p>;
  if (state?.status === "blocked") return <><p>New exploration is paused. Your saved names remain available.</p><button type="button" className="text-link" onClick={() => void feed.refresh()}>Check saved state</button></>;
  if (state?.stopped && (feed.entries.length || state.feed?.paused)) return <><p>Exploration is paused. Your names are saved.</p><button type="button" className="button secondary small" disabled={blocked || !feed.canExplore} onClick={() => void feed.start()}>Continue exploring</button></>;
  if (state?.status === "loading") return <p>Loading saved names…</p>;
  if (feed.entries.length && !feed.canExplore) return <><p>Review and save your Naming choices to continue exploration.</p><button className="text-link" type="button" onClick={onModify}>Review Naming choices</button></>;
  return feed.entries.length ? <><p>{feed.interacting ? "Keep scrolling to explore more names." : "Exploration pauses while you are away. Scroll to continue."}</p><button type="button" className="text-link" onClick={() => void feed.stop()}>Pause exploration</button></> : null;
}
