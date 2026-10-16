"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AccountRequestError } from "@/components/workspace/account-api";
import { AccountStatus, useAccountSession } from "@/components/workspace/account-session";
import {
  enqueueStandaloneNamesSchema, standaloneNamesActive, standaloneNamesJobResponseSchema, standaloneNamesOverviewSchema,
  STANDALONE_NAMES_MAX_DEPTH, type EnqueueStandaloneNames, type StandaloneNamesBrief, type StandaloneNamesJob, type StandaloneNamesOverview,
} from "@/domain/standalone-names";
import { standaloneNamesRequest } from "./standalone-names-client";
import "./standalone-names.css";

type State = {
  ownerId: string | null; brief: StandaloneNamesBrief; overview: StandaloneNamesOverview | null;
  selectedJobId: string | null; refinement: { sourceJobId: string; indexes: number[] } | null;
  instruction: string; pending: EnqueueStandaloneNames | null; acceptedPolicy: string | null;
  busy: boolean; error: string | null; notice: string | null; view: "results" | "saved";
};
function initial(ownerId: string | null): State {
  return { ownerId, brief: { description: "", direction: "", language: "English" }, overview: null, selectedJobId: null, refinement: null,
    instruction: "", pending: null, acceptedPolicy: null, busy: false, error: null, notice: null, view: "results" };
}
const unavailableCopy = {
  local_runtime_required: "AI names currently run in Embel’s local app with your connected ChatGPT plan. Hosted generation is not enabled.",
  setup_required: "Standalone AI names have not been enabled for this account. Your manual workshop is ready to use.",
  worker_unavailable: "Your local naming worker is not ready. Open Settings to check your ChatGPT connection and selected model.",
  quota_unavailable: "The current request or hourly limit is reached. Existing names remain available; refresh after your running request finishes or your allowance resets.",
};
function requestError(error: unknown): string {
  if (error instanceof AccountRequestError) {
    if (error.status === 409) return "The request conflicts with current work or changed usage settings. Refresh your names before starting another request.";
    if (error.status === 422 || error.status === 413) return "Review the brief, refinement and field lengths before trying again.";
    if (error.status === 503) return "AI naming is unavailable. Your brief and any unconfirmed request are retained in this tab.";
  }
  return "The response could not be verified. Your brief and any unconfirmed request are retained. Retrying uses the same request and cannot create a duplicate job.";
}
function replaceJob(overview: StandaloneNamesOverview | null, job: StandaloneNamesJob): StandaloneNamesOverview | null {
  return overview ? { ...overview, jobs: [...overview.jobs.filter(item => item.id !== job.id), job].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)) } : null;
}

