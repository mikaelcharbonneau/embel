"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RECORDED_USAGE_LIMIT, recordedUsageSchema, type RecordedUsage } from "@/domain/recorded-usage";
import { buttonClass } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/icon";
import { InlineMessage } from "@/components/ui/message";
import { accountRequest, AccountRequestError } from "./account-api";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { BrowserLocalDate } from "./browser-local-date";
import "@/styles/recorded-usage.css";

type Entry = RecordedUsage["entries"][number];
const labels: Record<Entry["operation"], string> = {
  "strategy.reformulate": "Strategy · Brief",
  "strategy.competitors": "Strategy · Competitors",
  "strategy.audience": "Strategy · Audience",
  "strategy.positioning": "Strategy · Positioning",
  "strategy.personality": "Voice · Personality",
  "naming.generate": "Voice · Name",
  "strategy.slogan": "Voice · Slogan",
};
const notRecorded = "Not recorded for this request.";

/** Input plus output when both were recorded; never an estimate. */
function tokensUsed(tokens: Entry["tokens"]) {
  if (!tokens) return null;
  const sum = tokens.inputTokens + tokens.outputTokens;
  return tokens.totalTokens ?? (Number.isSafeInteger(sum) ? sum : null);
}
function usageSummary(usage: RecordedUsage) {
  const count = usage.entries.length;
  if (!count) return "No requests yet.";
  const used = usage.entries
    .map((entry) => tokensUsed(entry.tokens))
    .filter((value): value is number => value !== null);
  const total = used.reduce((sum, value) => sum + BigInt(value), 0n).toLocaleString("en-US");
  const requests =
    count === usage.limit ? `Last ${count} requests` : `${count} ${count === 1 ? "request" : "requests"}`;
  return `${requests} · ${!used.length ? "tokens not recorded" : used.length < count ? `at least ${total} tokens used` : `${total} tokens used`}`;
}

