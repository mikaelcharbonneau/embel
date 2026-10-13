"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { domainResultsCsv, type DomainResultEvidence } from "./result-export";
import { type DomainSearchAdapter } from "./model";
import styles from "./domain-workspace.module.css";

export type DomainReadOutcome = "completed" | "failed" | "timeout" | "cancelled" | "skipped";
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
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); }, [adapter]);
  function select(domain: string, checked: boolean) {
    setSelected(current => checked ? [...new Set([...current, domain])] : current.filter(value => value !== domain));
  }
  async function checkSelected() {
    if (pending.current || adapter.status !== "ready" || !selected.length) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true); setNotice("");
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      // Sequential reads bound concurrency; timeout/cancellation retains completed rows.
      for (const row of rows.filter(row => selected.includes(row.domain))) {
        if (controller.signal.aborted) break;
        const outcome = await check(row, controller.signal);
        if (outcome === "timeout" || outcome === "cancelled") {
          setNotice(outcome === "timeout" ? "Bulk checking stopped after a request timed out. Completed results are retained." : "Bulk checking stopped. Completed results are retained.");
          break;
        }
      }
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
  return <>
    {children(selected, select)}
    <details className={styles.resultTools}>
      <summary>Result actions{selected.length ? ` · ${selected.length} selected` : ""}</summary>
      <div className={styles.resultToolsActions}>
        <label><input type="checkbox" aria-label="Select all visible domains" checked={allVisible} disabled={!visibleRows.length} onChange={event => setSelected(current => event.target.checked ? [...new Set([...current, ...visibleRows.map(row => row.domain)])] : current.filter(domain => !visibleRows.some(row => row.domain === domain)))} />Select visible</label>
        <button type="button" className="button secondary small" disabled={!selected.length} onClick={() => setSelected([])}>Clear selected domains</button>
        <button type="button" className="button secondary small" disabled={busy || !selected.length || adapter.status !== "ready"} onClick={() => void checkSelected()} title={adapter.status !== "ready" ? "Availability checks require a connected registrar." : undefined}>{busy ? "Checking selected…" : "Check selected domains"}</button>
        {busy && <button type="button" className="button secondary small" onClick={() => pending.current?.abort()}>Stop bulk checking</button>}
        <button type="button" className="button secondary small" disabled={!visibleRows.length && !selected.length} onClick={exportCsv}>Export CSV</button>
      </div>
      {notice && <p role="status">{notice}</p>}
    </details>
  </>;
}
