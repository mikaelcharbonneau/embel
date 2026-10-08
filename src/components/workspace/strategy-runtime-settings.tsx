"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { z } from "zod";
import { strategyRuntimeResponseSchema } from "@/domain/strategy-jobs";
import { accountRequest, AccountRequestError } from "./account-api";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { strategyLabels } from "./account-strategy-client";

type Availability = z.infer<typeof strategyRuntimeResponseSchema>["availability"];
const unavailableReasons: Record<NonNullable<Availability["reason"]>, string> = {
  runtime_disabled: "Text requests are not enabled for this account.",
  worker_unavailable: "The text worker is not ready. Check again after it is connected.",
  budget_unavailable: "The approved text budget is unavailable.",
  subscription_unavailable: "The ChatGPT subscription connection is unavailable.",
  quota_unavailable: "The current text request limit is unavailable. Check again when capacity is available.",
};
// Preserve the exact admission cap rather than rounding a small API limit to cents.
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 });

function StatusRow({ status, children }: { status: string; children: ReactNode }) {
  return <div className="setting-row" aria-label="Text and strategy status">
    <div><strong>Text and strategy</strong>{children}</div>
    <span className="connection-status"><span />{status}</span>
  </div>;
}

/** Read-only admission status. Neither configuration nor readiness proves inference. */
export function StrategyRuntimeSettings() {
  const { session } = useAccountSession();
  if (session.status !== "ready") return <StatusRow status={session.status === "checking" ? "Checking" : "Not checked"}>
    <p>{session.status === "signed_out" ? "Sign in to Fluid to check text availability for your account." : session.status === "checking" ? "Checking your Fluid account…" : "Verify your Fluid account to check text availability."}</p>
  </StatusRow>;
  // Reverification, sign-out and owner changes discard all earlier private status.
  return <OwnedStrategyRuntimeSettings key={`${session.userId}:${session.generation}`} account={session} />;
}

function OwnedStrategyRuntimeSettings({ account }: { account: VerifiedAccount }) {
  const { isCurrent, expire } = useAccountSession();
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const current = () => !disposed && !controller.signal.aborted && isCurrent(account);
    const timeout = setTimeout(() => {
      if (current()) setError(true);
      controller.abort();
    }, 15_000);
    void accountRequest("/api/strategy", strategyRuntimeResponseSchema, { signal: controller.signal }).then(reply => {
      if (current()) setAvailability(reply.availability);
    }).catch(cause => {
      if (!current()) return;
      setError(true);
      if (cause instanceof AccountRequestError && cause.status === 401) expire(account);
    }).finally(() => clearTimeout(timeout));
    return () => { disposed = true; controller.abort(); clearTimeout(timeout); };
  }, [account, expire, isCurrent, revision]);

  const checking = !availability && !error;
  const status = error ? "Not verified" : checking ? "Checking" : availability?.status === "available" ? "Available for requests" : "Unavailable";
  return <StatusRow status={status}>
    {error ? <p role="alert">Text status could not be checked. Check your connection and try again.</p> :
      !availability ? <p role="status">Checking text availability…</p> : availability.status === "unavailable" ?
        <p>{unavailableReasons[availability.reason!]}</p> : <>
          <p>Only these operations are currently available for your account:</p>
          <ul>{availability.operations.map((item, index) => <li key={`${item.operation}:${index}`}>
            {strategyLabels[item.operation]} · {item.billingMode === "chatgpt_subscription" ?
              `ChatGPT subscription · plan limits apply; up to ${item.limits.maxRequestsPerHour} requests/hour and ${item.limits.maxQueuedJobs} queued requests.` :
              `OpenAI API · up to ${dollars.format(item.maximumCostMicrousd / 1_000_000)} USD per request.`}
          </li>)}</ul>
        </>}
    <p>Availability is a readiness check, not proof of a completed live response. Image generation is checked separately. Sending a request rechecks its current limits.</p>
    <button type="button" className="button secondary small" disabled={checking} onClick={() => {
      setAvailability(null); setError(false); setRevision(value => value + 1);
    }}>Check text status</button>
  </StatusRow>;
}
