"use client";

import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { isDialogBackdropClick } from "@/components/ui/dialog-backdrop";
import { useEffect, useRef, useState } from "react";
import { jobActivityHref, jobOperationLabel, jobActivitySchema, type JobActivity, type JobActivityEntry } from "@/domain/job-activity";
import { accountRequest, AccountRequestError } from "./account-api";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { BrowserLocalDate } from "./browser-local-date";

const statusLabels: Record<JobActivityEntry["state"], string> = {
  queued: "Queued", running: "Running", partial: "Partial results", cancel_requested: "Cancellation requested",
  cancelled: "Cancelled", succeeded: "Request completed", failed: "Failed", needs_reconciliation: "Needs review",
};

export function GenerationActivity({ labeled = false }: { labeled?: boolean }) {
  const { session } = useAccountSession();
  if (session.status !== "ready") return null;
  return <OwnedGenerationActivity key={`${session.userId}:${session.generation}`} account={session} labeled={labeled} />;
}

function OwnedGenerationActivity({ account, labeled }: { account: VerifiedAccount; labeled: boolean }) {
  const { isCurrent, expire } = useAccountSession();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<JobActivity | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  function showActivity() {
    // Open synchronously so a queued close event from an earlier dismissal
    // cannot overwrite this new intent before the state effect runs.
    if (!dialog.current?.open) dialog.current?.showModal();
    setOpen(true);
  }
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      let active = false;
      const read = new AbortController();
      const abortRead = () => read.abort();
      controller.signal.addEventListener("abort", abortRead, { once: true });
      const deadline = setTimeout(abortRead, 15_000);
      try {
        const reply = await accountRequest("/api/jobs", jobActivitySchema, { signal: read.signal });
        if (controller.signal.aborted || read.signal.aborted || !isCurrent(account)) return;
        if (reply.ownerId !== account.userId) { expire(account); return; }
        setSnapshot(reply); setError(false); active = reply.active.length > 0;
      } catch (cause) {
        if (controller.signal.aborted || !isCurrent(account)) return;
        if (cause instanceof AccountRequestError && cause.status === 401) { expire(account); return; }
        setError(true);
      } finally {
        clearTimeout(deadline);
        controller.signal.removeEventListener("abort", abortRead);
        if (!controller.signal.aborted && isCurrent(account)) timer = setTimeout(() => void refresh(), active ? 3000 : 15000);
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [account, expire, isCurrent, open, retry]);
  function list(rows: JobActivityEntry[]) {
    return <ul className="generation-activity-list">{rows.map(job => <li key={job.id}>
      <Link href={jobActivityHref(job)} onClick={() => setOpen(false)}><strong>{job.projectTitle}</strong><span>{jobOperationLabel(job.operation)}</span></Link>
      <div><span>{statusLabels[job.state]}</span><BrowserLocalDate dateTime={job.createdAt} /></div>
      {job.state === "running" && <progress value={job.progress} max={100} aria-label={`${jobOperationLabel(job.operation)} progress for ${job.projectTitle}`} />}
      {job.state === "needs_reconciliation" && <p>The outcome needs review. This request will not be retried automatically.</p>}
    </li>)}</ul>;
  }
  return <>
    <button className="icon-button subtle generation-activity-trigger" type="button" aria-label="Activity" title="Activity" aria-haspopup="dialog" onClick={showActivity}><Icon name="clock" size={18} />{labeled && <span>Generation activity</span>}</button>
    <dialog className="generation-activity-dialog" ref={dialog} aria-labelledby="generation-activity-title" onCancel={() => setOpen(false)} onClose={event => { if (!event.currentTarget.open) setOpen(false); }} onClick={event => { if (isDialogBackdropClick(event)) setOpen(false); }}>
      <header><h2 id="generation-activity-title">Generation activity</h2><button className="button secondary small" type="button" onClick={() => setOpen(false)}>Close activity</button></header>
      <p>Open a project to review its results. Closing this panel does not cancel work.</p>
      {error && <div role="alert"><p>Activity could not be refreshed. Any entries below are from the last successful check.</p><button className="button secondary small" type="button" onClick={() => setRetry(value => value + 1)}>Check activity again</button></div>}
      {!snapshot && !error && <p role="status">Loading your activity…</p>}
      {snapshot && <>
        {snapshot.active.length > 0 && <section aria-label="Active generations"><h3>Active requests</h3>{list(snapshot.active)}</section>}
        {snapshot.recent.length > 0 && <section aria-label="Recent generations"><h3>Recent requests</h3>{list(snapshot.recent)}</section>}
        {!snapshot.active.length && !snapshot.recent.length && <p>No generation requests in this account yet.</p>}
        <p className="generation-activity-note">Up to 20 active and 20 recent requests. A completed request can contain fewer results than requested; open its project for the accepted count.</p>
      </>}
    </dialog>
  </>;
}
