"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { AccountRequestError } from "@/components/workspace/account-api";
import { BrowserLocalDate } from "@/components/workspace/browser-local-date";
import { useAccountProfile } from "@/components/workspace/account-profile-provider";
import { providerTargetSchema } from "@/domain/standalone-provider-evidence";
import { lookupFailureMessage } from "@/domain/standalone-live-checks";
import { screeningRecordFreshness, screeningRecordInputSchema, type ScreeningCheckResponse, type ScreeningOverview, type ScreeningRecordInput } from "@/domain/project-screening";
import { availabilityAt } from "@/features/domain-workspace/model";
import { platforms, type HandlePlatform } from "@/features/handles-workspace/domain";
import { createProjectScreeningClient } from "./project-screening-client";
import { projectScreeningDomainError, projectScreeningDomainSuggestion } from "./project-screening-domain";
import type { ScreeningDraft } from "./project-screening-memory";
import styles from "./project-screening-evidence.module.css";

type Props = { projectId: string; selectionId: string; projectRevision: number; name: string; disabled?: boolean };
export function projectScreeningCriteria(draft: ScreeningDraft, name: string) {
  if (draft.tool === "domains") {
    const error = projectScreeningDomainError(draft.domain);
    if (error) throw new Error(error);
  }
  return providerTargetSchema.parse(draft.tool === "domains" ? { tool: "domains", domain: draft.domain.trim().toLowerCase() }
    : draft.tool === "handles" ? { tool: "handles", platform: draft.platform, handle: draft.handle.trim().replace(/^@/, "") }
      : { tool: "trademarks", mark: name, mode: "exact_word", jurisdictions: draft.jurisdictions.split(",").map(value => value.trim().toUpperCase()).filter(Boolean), niceClasses: draft.niceClasses.trim() ? draft.niceClasses.split(",").map(value => /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN) : [] });
}
export function projectScreeningLiveNotes(check: ScreeningCheckResponse, now: number) {
  const result = check.result;
  if (result.status === "failed") return { text: `Unknown. ${lookupFailureMessage[result.code]}`, sources: [], observedAt: check.completedAt };
  if (result.status === "domain") {
    const status = availabilityAt(result.check, now);
    return { text: `${result.check.domain}: ${status === "taken" ? "registration observed" : status === "available" ? "registrar reported registration eligibility" : "current availability unknown"}. ${result.check.detail ?? ""} Source: ${result.check.provider}. Checked ${result.check.checkedAt}. ${Date.parse(result.check.validUntil) <= now ? "This observation has expired." : `Valid until ${result.check.validUntil}.`} No reservation or purchase.`, sources: result.check.sourceUrl ? [result.check.sourceUrl] : [], observedAt: result.check.checkedAt };
  }
  if (result.status === "handle") return { text: `${result.evidence.platform} @${result.evidence.handle}: ${result.evidence.detail} Availability and reservation remain unknown.`, sources: result.evidence.sourceUrl ? [result.evidence.sourceUrl] : [], observedAt: result.evidence.observedAt };
  const research = result.research;
  return { text: `${research.hits.length} exact-name EUIPO records returned for review. Partial research only; no legal clearance. Searched: ${research.searched.join(", ") || "none"}. Unsearched requested territories: ${research.missing.join(", ") || "none"}. Dataset freshness unknown.${research.interrupted ? ` Search interrupted: ${research.interrupted}.` : ""}`, sources: [research.sourceUrl], observedAt: research.checkedAt };
}
const subscribeClock = () => () => {};
function ScreeningTime({ value }: { value: string }) {
  const profile = useAccountProfile(), timeZone = profile?.workspace?.saved.values.timeZone;
  const time = useSyncExternalStore(subscribeClock, () => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short", ...(timeZone ? { timeZone } : {}) }).format(new Date(value)), () => null);
  return <><BrowserLocalDate dateTime={value} /> · <time dateTime={value}>{time ?? "…"}</time></>;
}
function criteriaLabel(criteria: ScreeningRecordInput["criteria"]) {
  return criteria.tool === "domains" ? criteria.domain : criteria.tool === "handles" ? `${criteria.platform} @${criteria.handle}` : `${criteria.mark} · territories ${criteria.jurisdictions.join(", ")} · ${criteria.niceClasses.length ? `Nice classes ${criteria.niceClasses.join(", ")}` : "all classes"} · exact name`;
}
function message(error: unknown) {
  if (error instanceof AccountRequestError) {
    if (error.status === 409) return "The selected name or project context changed, or this record conflicts. Check the latest project before recording again.";
    if (error.status === 422) return "Review the criteria, source links and observation time. Future observation times cannot be recorded.";
    if (error.status === 404) return "This project is not available to this account.";
    if (error.status === 401) return "Verify your account again. Your unsaved notes are retained for this account.";
  }
  return "The request could not be confirmed. Your notes are retained. Check the latest records or retry the same record.";
}
export function ProjectScreeningEvidence(props: Props) {
  const { session } = useAccountSession();
  if (session.status !== "ready" || !z.uuid().safeParse(props.projectId).success || !z.uuid().safeParse(props.selectionId).success) return null;
  return <OwnedScreening key={`${session.userId}:${session.generation}:${props.projectId}:${props.selectionId}:${props.projectRevision}`} {...props} account={session} />;
}
function OwnedScreening({ account, ...props }: Props & { account: VerifiedAccount }) {
  const { isCurrent, expire, screeningDrafts } = useAccountSession();
  const [client] = useState(() => createProjectScreeningClient({ ownerId: account.userId, projectId: props.projectId, isCurrent: () => isCurrent(account), expire: () => expire(account) }));
  const lifetime = useRef(new AbortController());
  const lookup = useRef<AbortController | null>(null);
  const suggestedDomain = projectScreeningDomainSuggestion(props.name), domainHelpId = useId();
  const [draft, setDraft] = useState<ScreeningDraft>(() => screeningDrafts.get(account, props.projectId, props.selectionId, props.projectRevision) ?? {
    tool: "domains", domain: suggestedDomain ?? "", handle: props.name.toLowerCase().replace(/\s/g, ""), platform: "youtube",
    jurisdictions: "EM", niceClasses: "", notes: "", sources: "", observedAt: new Date().toISOString(), acknowledged: false, dirty: false, pendingInput: null,
  });
  const [previousDrafts, setPreviousDrafts] = useState(() => screeningDrafts.previous(account, props.projectId, props.selectionId, props.projectRevision));
  const [page, setPage] = useState<ScreeningOverview | null>(null), [live, setLive] = useState<ScreeningCheckResponse | null>(null);
  const [busy, setBusy] = useState<"loading" | "checking" | "saving" | null>("loading"), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0), [now, setNow] = useState(Date.now);
  const current = () => isCurrent(account) && !lifetime.current.signal.aborted;
  function remember(value: ScreeningDraft) {
    if (!current()) return;
    screeningDrafts.put(account, props.projectId, props.selectionId, props.projectRevision, value); setDraft(value);
  }
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => { controller.abort(); lookup.current?.abort(); }; }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void client.read(controller.signal).then(value => {
      if (controller.signal.aborted || !isCurrent(account)) return;
      setPage(value); setError(""); setBusy(null);
    }, cause => { if (!controller.signal.aborted && isCurrent(account)) { setError(message(cause)); setBusy(null); } });
    return () => controller.abort();
  }, [client, account, isCurrent, reload]);
  const basisMatches = page?.currentBasis?.selectionId === props.selectionId && page.currentBasis.projectRevision === props.projectRevision && page.currentBasis.name === props.name;
  const blocked = Boolean(props.disabled || busy || !basisMatches || draft.pendingInput);
  let criteria: ScreeningRecordInput["criteria"] | null = null;
  try { criteria = projectScreeningCriteria(draft, props.name); } catch {}
  function edit(change: Partial<ScreeningDraft>, changesCriteria = false) {
    if (blocked) return;
    remember({ ...draft, ...change, dirty: true, acknowledged: false }); setNotice("");
    if (changesCriteria) setLive(null);
  }
  async function check() {
    if (blocked || !criteria) return;
    const controller = new AbortController(); lookup.current = controller;
    setBusy("checking"); setError(""); setLive(null);
    try { const result = await client.check({ selectionId: props.selectionId, expectedProjectRevision: props.projectRevision, criteria }, controller.signal); if (current() && !controller.signal.aborted && lookup.current === controller) setLive(result); }
    catch (cause) { if (current() && !controller.signal.aborted && lookup.current === controller) setError(message(cause)); }
    finally { if (current() && lookup.current === controller) { lookup.current = null; setBusy(null); } }
  }
  async function save(retry = false) {
    if (props.disabled || busy || !current() || (!retry && (!basisMatches || !criteria || !draft.acknowledged))) return;
    let input: ScreeningRecordInput;
    try {
      input = retry && draft.pendingInput ? draft.pendingInput : screeningRecordInputSchema.parse({ selectionId: props.selectionId, expectedProjectRevision: props.projectRevision, criteria,
        requestId: crypto.randomUUID(), notes: draft.notes, sourceUrls: draft.sources.split("\n").map(value => value.trim()).filter(Boolean), observedAt: draft.observedAt, acknowledged: draft.acknowledged });
    } catch { setError("Add your findings, an ISO observation time with its time zone, and up to five HTTPS source links. Review and acknowledge the record."); return; }
    const pending = { ...draft, pendingInput: input, dirty: true };
    remember(pending); setBusy("saving"); setError(""); setNotice("");
    try {
      await client.record(input, lifetime.current.signal);
      if (!current()) return;
      remember({ ...draft, notes: "", sources: "", acknowledged: false, dirty: false, pendingInput: null });
      setNotice("Your reviewed research notes were recorded. They remain unverified and do not establish availability or legal clearance."); setReload(value => value + 1);
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof AccountRequestError && [404, 409, 413, 422].includes(cause.status)) remember({ ...pending, pendingInput: null });
      setError(message(cause));
    } finally { if (current()) setBusy(null); }
  }
  async function more() {
    if (busy || !page?.nextCursor) return;
    setBusy("loading"); setError("");
    try {
      const next = await client.read(lifetime.current.signal, page.nextCursor);
      if (!current()) return;
      setPage({ ...next, records: [...page.records, ...next.records.filter(row => !page.records.some(known => known.id === row.id))] });
    } catch (cause) { if (current()) setError(message(cause)); }
    finally { if (current()) setBusy(null); }
  }
  async function recoverPrevious(previous: (typeof previousDrafts)[number]) {
    if (busy || props.disabled || !previous.draft.pendingInput) return;
    setBusy("saving"); setError("");
    try {
      await client.record(previous.draft.pendingInput, lifetime.current.signal);
      if (!current()) return;
      screeningDrafts.put(account, props.projectId, previous.selectionId, previous.revision, null);
      setPreviousDrafts(values => values.filter(value => value !== previous)); setReload(value => value + 1);
      setNotice("The earlier record was recovered without changing its original name or context.");
    } catch (cause) { if (current()) setError(message(cause)); }
    finally { if (current()) setBusy(null); }
  }
  const liveNotes = live ? projectScreeningLiveNotes(live, now) : null;
  return <section className={styles.panel} aria-label="Project screening research">
    <h2>Screening research</h2>
    <p className={styles.muted}>Keep your reviewed findings with this exact name selection and saved project context. Live lookups are temporary; saved notes are user-recorded, unverified research.</p>
    {error && <p className={styles.notice} role="alert">{error}</p>}{notice && <p className={styles.notice} role="status">{notice}</p>}
    {page && !basisMatches && <p className={styles.notice}>This name selection or saved context has changed. Reload the Naming workspace before starting a new review.</p>}
    {previousDrafts.map(previous => <details key={`${previous.selectionId}:${previous.revision}`} className={styles.notice}><summary>Unrecorded notes from earlier context v{previous.revision}</summary><p>These notes remain attached to their earlier name selection. They have not been copied into the current review.</p><pre>{previous.draft.notes}</pre><p>{previous.draft.sources}</p><div className={styles.actions}>{previous.draft.pendingInput && <button type="button" className="button secondary small" disabled={Boolean(busy || props.disabled)} onClick={() => void recoverPrevious(previous)}>Recover earlier record</button>}<button type="button" className="button secondary small" disabled={Boolean(busy)} onClick={() => { screeningDrafts.put(account, props.projectId, previous.selectionId, previous.revision, null); setPreviousDrafts(values => values.filter(value => value !== previous)); }}>Discard earlier draft</button></div></details>)}
    <div className={styles.actions}><button type="button" className="button secondary small" disabled={Boolean(busy)} onClick={() => { setBusy("loading"); setReload(value => value + 1); }}>Check latest records</button>{busy && <span role="status">{busy === "checking" ? "Checking the source…" : busy === "saving" ? "Recording your review…" : "Loading research…"}</span>}</div>
    <fieldset className={styles.fields} disabled={blocked}>
      <legend>Exact research criteria</legend>
      <label>Research type<select value={draft.tool} onChange={event => edit({ tool: event.target.value as ScreeningDraft["tool"] }, true)}><option value="domains">Domain</option><option value="handles">Handle</option><option value="trademarks">Trademark</option></select></label>
      {draft.tool === "domains" && <label>Exact domain<input value={draft.domain} maxLength={253} aria-describedby={domainHelpId} onChange={event => edit({ domain: event.target.value }, true)} /></label>}
      {draft.tool === "handles" && <><label>Platform<select value={draft.platform} onChange={event => edit({ platform: event.target.value as HandlePlatform }, true)}>{platforms.map(platform => <option key={platform.id} value={platform.id}>{platform.label}</option>)}</select></label><label>Exact handle<input value={draft.handle} maxLength={65} onChange={event => edit({ handle: event.target.value }, true)} /></label></>}
      {draft.tool === "trademarks" && <><label>Selected name<input value={props.name} readOnly /></label><label>Territory codes, comma separated<input value={draft.jurisdictions} maxLength={659} onChange={event => edit({ jurisdictions: event.target.value }, true)} placeholder="EM, CA, US" /></label><label>Nice classes, comma separated (optional)<input value={draft.niceClasses} maxLength={134} onChange={event => edit({ niceClasses: event.target.value }, true)} placeholder="9, 35" /></label></>}
    </fieldset>
    {draft.tool === "domains" && <p id={domainHelpId} className={styles.muted}>{suggestedDomain === null
      ? <>No ASCII domain was suggested for “{props.name}”. Enter one to research; internationalized domains are not supported. Your selected brand spelling is unchanged.</>
      : draft.domain === suggestedDomain
        ? <>Suggested from “{props.name}”, with spaces removed and letters lowercased. Not checked or reserved; your brand spelling is unchanged.</>
        : "Enter an ASCII domain. Internationalized domains are not supported; this does not change your selected brand spelling."}</p>}
    {!criteria && <p className={styles.notice}>{draft.tool === "domains" ? projectScreeningDomainError(draft.domain) : draft.tool === "handles" ? "Enter a handle with 1–64 letters, numbers, dots, underscores or hyphens." : "Enter distinct territory codes such as EM, CA or US, and distinct Nice class numbers from 1 to 45."}</p>}
    <p className={styles.muted}>{draft.tool === "domains" ? "Public registry checks can establish a registration. A missing record stays Unknown. Domain prices and eligibility need the configured registrar." : draft.tool === "handles" ? "The connected YouTube API can observe profiles. A missing profile or access error does not establish handle availability." : "The connected EUIPO source searches exact names in EU marks (EM). Other territories remain unsearched; similar marks and legal relevance need separate review."}</p>
    <button type="button" className="button secondary small" disabled={blocked || !criteria} onClick={() => void check()}>Run live lookup</button>
    {busy === "checking" && <button type="button" className="button secondary small" onClick={() => { lookup.current?.abort(); lookup.current = null; setBusy(null); setNotice("Lookup cancelled. No live observation was recorded."); }}>Cancel lookup</button>}
    {live && liveNotes && <div className={styles.result} aria-label="Temporary live result"><h3>Live observation</h3><p>{liveNotes.text}</p><p className={styles.muted}>Completed <ScreeningTime value={live.completedAt} />. This result is temporary. Record your reviewed notes separately.</p>
      {live.result.status === "trademark" && live.result.research.hits.length > 0 && <details><summary>Review returned EU records ({live.result.research.hits.length})</summary><ul>{live.result.research.hits.map(hit => <li key={hit.registryId}><a href={`https://euipo.europa.eu/eSearch/#details/trademarks/${hit.registryId}`} target="_blank" rel="noopener noreferrer">{hit.mark} · {hit.registryId}</a> · {hit.status} · classes {hit.niceClasses.join(", ") || "not supplied"}</li>)}</ul></details>}
      <button type="button" className="button secondary small" disabled={blocked} onClick={() => remember({ ...draft, notes: liveNotes.text, sources: liveNotes.sources.join("\n"), observedAt: liveNotes.observedAt, acknowledged: false, dirty: true })}>{draft.notes ? "Replace my notes with this result" : "Use this result in my notes"}</button></div>}
    <div className={styles.review}>
      <h3>Your research record</h3>
      <label>Findings and limitations<textarea rows={4} value={draft.notes} maxLength={3000} disabled={blocked} onChange={event => edit({ notes: event.target.value })} /></label>
      <label>Source links (one HTTPS link per line, up to five)<textarea rows={2} value={draft.sources} maxLength={10244} disabled={blocked} onChange={event => edit({ sources: event.target.value })} /></label>
      <label>Reported observation time (ISO format with time zone)<input value={draft.observedAt} maxLength={64} disabled={blocked} onChange={event => edit({ observedAt: event.target.value })} placeholder="2026-10-13T12:00:00-04:00" /></label>
      <label className={styles.ack}><input type="checkbox" checked={draft.acknowledged} disabled={blocked} onChange={event => remember({ ...draft, acknowledged: event.target.checked, dirty: true })} /><span>I reviewed these notes and criteria. This is my unverified research record, not proof of availability or legal clearance.</span></label>
      <div className={styles.actions}><button type="button" className="button primary small" disabled={blocked || !criteria || !draft.notes.trim() || !draft.acknowledged} onClick={() => void save()}>Record reviewed notes</button>{draft.pendingInput && <button type="button" className="button secondary small" disabled={Boolean(busy || props.disabled)} onClick={() => void save(true)}>Retry same record</button>}</div>
      {draft.pendingInput && <p className={styles.notice}>The previous save has not been confirmed. Your exact record is retained; retrying it cannot create a second copy.</p>}
    </div>
    <h3>Saved research</h3><p className={styles.muted}>Earlier selections and contexts remain in history. Matching the current context does not verify a record or refresh its observation time.</p>
    <ul className={styles.history}>{page?.records.map(record => <li key={record.id}><strong>{criteriaLabel(record.criteria)}</strong><p className={styles.muted}>User-recorded · Unverified · {screeningRecordFreshness(record, page.currentBasis, criteria ?? undefined) === "earlier_context" ? "Earlier name or context" : screeningRecordFreshness(record, page.currentBasis, criteria ?? undefined) === "different_criteria" ? "Different criteria" : "Current context; observation freshness unverified"}</p><p className={styles.muted}>{record.basis.name} · saved context v{record.basis.projectRevision} · Observed <ScreeningTime value={record.observedAt} /> · Recorded <ScreeningTime value={record.recordedAt} /></p><pre>{record.notes}</pre>{record.sourceUrls.map(url => <p key={url}><a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{url}</a></p>)}</li>)}</ul>
    {page?.records.length === 0 && <p className={styles.muted}>No research records have been saved for this project.</p>}
    {page?.nextCursor && <button type="button" className="button secondary small" disabled={Boolean(busy)} onClick={() => void more()}>Load earlier records</button>}
  </section>;
}
