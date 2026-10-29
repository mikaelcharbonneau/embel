"use client";
import { ContextDetails } from "@/components/ui/context-details";

import { useState, type FormEvent } from "react";
import { Icon } from "@/components/ui/icon";
import { NameSymbol } from "./name-candidate-card";
import { namingBatchTarget, type NamingViewState, type ProjectNameEntry } from "@/domain/project-naming";
import type { NamingBatchEntry, NamingJob, ProjectNamingOverview } from "@/domain/naming-jobs";
import { namingJobActive } from "./use-project-naming";
import styles from "./naming-chat.module.css";

export function namingFulfillmentLabel(entry: NamingBatchEntry) {
  if (!entry.result) return `0 / ${entry.batch.targetCount} names · awaiting completed results`;
  const result = entry.result.fulfillment;
  return `${result.acceptedCount} / ${result.targetCount} names${result.status === "partial" ? " · partial" : result.status === "none" ? " · none accepted" : ""}`;
}

export function ProjectNameCard({ entry, selected, earlierContext, pending, blockSelection, onFavorite, onSave, onSelect, onWorkshop, onInspect, compact = false }: {
  entry: ProjectNameEntry; selected: boolean; earlierContext: boolean; pending: boolean; blockSelection: boolean;
  onFavorite: () => void; onSave: () => void; onSelect: () => void; onWorkshop: () => void; onInspect?: () => void; compact?: boolean;
}) {
  const { candidate, retention } = entry;
  const origin = candidate.origin;
  if (compact && onInspect) return <article id={`project-name-${candidate.id}`} className={`project-naming-card ${styles.compactCard}${selected ? " is-selected" : ""}`} tabIndex={-1}>
    <h3 aria-label={candidate.value}><button type="button" className={styles.openName} onClick={onInspect} aria-label={`Inspect name ${candidate.value}`}>{candidate.value}</button></h3>
    <button className={`project-naming-favorite ${styles.heart}`} type="button" aria-label={`${retention.favorite ? "Unfavorite" : "Favorite"} ${candidate.value}`} aria-pressed={retention.favorite} disabled={pending} onClick={onFavorite}>
      {/* Exact original Figma heart export, native 16 × 16. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/naming/heart.svg" width={16} height={16} alt="" aria-hidden="true" />
    </button>
    {origin.kind === "brainstorm" ? <span className="project-naming-muted">Unchecked brainstorm</span> : null}
    <p>{candidate.rationale}</p>
    <span className="sr-only">{[selected ? "Selected name" : "", retention.saved ? "Saved" : "", earlierContext ? "Earlier strategy" : ""].filter(Boolean).join(" · ")}</span>
  </article>;
  return <article id={`project-name-${candidate.id}`} className={`project-naming-card${selected ? " is-selected" : ""}`} tabIndex={-1}>
    <div className="project-naming-card-title"><h3>{candidate.value}</h3><button className="project-naming-favorite" type="button" aria-label={`${retention.favorite ? "Unfavorite" : "Favorite"} ${candidate.value}`} aria-pressed={retention.favorite} disabled={pending} onClick={onFavorite}><NameSymbol name="favorite" /></button></div>
    <div className="project-naming-badges">{selected ? <span className="is-selected">Selected</span> : null}{retention.favorite ? <span>Favorite</span> : null}{retention.saved ? <span>Saved</span> : null}{earlierContext ? <span>Earlier strategy</span> : null}</div>
    {origin.kind === "brainstorm" ? <span className="project-naming-muted">Unchecked brainstorm</span> : null}
    <p>{candidate.rationale}</p>
    {candidate.caution ? <p>{candidate.caution}</p> : null}
    <div className="project-naming-actions">{onInspect && <button className="button secondary small" type="button" onClick={onInspect}>Inspect name<span className="sr-only"> {candidate.value}</span></button>}<button className="button secondary small" type="button" disabled={pending || blockSelection || selected} onClick={onSelect}>{selected ? "Selected name" : "Use this name"}{selected ? <Icon name="check" size={13} /> : null}</button><button className="text-link" type="button" disabled={pending} aria-pressed={retention.saved} onClick={onSave}>{retention.saved ? "Unsave" : "Save"}</button></div>
    <ContextDetails  title={<>Origin and tools</>}><p>{origin.kind === "brainstorm" ? "Unchecked brainstorm · research your shortlist before use." : origin.kind === "generated" ? `Generated with ${origin.model} · saved strategy version ${candidate.contextRevision}` : origin.kind === "local_import" ? "User-supplied name, entered directly or imported with its captured context." : origin.kind === "transform" ? `Deterministic workshop · ${origin.history.length} recorded transformation ${origin.history.length === 1 ? "step" : "steps"}` : "Copied from another account project with its original context and history."}</p>{origin.kind === "transform" || origin.kind === "account_copy" ? origin.history.map(step => <p key={step.transformId}>{step.input.kind}: {step.output}</p>) : null}<button className="text-link" type="button" disabled={pending || blockSelection} onClick={onWorkshop}>Use in workshop<Icon name="arrow" size={13} /></button></ContextDetails>
  </article>;
}

const jobLabels: Record<NamingJob["state"], string> = { queued: "Names queued", running: "Generating names", partial: "Partial response received", cancel_requested: "Cancellation requested", cancelled: "Generation cancelled", succeeded: "Request completed", failed: "Generation failed", needs_reconciliation: "Request needs reconciliation" };

function NamingJobStatus({ job, currentRevision, pending, onCancel }: { job: NamingJob; currentRevision: number; pending: boolean; onCancel: () => void }) {
  const active = namingJobActive(job);
  return <section className="project-naming-job" aria-label={`Batch ${job.sequence} job status`}>
    <div><strong role="status">{jobLabels[job.state]}</strong>{active ? <button className="text-link" type="button" disabled={pending || job.state === "cancel_requested"} onClick={onCancel}>{job.state === "cancel_requested" ? "Cancelling…" : "Cancel generation"}</button> : <span className="project-naming-eyebrow">Batch {job.sequence}</span>}</div>
    {active ? <><p>{job.state === "queued" ? "Waiting for the connected worker. Closing this page does not cancel the request." : job.state === "cancel_requested" ? "The worker will stop at its next safe boundary. Saved results remain available." : "The worker is processing this request. Names appear only after a complete response has been validated."}</p><progress value={job.progress} max={100} aria-label="Generation job progress" /></> : null}
    {job.state === "cancelled" ? <p>Saved results and earlier batches are retained.</p> : null}
    {job.state === "failed" ? <p>This request did not complete. Saved names remain available; a new batch is a separate request.</p> : null}
    {job.state === "needs_reconciliation" ? <p>The provider request could not be confirmed. It will not be retried automatically.</p> : null}
    {job.input_revision !== currentRevision && active ? <p>The saved project changed after this batch started. Its frozen context is retained; review the results against your current strategy.</p> : null}
  </section>;
}

export function NamingResults({ overview, view, pending, blocked, readFailed, listStatus, strategyKey, onView, onModify, onEnqueue, onCancel, onRetain, onSelect, onInspect, onWorkshop, onLoadMore, onLoadMoreBatches, historyOnly = false, compact = false }: {
  historyOnly?: boolean; compact?: boolean; overview: ProjectNamingOverview; view: NamingViewState; pending: boolean; blocked: boolean; readFailed: boolean; listStatus: "loading" | "failed" | "ready"; strategyKey: string;
  onView: (patch: Partial<NamingViewState>) => void; onModify: () => void; onEnqueue: () => void; onCancel: (job: NamingJob) => void;
  onInspect?: (entry: ProjectNameEntry) => void;
  onRetain: (entry: ProjectNameEntry, field: "favorite" | "saved") => void; onSelect: (entry: ProjectNameEntry) => void; onWorkshop: (entry: ProjectNameEntry) => void;
  onLoadMore: () => void; onLoadMoreBatches: () => void;
}) {
  const [searchDraft, setSearchDraft] = useState({ committed: view.query, value: view.query });
  // A saved listing may change while the next search is still being typed.
  // Reconcile clean drafts without replacing the input or discarding newer text.
  if (searchDraft.committed !== view.query) {
    setSearchDraft({ committed: view.query, value: searchDraft.value === searchDraft.committed ? view.query : searchDraft.value });
  }
  const query = searchDraft.value;
  function setQuery(value: string) { setSearchDraft({ committed: view.query, value }); }
  const entries = overview.candidates.items;
  const activeJob = overview.jobs.find(namingJobActive);
  const latestBatch = overview.batches.items.reduce<NamingBatchEntry | undefined>((latest, entry) => !latest || entry.batch.sequence > latest.batch.sequence ? entry : latest, undefined);
  const shownBatch = overview.batches.items.find(entry => entry.batch.id === view.visibleBatchId);
  const latestJob = activeJob ?? overview.jobs[0];
  const target = namingBatchTarget((overview.session?.latestBatchSequence ?? 0) + 1);
  const count = listStatus === "loading" ? "Updating names…" : listStatus === "failed" && !entries.length ? "Count unavailable" : entries.length ? `${entries.length} names loaded${overview.candidates.nextCursor ? " · more available" : ""}` : "0 names in this view";
  function search(event: FormEvent<HTMLFormElement>) { event.preventDefault(); onView({ query, scrollCandidateId: null }); }
  return <section className="project-naming-results" aria-label="Naming results">
    <div className="project-naming-section-heading"><div><h2 id="project-naming-results-heading" tabIndex={-1}>{shownBatch ? namingFulfillmentLabel(shownBatch) : "All names"}</h2><p>{shownBatch ? `Batch ${shownBatch.batch.sequence} · preferences ${shownBatch.batch.preferencesVersion}` : latestBatch ? `${latestBatch.batch.sequence === overview.session?.latestBatchSequence ? "Latest batch" : "Latest loaded batch"} · ${latestBatch.batch.sequence} · ${namingFulfillmentLabel(latestBatch)}` : "Choose a name when it feels right. Favorites guide future batches."}</p></div><div className="project-naming-actions"><button className="button secondary small" type="button" disabled={pending} onClick={onModify}>Modify filters<Icon name="settings" size={14} /></button></div></div>
    {(shownBatch ?? latestBatch)?.result?.fulfillment.message ? <p className="project-naming-notice">{(shownBatch ?? latestBatch)!.result!.fulfillment.message}</p> : null}
    {latestJob ? <NamingJobStatus job={latestJob} currentRevision={overview.project.current_revision} pending={pending} onCancel={() => onCancel(latestJob)} /> : null}
    {overview.batches.items.length ? <ContextDetails className="project-naming-batch-history" title={<>Batch history · {overview.batches.items.length} loaded</>}><ol>{overview.batches.items.map(entry => <li key={entry.batch.id}><button type="button" disabled={pending} aria-pressed={view.visibleBatchId === entry.batch.id} onClick={() => onView({ visibleBatchId: entry.batch.id, scrollCandidateId: null })}><span>Batch {entry.batch.sequence} · preferences {entry.batch.preferencesVersion}</span><span>{namingFulfillmentLabel(entry)}</span></button></li>)}</ol>{overview.batches.nextCursor ? <button className="text-link" type="button" disabled={pending} onClick={onLoadMoreBatches}>Load more batches</button> : null}</ContextDetails> : null}
    {overview.session || entries.length ? <form className="project-naming-toolbar" onSubmit={search}>
      <label><span className="sr-only">Search project names</span><input type="search" placeholder="Search names" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} /></label><button className="button secondary small" type="submit" disabled={pending}>Search</button>
      <label><span className="sr-only">Filter project names</span><select aria-label="Filter project names" value={view.filter} disabled={pending} onChange={event => onView({ filter: event.target.value as NamingViewState["filter"], scrollCandidateId: null })}><option value="all">All names</option><option value="favorite">Favorites</option><option value="saved">Saved</option><option value="retained">Favorite, saved or selected</option></select></label>
      <label><span className="sr-only">Shown batch</span><select aria-label="Shown batch" value={view.visibleBatchId ?? ""} disabled={pending} onChange={event => onView({ visibleBatchId: event.target.value || null, scrollCandidateId: null })}><option value="">All batches and workshop</option>{overview.batches.items.map(entry => <option key={entry.batch.id} value={entry.batch.id}>Batch {entry.batch.sequence}</option>)}</select></label><span className="project-naming-results-count">{count}</span>
    </form> : null}
    {/* Reserve anonymous space, never the previous query's names or actions. */}
    <div className="project-naming-results-body" aria-busy={listStatus === "loading"}>
    {entries.length ? <div className="project-naming-grid">{entries.map(entry => <ProjectNameCard compact={compact} key={entry.candidate.id} entry={entry} selected={overview.currentSelection?.candidate.id === entry.candidate.id} earlierContext={entry.candidate.strategyKey !== strategyKey} pending={pending} blockSelection={blocked || readFailed} onFavorite={() => onRetain(entry, "favorite")} onSave={() => onRetain(entry, "saved")} onInspect={onInspect ? () => onInspect(entry) : undefined} onSelect={() => onSelect(entry)} onWorkshop={() => onWorkshop(entry)} />)}</div> : listStatus !== "ready" ? <p className="project-naming-notice" role="status">{listStatus === "loading" ? "Loading names in this view…" : "This list could not be loaded. Check the latest version to try again."}</p> : !activeJob ? <div className="project-naming-empty"><h3>{view.filter !== "all" || view.query || view.visibleBatchId ? "No names in this view" : "Let a direction take shape"}</h3><p>{view.filter !== "all" || view.query || view.visibleBatchId ? "Your earlier names are retained. Change the filters to explore them." : overview.preferences ? "Your preferences are saved. Start one batch when you are ready." : "Review your Naming choices in the conversation before starting exploration."}</p>{view.filter !== "all" || view.query || view.visibleBatchId ? <button className="button secondary small" type="button" disabled={pending} onClick={() => { setQuery(""); onView({ filter: "all", query: "", visibleBatchId: null }); }}>View all names</button> : null}</div> : null}
    </div>
    {overview.candidates.nextCursor ? <div className="project-naming-next"><button className="button secondary" type="button" disabled={pending} onClick={onLoadMore}>Load more saved names</button></div> : null}
    {!historyOnly && <div className="project-naming-next"><button className="button primary" type="button" disabled={pending || blocked || readFailed || Boolean(activeJob) || !overview.preferences || !overview.readiness.ready || overview.availability.status !== "available"} onClick={onEnqueue}>{pending ? "Saving…" : `Generate ${target} ${overview.session?.latestBatchSequence ? "more " : ""}names`}<Icon name="arrow" size={15} /></button>
      {overview.availability.status === "available" ? <p className="project-naming-muted">One request using your ChatGPT plan. Limits: {overview.availability.limits.maxRequestsPerHour} requests per hour, {overview.availability.limits.maxQueuedJobs} queued jobs and {Math.ceil(overview.availability.limits.deadlineMs / 1000)} seconds per request. ChatGPT plan limits apply.</p> : <p className="project-naming-muted">{availabilityMessage(overview.availability.reason)}</p>}
      {overview.preferences ? <p className="project-naming-muted">Uses preferences {overview.preferences.version} and your current favorites. Earlier batches stay unchanged.</p> : null}
    </div>}
  </section>;
}

export function availabilityMessage(reason: Extract<ProjectNamingOverview["availability"], { status: "unavailable" }>["reason"]) {
  const reasons = { runtime_disabled: "Naming generation is unavailable in this runtime.", naming_policy_unavailable: "Naming is not enabled for this ChatGPT connection. Check the selected text model in Settings.", worker_unavailable: "The connected worker is unavailable. You can keep exploring saved names.", subscription_unavailable: "The ChatGPT connection is unavailable. Reconnect in Settings before generating names.", quota_unavailable: "The current request allowance is unavailable. You can keep exploring saved names.", scope_unavailable: "Naming is outside this project's current scope.", strategy_incomplete: "Review the current Strategy before generating names for this brand." };
  return reasons[reason];
}
