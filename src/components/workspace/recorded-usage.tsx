"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RECORDED_USAGE_LIMIT, recordedUsageSchema, type RecordedUsage } from "@/domain/recorded-usage";
import { accountRequest, AccountRequestError } from "./account-api";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { BrowserLocalDate } from "./browser-local-date";
import "@/styles/recorded-usage.css";

const labels: Record<RecordedUsage["entries"][number]["operation"], string> = {
  "naming.generate": "Naming", "strategy.reformulate": "Strategy · Brief", "strategy.competitors": "Strategy · Competitors",
  "strategy.audience": "Strategy · Audience", "strategy.personality": "Strategy · Personality", "strategy.positioning": "Strategy · Positioning",
  "strategy.slogan": "Voice · Slogan",
};
const refreshingUsageMessage = "Checking recorded usage… Previous recorded usage is still shown.";

export function RecordedUsageSection({ active = true }: { active?: boolean }) {
  const { session } = useAccountSession();
  return <section className="settings-section recorded-usage" aria-labelledby="recorded-usage-title">
    <div><h2 id="recorded-usage-title">Recorded usage</h2><p>Tokens recorded with completed text requests.</p></div>
    <div className="settings-panel">
      <p className="recorded-usage-coverage">Shows up to {RECORDED_USAGE_LIMIT} most recent successfully completed Strategy and Naming requests. Other activity is excluded. This is a recent history, not an account-wide usage total.</p>
      {session.status === "ready" ? <OwnedRecordedUsage key={`${session.userId}:${session.generation}`} account={session} active={active} /> : <>
        <UsageStatus reserve={session.status === "checking"} message={session.status === "signed_out" ? "Sign in to view recorded usage." : session.status === "checking" ? "Checking your account…" : "Verify your account to view recorded usage."} />
        {session.status === "checking" && <><PendingUsageFrame /><UsageFooter /></>}
      </>}
    </div>
  </section>;
}

function PendingUsageFrame() {
  // Public page capacity only: never carry private row counts, text or measured
  // geometry through account verification. Terminal states remove this frame.
  return <div className="recorded-usage-pending-frame" aria-hidden="true" inert>
    {Array.from({ length: RECORDED_USAGE_LIMIT }, (_, index) => <div key={index} className="recorded-usage-pending-slot" />)}
  </div>;
}

function UsageStatus({ message, error = false, reserve = true }: { message: string; error?: boolean; reserve?: boolean }) {
  return <div className="recorded-usage-status">
    {/* Size only from public refresh copy, never private content or measurements.
        Longer errors can still grow; terminal account states have no sizing copy. */}
    {reserve && <span className="recorded-usage-status-sizer" aria-hidden="true" inert>{refreshingUsageMessage}</span>}
    <p className="recorded-usage-notice" role={error ? "alert" : "status"}>{message}</p>
  </div>;
}

function UsageFooter({ action }: { action?: ReactNode }) {
  return <div className="recorded-usage-footer">
    <p className="recorded-usage-note">Unknown means a token count was not recorded or could not be verified.</p>
    <div className="recorded-usage-action" aria-hidden={action ? undefined : true} inert={!action}>{action}</div>
  </div>;
}

function OwnedRecordedUsage({ account, active }: { account: VerifiedAccount; active: boolean }) {
  const { isCurrent, expire } = useAccountSession();
  const scope = useMemo(() => ({ account, isCurrent, expire }), [account, isCurrent, expire]);
  const [retry, setRetry] = useState(0);
  const cycle = useMemo(() => ({ active, scope, retry }), [active, scope, retry]);
  const [stored, setStored] = useState<{ scope: typeof scope; data: RecordedUsage } | null>(null);
  const [settled, setSettled] = useState<{ cycle: typeof cycle; error: boolean } | null>(null);
  // Provider replacement must mask the snapshot in the same render, even when
  // the new provider happens to use the same owner and generation numbers.
  const snapshot = stored?.scope === scope ? stored.data : null;
  const pending = settled?.cycle !== cycle;
  const error = settled?.cycle === cycle && settled.error;
  const reading = useRef(true);
  const readEpoch = useRef(0);
  const committedCycle = useRef<typeof cycle | null>(null);
  useLayoutEffect(() => {
    committedCycle.current = cycle;
    return () => { committedCycle.current = null; };
  }, [cycle]);
  useEffect(() => {
    if (!active) { reading.current = false; return; }
    const controller = new AbortController();
    const epoch = ++readEpoch.current;
    let disposed = false;
    let failed = false;
    const current = () => !disposed && readEpoch.current === epoch && committedCycle.current === cycle && scope.isCurrent(scope.account);
    reading.current = true;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    void accountRequest("/api/usage", recordedUsageSchema, { signal: controller.signal }).then(reply => {
      if (!current() || controller.signal.aborted) return;
      if (reply.ownerId !== scope.account.userId) { scope.expire(scope.account); return; }
      setStored({ scope, data: reply });
    }).catch(cause => {
      if (!current()) return;
      if (cause instanceof AccountRequestError && cause.status === 401) { scope.expire(scope.account); return; }
      failed = true;
    }).finally(() => {
      clearTimeout(timeout);
      if (current()) { reading.current = false; setSettled({ cycle, error: failed }); }
    });
    return () => {
      disposed = true; controller.abort(); clearTimeout(timeout);
      readEpoch.current = epoch + 1; reading.current = false;
    };
  }, [active, scope, cycle]);
  function refresh() {
    if (!active || pending || reading.current || committedCycle.current !== cycle || !scope.isCurrent(scope.account)) return;
    reading.current = true; setRetry(value => value + 1);
  }
  return <>
    <UsageStatus error={error} message={error
      ? snapshot ? "Recorded usage could not be refreshed. Previous recorded usage is still shown. Check your connection and try again." : "Recorded usage could not be loaded. Check your connection and try again."
      : pending ? snapshot ? refreshingUsageMessage : "Loading recorded usage…" : "Recorded usage loaded."} />
    {!snapshot && pending && <PendingUsageFrame />}
    {snapshot && <>
        {!snapshot.entries.length ? <p className="recorded-usage-notice">No completed Strategy or Naming requests in this account yet.</p> :
          <div className="recorded-usage-list">{snapshot.entries.map(entry => {
            const label = labels[entry.operation];
            return <article key={entry.id} className="recorded-usage-entry" aria-label={label}>
              <div className="recorded-usage-entry-heading"><h3>{label}</h3><BrowserLocalDate dateTime={entry.completedAt} /></div>
              <dl>{([['Input tokens', entry.tokens?.inputTokens], ['Output tokens', entry.tokens?.outputTokens], ['Total tokens', entry.tokens?.totalTokens]] as const).map(([title, value]) =>
                <div key={title}><dt>{title}</dt><dd>{value == null ? "Unknown" : value.toLocaleString("en-US")}</dd></div>)}</dl>
            </article>;
          })}</div>}
      </>}
    <UsageFooter action={<button type="button" className="button secondary small recorded-usage-refresh" disabled={!active} aria-disabled={!active || pending} onClick={refresh}>{snapshot ? "Refresh usage" : "Check usage again"}</button>} />
  </>;
}