export function RecordedUsageSection({ active = true }: { active?: boolean }) {
  const { session } = useAccountSession();
  return (
    <section className="recorded-usage e-card" aria-labelledby="recorded-usage-title">
      {session.status === "ready" ? (
        <OwnedRecordedUsage key={`${session.userId}:${session.generation}`} account={session} active={active} />
      ) : (
        <>
          <UsageHeader />
          {session.status === "checking" ? (
            <>
              <p className="sr-only" role="status">
                Checking your account…
              </p>
              <PendingUsageFrame />
              <CoverageNote />
            </>
          ) : (
            <p className="recorded-usage-message" role="status">
              {session.status === "signed_out"
                ? "Sign in to see your usage."
                : "Your usage can’t be shown right now. Check your connection and try again."}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function UsageHeader({ summary, action }: { summary?: string; action?: ReactNode }) {
  return (
    <header className="recorded-usage-header">
      <div className="e-stack e-stack--xs">
        <h2 id="recorded-usage-title" className="e-section__title">
          Recent requests
        </h2>
        <p className="recorded-usage-summary e-section__hint">
          {summary ?? "Requests Embel completed for you, newest first."}
        </p>
      </div>
      {action}
    </header>
  );
}

function CoverageNote() {
  return <p className="recorded-usage-note">Logo and image requests are not included.</p>;
}

function PendingUsageFrame() {
  // Public page capacity only: never carry private row counts, text or measured
  // geometry through account verification. Terminal states remove this frame.
  // The column names are public too; the skeleton rows have the table's row height.
  return (
    <>
      <div className="recorded-usage-pending-head" aria-hidden="true">
        <span>Step</span>
        <span>Date</span>
        <span>Tokens used</span>
      </div>
      <div className="recorded-usage-pending-frame" aria-hidden="true" inert>
        {Array.from({ length: RECORDED_USAGE_LIMIT }, (_, index) => (
          <div key={index} className="recorded-usage-pending-slot">
            <Skeleton width={40} />
            <Skeleton width={40} />
            <Skeleton width={60} />
          </div>
        ))}
      </div>
    </>
  );
}

function UsageTable({ entries }: { entries: RecordedUsage["entries"] }) {
  const unrecorded = entries.some((entry) => tokensUsed(entry.tokens) === null);
  return (
    <>
      <table className="e-table recorded-usage-table">
        <caption className="sr-only">Recent requests</caption>
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Date</th>
            <th scope="col" className="is-num">
              Tokens used
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const used = tokensUsed(entry.tokens);
            return (
              <tr key={entry.id} className="recorded-usage-entry">
                <th scope="row">{labels[entry.operation]}</th>
                <td>
                  <BrowserLocalDate dateTime={entry.completedAt} />
                </td>
                <td className="is-num">
                  {used === null ? (
                    <>
                      <span aria-hidden="true">—</span>
                      <span className="sr-only">{notRecorded}</span>
                    </>
                  ) : (
                    used.toLocaleString("en-US")
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {unrecorded && (
        <p className="recorded-usage-note" aria-hidden="true">
          — {notRecorded}
        </p>
      )}
    </>
  );
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
    return () => {
      committedCycle.current = null;
    };
  }, [cycle]);
  useEffect(() => {
    if (!active) {
      reading.current = false;
      return;
    }
    const controller = new AbortController();
    const epoch = ++readEpoch.current;
    let disposed = false;
    let failed = false;
    const current = () =>
      !disposed && readEpoch.current === epoch && committedCycle.current === cycle && scope.isCurrent(scope.account);
    reading.current = true;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    void accountRequest("/api/usage", recordedUsageSchema, { signal: controller.signal })
      .then((reply) => {
        if (!current() || controller.signal.aborted) return;
        if (reply.ownerId !== scope.account.userId) {
          scope.expire(scope.account);
          return;
        }
        setStored({ scope, data: reply });
      })
      .catch((cause) => {
        if (!current()) return;
        if (cause instanceof AccountRequestError && cause.status === 401) {
          scope.expire(scope.account);
          return;
        }
        failed = true;
      })
      .finally(() => {
        clearTimeout(timeout);
        if (current()) {
          reading.current = false;
          setSettled({ cycle, error: failed });
        }
      });
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timeout);
      readEpoch.current = epoch + 1;
      reading.current = false;
    };
  }, [active, scope, cycle]);
  function refresh() {
    if (!active || pending || reading.current || committedCycle.current !== cycle || !scope.isCurrent(scope.account))
      return;
    reading.current = true;
    setRetry((value) => value + 1);
  }
  return (
    <>
      <UsageHeader
        summary={snapshot ? usageSummary(snapshot) : undefined}
        action={
          // aria-disabled, not disabled, while reading: the button keeps focus through a refresh.
          <button
            type="button"
            className={buttonClass({ size: "sm" }, "recorded-usage-refresh")}
            disabled={!active}
            aria-disabled={!active || pending}
            onClick={refresh}
          >
            <Icon name="refresh-cw" size="sm" />
            Refresh
          </button>
        }
      />
      {/* Progress is announced, not shown; failures stay visible. */}
      <p className="sr-only" role="status">
        {pending ? (snapshot ? "Refreshing usage…" : "Loading usage…") : error ? "" : "Usage loaded."}
      </p>
      {error && (
        <InlineMessage tone="danger" className="recorded-usage-error">
          {snapshot
            ? "Usage couldn’t be refreshed. The list shows the last results. Check your connection, then press Refresh."
            : "Usage couldn’t be loaded. Check your connection, then press Refresh."}
        </InlineMessage>
      )}
      {!snapshot && pending && <PendingUsageFrame />}
      {snapshot && snapshot.entries.length > 0 && <UsageTable entries={snapshot.entries} />}
      {snapshot && snapshot.entries.length === 0 && (
        <EmptyState
          icon="clock"
          headingLevel={3}
          title="No requests yet"
          text="Your usage appears here after Embel completes a step for you."
        />
      )}
      <CoverageNote />
    </>
  );
}
