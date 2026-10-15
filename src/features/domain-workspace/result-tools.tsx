"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { domainResultsCsv, type DomainResultEvidence } from "./result-export";
import { type DomainSearchAdapter } from "./model";
import styles from "./domain-workspace.module.css";

export type DomainReadOutcome = "completed" | "failed" | "timeout" | "cancelled" | "skipped" | { status: "rate_limited"; retryAfterSeconds: number };
type Props<T extends DomainResultEvidence> = {
  rows: T[];
  visibleRows: T[];
  adapter: DomainSearchAdapter;
  check: (row: T, signal: AbortSignal) => Promise<DomainReadOutcome>;
  children: (selected: string[], select: (domain: string, checked: boolean) => void) => ReactNode;
};

/** The parent keys this boundary by search revision; selection never revives. */
export function DomainResultTools<T extends DomainResultEvidence>({ rows, visibleRows, adapter, check, children }: Props<T>) {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [remaining, setRemaining] = useState<string[]>([]);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); }, [adapter]);
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [cooldownUntil]);
  function select(domain: string, checked: boolean) {
    setSelected(current => checked ? [...new Set([...current, domain])] : current.filter(value => value !== domain));
  }
  async function checkRows(targets: T[]) {
    if (pending.current || adapter.status !== "ready" || !targets.length || cooldownUntil > Date.now()) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true); setNotice(""); setRemaining(targets.map(row => row.domain));
    const timer = setTimeout(() => controller.abort(), 60_000);
    let completed = 0;
    try {
      // Sequential reads bound concurrency; timeout/cancellation retains completed rows.
      for (const row of targets) {
        if (controller.signal.aborted) break;
        const outcome = await check(row, controller.signal);
        if (outcome === "completed") { completed++; setRemaining(current => current.filter(domain => domain !== row.domain)); }
        if (typeof outcome === "object" && outcome.status === "rate_limited") {
          const now = Date.now(); setNow(now); setCooldownUntil(now + outcome.retryAfterSeconds * 1000);
          setNotice(`The lookup limit was reached. ${completed} of ${targets.length} checks completed. Continue the remaining domains after the wait.`);
          return;
        }
        if (outcome === "failed") {
          setNotice(`Checking stopped after a provider error or limit. ${completed} of ${targets.length} checks completed. Unchecked results stay Unknown; try again later.`);
          return;
        }
        if (outcome === "timeout" || outcome === "cancelled") {
          setNotice(outcome === "timeout" ? "Bulk checking stopped after a request timed out. Completed results are retained." : "Bulk checking stopped. Completed results are retained.");
          return;
        }
      }
      if (!controller.signal.aborted) setNotice(`${completed} of ${targets.length} checks completed. Prices are current observations and may change.`);
      else setNotice(`Checking stopped. ${completed} of ${targets.length} checks completed; remaining results need a fresh check.`);
    } finally {
      clearTimeout(timer);
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    }
  }
  function exportCsv() {
    const exported = selected.length ? rows.filter(row => selected.includes(row.domain)) : visibleRows;
    if (!exported.length) return;
    const url = URL.createObjectURL(new Blob([domainResultsCsv(exported)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = "embel-domain-candidates.csv"; document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  const allVisible = visibleRows.length > 0 && visibleRows.every(row => selected.includes(row.domain));
  const remainingRows = rows.filter(row => remaining.includes(row.domain));
  const cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  return <>
    {children(selected, select)}
    <div className={styles.liveCheckActions}>
      {!busy && remainingRows.length > 0 && <button type="button" className="button primary small" disabled={cooldownSeconds > 0 || adapter.status !== "ready"} onClick={() => void checkRows(remainingRows)}>Continue remaining checks ({remainingRows.length})</button>}
      <button type="button" className={`button ${remainingRows.length ? "secondary" : "primary"} small`} disabled={busy || cooldownSeconds > 0 || !visibleRows.length || adapter.status !== "ready"} onClick={() => void checkRows(visibleRows)}>{busy ? "Checking domains…" : remainingRows.length ? "Restart visible checks" : adapter.status === "ready" && adapter.quotesWithCheck ? "Check availability & prices" : "Check visible domains"}</button>
      {busy && <button type="button" className="button secondary small" onClick={() => pending.current?.abort()}>Stop checking</button>}
      {notice && <p role="status">{notice}</p>}
      {cooldownSeconds > 0 && <p role="status">Wait {cooldownSeconds} seconds before continuing.</p>}
    </div>
    <details className={styles.resultTools}>
      <summary>Result actions{selected.length ? ` · ${selected.length} selected` : ""}</summary>
      <div className={styles.resultToolsActions}>
        <label><input type="checkbox" aria-label="Select all visible domains" checked={allVisible} disabled={!visibleRows.length} onChange={event => setSelected(current => event.target.checked ? [...new Set([...current, ...visibleRows.map(row => row.domain)])] : current.filter(domain => !visibleRows.some(row => row.domain === domain)))} />Select visible</label>
        <button type="button" className="button secondary small" disabled={!selected.length} onClick={() => setSelected([])}>Clear selected domains</button>
        <button type="button" className="button secondary small" disabled={busy || cooldownSeconds > 0 || !selected.length || adapter.status !== "ready"} onClick={() => void checkRows(rows.filter(row => selected.includes(row.domain)))} title={adapter.status !== "ready" ? "Availability checks require a connected registrar." : undefined}>{busy ? "Checking selected…" : "Check selected domains"}</button>
        {busy && <button type="button" className="button secondary small" onClick={() => pending.current?.abort()}>Stop bulk checking</button>}
        <button type="button" className="button secondary small" disabled={!visibleRows.length && !selected.length} onClick={exportCsv}>Export CSV</button>
      </div>
    </details>
  </>;
}
