"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AccountRequestError } from "@/components/workspace/account-api";
import { AccountStatus, useAccountSession } from "@/components/workspace/account-session";
import { standaloneNamesActive, standaloneNamesOverviewSchema, type StandaloneNamesOverview } from "@/domain/standalone-names";
import { standaloneNamesRequest } from "./standalone-names-client";
import "./standalone-names.css";

/** Historical subscription results remain readable; new work uses project Naming. */
export function StandaloneNamesAssistant() {
  const { session, isCurrent, expire } = useAccountSession();
  const account = session.status === "ready" ? session : null;
  const [snapshot, setSnapshot] = useState<{ ownerId: string; overview: StandaloneNamesOverview } | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [savedOnly, setSavedOnly] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null), active = useRef(false);
  const overviewRef = useRef<StandaloneNamesOverview | null>(null);
  const current = useCallback(() => account !== null && active.current && isCurrent(account), [account, isCurrent]);
  const load = useCallback(async (more = false) => {
    if (!account || !current() || request.current) return;
    const controller = new AbortController(); request.current = controller;
    setPending(true); setError(null);
    const previous = overviewRef.current?.ownerId === account.userId ? overviewRef.current : null;
    const last = more ? previous?.jobs.at(-1) : null;
    try {
      const query = last ? `?before=${encodeURIComponent(last.createdAt)}&beforeId=${encodeURIComponent(last.id)}` : "";
      const result = await standaloneNamesRequest(`/api/names/ai${query}`, standaloneNamesOverviewSchema, { signal: controller.signal, expectedOwnerId: account.userId });
      if (!current() || controller.signal.aborted || request.current !== controller) return;
      if (result.ownerId !== account.userId) { expire(account); return; }
      const overview = more && previous ? { ...result, jobs: [...previous.jobs, ...result.jobs.filter(job => !previous.jobs.some(old => old.id === job.id))] }
        : previous && previous.jobs.length > 50 ? { ...result, hasMore: previous.hasMore, jobs: [...result.jobs, ...previous.jobs.filter(job => !result.jobs.some(next => next.id === job.id))].slice(0, 500) } : result;
      overviewRef.current = overview; setSnapshot({ ownerId: account.userId, overview });
      setSelectedId(id => overview.jobs.some(job => job.id === id) ? id : overview.jobs[0]?.id ?? "");
    } catch (cause) {
      if (!current() || controller.signal.aborted) return;
      if (cause instanceof AccountRequestError && cause.status === 401) expire(account);
      else setError("Earlier requests could not be loaded. Your saved names are kept; try again.");
    } finally {
      if (request.current === controller) { request.current = null; if (current()) setPending(false); }
    }
  }, [account, current, expire]);
  useEffect(() => {
    active.current = true;
    const startup = setTimeout(() => void load(), 0);
    return () => { clearTimeout(startup); active.current = false; request.current?.abort(); request.current = null; };
  }, [load]);
  const overview = account && snapshot?.ownerId === account.userId ? snapshot.overview : null;
  const running = overview?.jobs.some(job => standaloneNamesActive(job.state)) ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 3500);
    return () => clearInterval(timer);
  }, [running, load]);
  const selected = overview?.jobs.find(job => job.id === selectedId);
  const displayed = savedOnly ? overview?.jobs.filter(job => job.likedIndexes.length || job.savedIndexes.length) ?? [] : selected ? [selected] : [];
  async function copy(value: string) {
    if (!current()) return;
    try { await navigator.clipboard.writeText(value); if (current()) setNotice("Name copied."); }
    catch { if (current()) setError("Clipboard access is unavailable. Select and copy the name directly."); }
  }
  return <section className="standalone-names" aria-labelledby="standalone-names-heading">
    <div className="names-section-heading"><h2 id="standalone-names-heading">Earlier AI requests</h2><span>History</span></div>
    <p>Your earlier requests, names and saved choices remain here. Start a new brief above to continue in Naming.</p>
    {!account ? <AccountStatus /> : <>
      <div className="standalone-names-actions"><button className="button secondary small" type="button" disabled={pending} onClick={() => void load()}>Refresh earlier requests</button><button type="button" className="text-link" aria-pressed={!savedOnly} onClick={() => setSavedOnly(false)}>Results &amp; history</button><button type="button" className="text-link" aria-pressed={savedOnly} onClick={() => setSavedOnly(true)}>Shortlist &amp; saved</button></div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p className="names-notice" role="status">{notice}</p> : null}
      {!overview && !error ? <p role="status">Loading earlier requests…</p> : null}
      {overview?.jobs.length ? <label className="names-field">Request history<select value={selected?.id ?? ""} onChange={event => { setSelectedId(event.target.value); setSavedOnly(false); }}>{overview.jobs.map(job => <option key={job.id} value={job.id}>{new Date(job.createdAt).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {job.refinement ? "Refinement" : "Generation"} · {job.state.replaceAll("_", " ")} · {job.brief.description.slice(0, 55)}</option>)}</select></label> : overview ? <p>No earlier AI requests. Your manual names remain in Workshop and Library.</p> : null}
      {displayed.map(job => <article key={job.id} className="standalone-names-batch"><div className="names-section-heading"><h3>{job.refinement ? `Refinement ${job.depth}` : "Name proposals"}</h3><span>{job.state.replaceAll("_", " ")}</span></div><p>{job.brief.description}</p>
        {standaloneNamesActive(job.state) ? <p role="status">This earlier request is still in progress. Refresh to check its saved result.</p> : null}
        {job.state === "needs_reconciliation" ? <p role="alert">The outcome of this earlier request still needs verification. Its retained history is unchanged.</p> : job.state === "failed" ? <p>This earlier request did not produce a verified result.</p> : null}
        {job.result ? <><p>{job.result.candidates.length} saved proposals. Domains, handles and trademarks have not been checked.</p><div className="standalone-names-grid">{job.result.candidates.map((name, index) => savedOnly && !job.likedIndexes.includes(index) && !job.savedIndexes.includes(index) ? null : <div className="standalone-names-card" key={`${job.id}:${index}`}><h4>{name.value}</h4><p>{name.rationale}</p>{name.caution ? <p className="names-muted">{name.caution}</p> : null}<div className="standalone-names-actions">{job.likedIndexes.includes(index) ? <span>Shortlisted</span> : null}{job.savedIndexes.includes(index) ? <span>Saved</span> : null}<button type="button" className="text-link" onClick={() => void copy(name.value)}>Copy</button></div></div>)}</div></> : null}
      </article>)}
      {overview && savedOnly && !displayed.length ? <p>No saved names in these earlier requests.</p> : null}
      {overview?.hasMore ? <button type="button" className="button secondary small" disabled={pending} onClick={() => void load(true)}>Load older requests</button> : null}
    </>}
  </section>;
}
