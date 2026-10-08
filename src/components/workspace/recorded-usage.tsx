"use client";

import { useEffect, useState } from "react";
import { RECORDED_USAGE_LIMIT, recordedUsageSchema, type RecordedUsage } from "@/domain/recorded-usage";
import { accountRequest, AccountRequestError } from "./account-api";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { BrowserLocalDate } from "./browser-local-date";
import "@/styles/recorded-usage.css";

const labels: Record<RecordedUsage["entries"][number]["operation"], string> = {
  "naming.generate": "Naming", "strategy.reformulate": "Strategy · Brief", "strategy.competitors": "Strategy · Competitors",
  "strategy.audience": "Strategy · Audience", "strategy.personality": "Strategy · Personality", "strategy.positioning": "Strategy · Positioning",
};

export function RecordedUsageSection() {
  const { session } = useAccountSession();
  return <section className="settings-section recorded-usage" aria-labelledby="recorded-usage-title">
    <div><h2 id="recorded-usage-title">Recorded usage</h2><p>Tokens recorded with completed text requests.</p></div>
    <div className="settings-panel">
      <p className="recorded-usage-coverage">Shows up to {RECORDED_USAGE_LIMIT} most recent successfully completed Strategy and Naming requests. Other activity is excluded. This is a recent history, not an account-wide usage total.</p>
      {session.status === "ready" ? <OwnedRecordedUsage key={`${session.userId}:${session.generation}`} account={session} /> :
        <p className="recorded-usage-notice" role="status">{session.status === "signed_out" ? "Sign in to view recorded usage." : session.status === "checking" ? "Checking your account…" : "Verify your account to view recorded usage."}</p>}
    </div>
  </section>;
}

function OwnedRecordedUsage({ account }: { account: VerifiedAccount }) {
  const { isCurrent, expire } = useAccountSession();
  const [snapshot, setSnapshot] = useState<RecordedUsage | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    void accountRequest("/api/usage", recordedUsageSchema, { signal: controller.signal }).then(reply => {
      if (disposed || controller.signal.aborted || !isCurrent(account)) return;
      if (reply.ownerId !== account.userId) { expire(account); return; }
      setSnapshot(reply);
    }).catch(cause => {
      if (disposed || !isCurrent(account)) return;
      if (cause instanceof AccountRequestError && cause.status === 401) { expire(account); return; }
      setError(true);
    }).finally(() => clearTimeout(timeout));
    return () => { disposed = true; controller.abort(); clearTimeout(timeout); };
  }, [account, expire, isCurrent, retry]);
  function refresh() { setSnapshot(null); setError(false); setRetry(value => value + 1); }
  return <>
    {error ? <div className="recorded-usage-notice" role="alert"><p>Recorded usage could not be loaded. Check your connection and try again.</p><button type="button" className="button secondary small" onClick={refresh}>Check usage again</button></div> :
      !snapshot ? <p className="recorded-usage-notice" role="status">Loading recorded usage…</p> : <>
        {!snapshot.entries.length ? <p className="recorded-usage-notice">No completed Strategy or Naming requests in this account yet.</p> :
          <div className="recorded-usage-list">{snapshot.entries.map(entry => {
            const label = labels[entry.operation];
            return <article key={entry.id} className="recorded-usage-entry" aria-label={label}>
              <div className="recorded-usage-entry-heading"><h3>{label}</h3><BrowserLocalDate dateTime={entry.completedAt} /></div>
              <dl>{([['Input tokens', entry.tokens?.inputTokens], ['Output tokens', entry.tokens?.outputTokens], ['Total tokens', entry.tokens?.totalTokens]] as const).map(([title, value]) =>
                <div key={title}><dt>{title}</dt><dd>{value == null ? "Unknown" : value.toLocaleString("en-US")}</dd></div>)}</dl>
            </article>;
          })}</div>}
        <p className="recorded-usage-note">Unknown means a token count was not recorded or could not be verified.</p>
        <button type="button" className="button secondary small recorded-usage-refresh" onClick={refresh}>Refresh usage</button>
      </>}
  </>;
}