export function StandaloneNamesAssistant() {
  const { session, isCurrent, expire } = useAccountSession();
  const account = session.status === "ready" ? session : null;
  const [state, setState] = useState<State>(() => initial(account?.userId ?? null));
  // Same-owner authentication recovery retains the in-memory brief and exact
  // pending intent. A verified different owner receives a fresh private state.
  if (account && state.ownerId !== account.userId) setState(initial(account.userId));
  const request = useRef<AbortController | null>(null);
  const active = useRef(false);
  const overviewRef = useRef<StandaloneNamesOverview | null>(null);
  const current = useCallback(() => account !== null && active.current && isCurrent(account), [account, isCurrent]);
  const load = useCallback(async (more = false) => {
    if (!account || !current() || request.current) return;
    const controller = new AbortController(); request.current = controller;
    setState(previous => ({ ...previous, busy: true, error: null }));
    const previous = overviewRef.current?.ownerId === account.userId ? overviewRef.current : null;
    const last = more ? previous?.jobs.at(-1) : undefined;
    try {
      const query = last ? `?before=${encodeURIComponent(last.createdAt)}&beforeId=${encodeURIComponent(last.id)}` : "";
      const result = await standaloneNamesRequest(`/api/names/ai${query}`, standaloneNamesOverviewSchema, { signal: controller.signal, expectedOwnerId: account.userId });
      if (!current() || request.current !== controller || controller.signal.aborted) return;
      if (result.ownerId !== account.userId) { expire(account); return; }
      const merged = more && previous ? { ...result, jobs: [...previous.jobs, ...result.jobs.filter(job => !previous.jobs.some(old => old.id === job.id))] }
        : previous && previous.jobs.length > 50 ? { ...result, hasMore: previous.hasMore, jobs: [...result.jobs, ...previous.jobs.filter(job => !result.jobs.some(next => next.id === job.id))].slice(0, 500) } : result;
      overviewRef.current = merged;
      setState(old => ({ ...old, overview: merged, selectedJobId: old.selectedJobId && merged.jobs.some(job => job.id === old.selectedJobId) ? old.selectedJobId : merged.jobs[0]?.id ?? null }));
    } catch (error) {
      if (!current() || controller.signal.aborted) return;
      if (error instanceof AccountRequestError && error.status === 401) expire(account);
      else setState(old => ({ ...old, error: requestError(error) }));
    } finally {
      if (request.current === controller) { request.current = null; if (current()) setState(old => ({ ...old, busy: false })); }
    }
  }, [account, current, expire]);
  useEffect(() => {
    active.current = true;
    const start = setTimeout(() => void load(), 0);
    return () => { clearTimeout(start); active.current = false; request.current?.abort(); request.current = null; };
  }, [load]);
  const running = state.overview?.jobs.some(job => standaloneNamesActive(job.state)) ?? false;
  const hasUnsubmittedBrief = Boolean(state.pending || state.refinement || (state.brief.description && !state.overview?.jobs.some(job => JSON.stringify(job.brief) === JSON.stringify(state.brief))));
  useEffect(() => {
    if (!account || !running) return;
    const timer = setInterval(() => void load(), 3500);
    return () => clearInterval(timer);
  }, [account, running, load]);
  useEffect(() => {
    if (!hasUnsubmittedBrief) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsubmittedBrief]);

  async function mutate(path: string, body: unknown, method: "POST" | "PATCH", pending?: EnqueueStandaloneNames) {
    if (!account || !current() || request.current) return;
    const controller = new AbortController(); request.current = controller;
    setState(old => ({ ...old, busy: true, error: null, notice: null, ...(pending ? { pending } : {}) }));
    try {
      const { job } = await standaloneNamesRequest(path, standaloneNamesJobResponseSchema, { signal: controller.signal, expectedOwnerId: account.userId, method, body });
      if (!current() || request.current !== controller || controller.signal.aborted) return;
      if (job.ownerId !== account.userId || (!pending && path !== `/api/names/ai/${job.id}`)) { expire(account); return; }
      const acknowledgedRefinement = job.refinement ? { sourceJobId: job.refinement.sourceJobId, candidateIndexes: job.refinement.candidateIndexes, instruction: job.refinement.instruction } : null;
      if (pending && (JSON.stringify(job.brief) !== JSON.stringify(pending.brief) || JSON.stringify(acknowledgedRefinement) !== JSON.stringify(pending.refinement))) throw new AccountRequestError(502);
      overviewRef.current = replaceJob(overviewRef.current, job);
      setState(old => ({ ...old, overview: replaceJob(old.overview, job), selectedJobId: job.id, ...(pending ? { pending: null, acceptedPolicy: null, refinement: null, instruction: "", notice: "Request queued. You can leave this page; results will be kept in your account." } : {}) }));
    } catch (error) {
      if (!current() || controller.signal.aborted) return;
      if (error instanceof AccountRequestError && error.status === 401) expire(account);
      else setState(old => ({ ...old, error: requestError(error), ...(pending && error instanceof AccountRequestError && [409, 422, 413].includes(error.status) ? { pending: null, acceptedPolicy: null } : {}) }));
    } finally {
      if (request.current === controller) { request.current = null; if (current()) setState(old => ({ ...old, busy: false })); }
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (state.pending) { void mutate("/api/names/ai", state.pending, "POST", state.pending); return; }
    const availability = state.overview?.availability;
    if (availability?.status !== "available" || state.acceptedPolicy !== availability.policyIdentity) return;
    const parsed = enqueueStandaloneNamesSchema.safeParse({ brief: state.brief, refinement: state.refinement ? { sourceJobId: state.refinement.sourceJobId, candidateIndexes: state.refinement.indexes, instruction: state.instruction } : null,
      acceptedPolicyIdentity: availability.policyIdentity, acceptSubscriptionUsage: true, idempotencyKey: crypto.randomUUID() });
    if (!parsed.success) { setState(old => ({ ...old, error: "Add a brief and select one to five names plus an instruction when refining." })); return; }
    void mutate("/api/names/ai", parsed.data, "POST", parsed.data);
  }
  const privateState = account && state.ownerId === account.userId ? state : null;
  const overview = privateState?.overview;
  const availability = overview?.availability;
  const selected = overview?.jobs.find(job => job.id === state.selectedJobId);
  const displayed = state.view === "saved" ? overview?.jobs.filter(job => job.likedIndexes.length || job.savedIndexes.length) ?? [] : selected ? [selected] : [];
  function pick(job: StandaloneNamesJob, index: number) {
    if (state.pending || !current()) return;
    setState(old => {
      const existing = old.refinement?.sourceJobId === job.id ? old.refinement.indexes : [];
      const next = existing.includes(index) ? existing.filter(value => value !== index) : existing.length < 5 ? [...existing, index] : existing;
      return { ...old, brief: job.brief, refinement: next.length ? { sourceJobId: job.id, indexes: next } : null, acceptedPolicy: null, notice: null };
    });
  }
  async function copy(value: string) {
    if (!current()) return;
    try { await navigator.clipboard.writeText(value); if (current()) setState(old => ({ ...old, notice: "Name copied. Paste it into the workshop, Domains, Handles or Trademarks." })); }
    catch { if (current()) setState(old => ({ ...old, error: "Clipboard access is unavailable. Select and copy the name directly." })); }
  }
  return <section className="standalone-names" aria-labelledby="standalone-names-heading">
    <div className="names-section-heading"><h2 id="standalone-names-heading">Generate names from a brief</h2><span>Standalone AI</span></div>
    <p>Describe what you are naming, explore proposals, then refine your favorites. Each request stays here in your account.</p>
    {!privateState ? <AccountStatus /> : <>
      <form onSubmit={submit} className="standalone-names-form">
        <label className="names-field">What are you naming?<textarea value={state.brief.description} required maxLength={3000} rows={4} disabled={Boolean(state.pending || state.refinement)} placeholder="Describe the business, product or idea and who it is for." onChange={event => setState(old => ({ ...old, brief: { ...old.brief, description: event.target.value }, acceptedPolicy: null }))} /></label>
        <div className="standalone-names-fields"><label className="names-field">Direction and words to avoid<textarea value={state.brief.direction} maxLength={1000} rows={2} disabled={Boolean(state.pending || state.refinement)} placeholder="Optional tone, associations, length or words to avoid" onChange={event => setState(old => ({ ...old, brief: { ...old.brief, direction: event.target.value }, acceptedPolicy: null }))} /></label>
          <label className="names-field">Language<input value={state.brief.language} required maxLength={80} disabled={Boolean(state.pending || state.refinement)} onChange={event => setState(old => ({ ...old, brief: { ...old.brief, language: event.target.value }, acceptedPolicy: null }))} /></label></div>
        {state.refinement ? <div className="standalone-names-refine"><p>{state.refinement.indexes.length} names selected for refinement. The original brief stays attached.</p><label className="names-field">What should change?<textarea rows={2} value={state.instruction} maxLength={1000} required disabled={Boolean(state.pending)} placeholder="For example, shorter and warmer while retaining the nature association." onChange={event => setState(old => ({ ...old, instruction: event.target.value, acceptedPolicy: null }))} /></label><button type="button" className="text-link" disabled={Boolean(state.pending)} onClick={() => setState(old => ({ ...old, refinement: null, instruction: "", acceptedPolicy: null }))}>Start a fresh request instead</button></div> : null}
        <div className="standalone-names-usage">
          {availability?.status === "available" ? <><p>Up to 20 names · {availability.model} · one ChatGPT plan request · up to {Math.ceil(availability.deadlineMs / 1000)} seconds. Application limit: {availability.maxRequestsPerHour} requests per hour across your subscription work. Actual plan limits also apply.</p><label className="standalone-names-accept"><input type="checkbox" checked={state.acceptedPolicy === availability.policyIdentity} disabled={Boolean(state.pending)} onChange={event => setState(old => ({ ...old, acceptedPolicy: event.target.checked ? availability.policyIdentity : null }))} />Use my ChatGPT plan allowance for this request.</label></> : availability ? <p role="status">{unavailableCopy[availability.reason]} <Link href="/settings">Open Settings</Link></p> : <p role="status">Checking standalone naming readiness…</p>}
          <div className="standalone-names-actions"><button className="button primary" disabled={state.busy || (!state.pending && (running || availability?.status !== "available" || state.acceptedPolicy !== availability.policyIdentity))} type="submit">{state.busy && state.pending ? "Sending request…" : state.pending ? "Retry this same request" : state.refinement ? "Refine selected names" : "Generate names"}</button><button className="button secondary small" type="button" disabled={state.busy} onClick={() => void load()}>Refresh names</button></div>
          {state.pending ? <p role="status">This request has not been acknowledged. The exact brief and request key are retained for a safe retry; no new request will be created.</p> : null}
        </div>
      </form>
      {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
      {state.notice ? <p className="names-notice" role="status">{state.notice}</p> : null}
      {overview ? <div className="standalone-names-history"><div className="names-section-heading"><h3>Your AI names</h3><div className="standalone-names-actions"><button type="button" className="text-link" aria-pressed={state.view === "results"} onClick={() => setState(old => ({ ...old, view: "results" }))}>Results &amp; history</button><button type="button" className="text-link" aria-pressed={state.view === "saved"} onClick={() => setState(old => ({ ...old, view: "saved" }))}>Shortlist &amp; saved</button></div></div>
        {overview.jobs.length ? <label className="names-field">Request history<select value={selected?.id ?? ""} onChange={event => setState(old => ({ ...old, selectedJobId: event.target.value, view: "results" }))}>{overview.jobs.map(job => <option key={job.id} value={job.id}>{new Date(job.createdAt).toLocaleString("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {job.refinement ? "Refinement" : "Generation"} · {job.state.replaceAll("_", " ")} · {job.brief.description.slice(0, 55)}</option>)}</select></label> : <p>No AI requests yet. Your manual names are available in Workshop and Library.</p>}
        {displayed.map(job => <article key={job.id} className="standalone-names-batch"><div className="names-section-heading"><h3>{job.refinement ? `Refinement ${job.depth}` : "Name proposals"}</h3><span>{job.state.replaceAll("_", " ")}</span></div><p>{job.brief.description}</p>
          {standaloneNamesActive(job.state) ? <div className="standalone-names-actions"><p role="status">{job.state === "queued" ? "Waiting for the local worker." : job.state === "cancel_requested" ? "Cancellation requested. Any started provider request may still consume plan usage." : "The local worker is generating your names."}</p><button type="button" className="button secondary small" disabled={state.busy || job.state === "cancel_requested"} onClick={() => void mutate(`/api/names/ai/${job.id}`, { action: "cancel" }, "POST")}>Cancel request</button></div> : null}
          {job.state === "needs_reconciliation" ? <p role="alert">The provider outcome could not be confirmed. This request will not be retried automatically, and may have consumed plan usage. Retained recovery text requires operator review.</p> : job.state === "failed" ? <p role="alert">This request did not produce a validated result. Check your connection and usage before making a new request.</p> : null}
          {job.result ? <><p>{job.result.candidates.length} of up to 20 names passed validation. {job.result.candidates.length < 20 ? "No names were invented to fill the remainder." : ""} Domains, handles and trademarks have not been checked.</p><div className="standalone-names-grid">{job.result.candidates.map((name, index) => state.view === "saved" && !job.likedIndexes.includes(index) && !job.savedIndexes.includes(index) ? null : <div className="standalone-names-card" key={`${job.id}:${index}`}><h4>{name.value}</h4><p>{name.rationale}</p>{name.caution ? <p className="names-muted">{name.caution}</p> : null}<div className="standalone-names-actions"><button type="button" aria-pressed={job.likedIndexes.includes(index)} className="text-link" disabled={state.busy} onClick={() => void mutate(`/api/names/ai/${job.id}`, { candidateIndex: index, liked: !job.likedIndexes.includes(index), saved: job.savedIndexes.includes(index) }, "PATCH")}>{job.likedIndexes.includes(index) ? "Shortlisted" : "Shortlist"}</button><button type="button" aria-pressed={job.savedIndexes.includes(index)} className="text-link" disabled={state.busy} onClick={() => void mutate(`/api/names/ai/${job.id}`, { candidateIndex: index, liked: job.likedIndexes.includes(index), saved: !job.savedIndexes.includes(index) }, "PATCH")}>{job.savedIndexes.includes(index) ? "Saved" : "Save"}</button><button type="button" className="text-link" onClick={() => void copy(name.value)}>Copy</button></div><label className="standalone-names-accept"><input type="checkbox" checked={state.refinement?.sourceJobId === job.id && state.refinement.indexes.includes(index)} disabled={Boolean(state.pending) || job.depth >= STANDALONE_NAMES_MAX_DEPTH} onChange={() => pick(job, index)} />Refine this name</label></div>)}</div>{job.depth >= STANDALONE_NAMES_MAX_DEPTH ? <p>This chain reached five refinements. You can copy your favorites into a fresh brief.</p> : null}</> : null}
        </article>)}
        {state.view === "saved" && !displayed.length ? <p>Shortlist or save a generated name to find it here.</p> : null}
        {state.view === "saved" && overview.hasMore ? <p>Your shortlist shows loaded requests. Load older requests to include earlier saved names.</p> : null}
        {overview.hasMore ? <button type="button" className="button secondary small" disabled={state.busy} onClick={() => void load(true)}>Load older requests</button> : null}
      </div> : null}
    </>}
  </section>;
}
