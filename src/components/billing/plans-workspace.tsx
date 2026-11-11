"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  billingRedirectResponseSchema,
  billingSummaryResponseSchema,
  formatMonthlyPrice,
  PLAN_CATALOG,
  type BillingSummary,
  type PaidPlanId,
  type PlanId,
} from "@/domain/billing";
import { Icon } from "@/components/ui/icon";
import { accountRequest, AccountRequestError } from "@/components/workspace/account-api";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import "@/styles/plans.css";

export type PlansReturnState = "checkout_success" | "checkout_cancelled" | "portal_updated" | null;

const ORDER: PlanId[] = ["free", "pro", "studio"];
const FALLBACK_CREDITS: Record<PlanId, number> = { free: 30, pro: 150, studio: 500 };

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

/** What the page says after a request fails. Never a cost estimate. */
export function billingErrorMessage(error: unknown) {
  if (error instanceof AccountRequestError) {
    if (error.status === 409) return "You already have a paid plan. Use Manage plan to change or cancel it.";
    if (error.status === 401) return "Your session ended. Sign in again to continue.";
    if (error.status === 403) return "This request was blocked. Reload the page and try again.";
    if (error.status === 404) return "There’s no paid plan to manage on this account yet.";
    if (error.status === 503) return "Payments are unavailable right now. Nothing was charged. Try again shortly.";
  }
  return "This couldn’t be opened. Nothing was charged. Try again.";
}

export function PlansWorkspace({ returnState = null }: { returnState?: PlansReturnState }) {
  const { session } = useAccountSession();
  return (
    <div className="page plans-page">
      <div className="plans-heading">
        <h1>Plans</h1>
        <p>Every plan includes the full branding journey. Paid plans add more credits each month.</p>
      </div>
      {session.status === "ready" ? (
        <OwnedPlans key={`${session.userId}:${session.generation}`} account={session} returnState={returnState} />
      ) : (
        <>
          <PlanGrid summary={null} busy={null} onChoose={null} signedIn={false} />
          <p className="plans-message" role="status">
            {session.status === "checking"
              ? "Checking your account…"
              : session.status === "signed_out"
                ? "Sign in to choose a plan."
                : "Your account can’t be checked right now. Check your connection and try again."}
          </p>
        </>
      )}
    </div>
  );
}

type PlanChoice = "checkout" | "portal" | "cancel";
type Busy = { plan: PlanId; action: PlanChoice } | null;

function OwnedPlans({ account, returnState }: { account: VerifiedAccount; returnState: PlansReturnState }) {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(returnState === "checkout_success");
  const inFlight = useRef(false);
  const currentPlan = summary?.subscription?.planId ?? null;

  const load = useCallback(async (signal: AbortSignal) => {
    const { billing } = await accountRequest("/api/billing", billingSummaryResponseSchema, { signal });
    return billing;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const check = async () => {
      try {
        const billing = await load(controller.signal);
        if (controller.signal.aborted) return;
        setSummary(billing);
        setLoadError(false);
        // After Checkout, Stripe confirms the payment to our server within seconds.
        if (returnState === "checkout_success" && !billing.subscription && attempts < 15) {
          attempts += 1;
          timer = setTimeout(check, 2000);
        } else {
          setWaiting(false);
        }
      } catch {
        if (!controller.signal.aborted) {
          setLoadError(true);
          setWaiting(false);
        }
      }
    };
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [load, returnState]);

  const choose = useCallback(
    async (plan: PlanId, action: PlanChoice) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy({ plan, action });
      setError(null);
      try {
        // Manage opens the portal home; another paid plan opens straight on that change.
        // Cancel opens straight on cancelling the current plan at the end of its paid period.
        const body =
          action === "cancel"
            ? { action: "cancel" as const }
            : action === "checkout" || (plan !== "free" && plan !== currentPlan)
              ? { plan }
              : {};
        const { url } = await accountRequest(
          action === "checkout" ? "/api/billing/checkout" : "/api/billing/portal",
          billingRedirectResponseSchema,
          { method: "POST", body, expectedOwnerId: account.userId, signal: new AbortController().signal },
        );
        window.location.assign(url);
      } catch (cause) {
        setError(billingErrorMessage(cause));
        setBusy(null);
        inFlight.current = false;
      }
    },
    [account.userId, currentPlan],
  );

  return (
    <>
      <ReturnNotice returnState={returnState} waiting={waiting} summary={summary} />
      {summary && <CurrentPlan summary={summary} />}
      {loadError && (
        <p className="plans-message plans-error" role="alert">
          Your plan can’t be shown right now. Check your connection and try again.
        </p>
      )}
      {error && (
        <p className="plans-message plans-error" role="alert">
          {error}
        </p>
      )}
      <PlanGrid summary={summary} busy={busy} onChoose={summary ? choose : null} signedIn />
      <p className="plans-footnote">
        Prices are in US dollars, billed monthly. Taxes are added at checkout where they apply. Payments are processed
        by Stripe through Link, which handles receipts and billing support. Cancel anytime with Cancel plan; your plan
        stays active until the end of the period you paid for.
      </p>
    </>
  );
}

function ReturnNotice({
  returnState,
  waiting,
  summary,
}: {
  returnState: PlansReturnState;
  waiting: boolean;
  summary: BillingSummary | null;
}) {
  if (!returnState) return null;
  if (returnState === "checkout_cancelled")
    return (
      <p className="plans-notice" role="status">
        Checkout was cancelled. Nothing was charged.
      </p>
    );
  if (returnState === "portal_updated")
    return (
      <p className="plans-notice" role="status">
        Your plan change is saved. New credits appear here once the payment is confirmed.
      </p>
    );
  const active = summary?.subscription ? PLAN_CATALOG[summary.subscription.planId as PlanId] : null;
  return (
    <p className="plans-notice plans-notice-positive" role="status">
      {active
        ? `Thank you. Your ${active.name} plan is active.`
        : waiting
          ? "Thank you. Confirming your payment…"
          : "Thank you. Your payment is being confirmed; your new credits appear here within a few minutes."}
    </p>
  );
}

function CurrentPlan({ summary }: { summary: BillingSummary }) {
  const plan = PLAN_CATALOG[summary.planId as PlanId];
  const subscription = summary.subscription;
  const periodEnd = formatDate(subscription?.currentPeriodEnd ?? summary.periodEnd);
  let detail: string;
  if (subscription?.status === "past_due")
    detail = "Your last payment didn’t go through. Update your payment method in Manage plan to keep your plan.";
  else if (subscription?.cancelAtPeriodEnd)
    detail = `Your plan ends${periodEnd ? ` on ${periodEnd}` : ""}. You’ll return to Free after that.`;
  else if (subscription) detail = `Renews${periodEnd ? ` on ${periodEnd}` : ""} with a new monthly allowance.`;
  else detail = `New monthly credits${periodEnd ? ` on ${periodEnd}` : " next month"}.`;
  return (
    <section className="plans-current" aria-label="Your plan and credits">
      <div>
        <span className="plans-current-label">Your plan</span>
        <strong>{plan?.name ?? summary.planId}</strong>
      </div>
      <div>
        <span className="plans-current-label">Credits left</span>
        <strong>{Math.max(summary.balance, 0).toLocaleString("en-US")}</strong>
      </div>
      <p>{detail}</p>
    </section>
  );
}

function PlanGrid({
  summary,
  busy,
  onChoose,
  signedIn,
}: {
  summary: BillingSummary | null;
  busy: Busy;
  onChoose: ((plan: PlanId, action: PlanChoice) => void) | null;
  signedIn: boolean;
}) {
  const subscription = summary?.subscription ?? null;
  const currentPlan: PlanId | null = summary
    ? subscription
      ? (subscription.planId as PlanId)
      : (summary.planId as PlanId)
    : null;
  return (
    <ul className="plans-grid" aria-label="Plans">
      {ORDER.map((id) => {
        const catalog = PLAN_CATALOG[id];
        const credits = summary?.plans.find((plan) => plan.id === id)?.monthlyCredits ?? FALLBACK_CREDITS[id];
        const current = currentPlan === id;
        return (
          <li key={id} className="plans-card" data-current={current || undefined}>
            <header>
              <h2>{catalog.name}</h2>
              {current && <span className="plans-badge">Current plan</span>}
            </header>
            <p className="plans-price">
              <strong>{formatMonthlyPrice(catalog.monthlyPriceCents)}</strong>
              <span>/ month</span>
            </p>
            <p className="plans-credits">
              <Icon name="check" size={16} />
              {credits.toLocaleString("en-US")} credits every month
            </p>
            <p className="plans-description">{catalog.description}</p>
            <PlanAction
              id={id}
              current={current}
              subscribed={Boolean(subscription)}
              cancelling={Boolean(subscription?.cancelAtPeriodEnd)}
              busy={busy}
              onChoose={onChoose}
              signedIn={signedIn}
            />
          </li>
        );
      })}
    </ul>
  );
}

function PlanAction({
  id,
  current,
  subscribed,
  cancelling,
  busy,
  onChoose,
  signedIn,
}: {
  id: PlanId;
  current: boolean;
  subscribed: boolean;
  cancelling: boolean;
  busy: Busy;
  onChoose: ((plan: PlanId, action: PlanChoice) => void) | null;
  signedIn: boolean;
}) {
  const disabled = !onChoose || busy !== null;
  const pending = busy?.plan === id;
  if (id === "free") {
    if (!subscribed) return null;
    return <p className="plans-hint">To return to Free, use Cancel plan on your current plan.</p>;
  }
  if (!signedIn) {
    return (
      <Link className="button secondary" href="/sign-in">
        Sign in to choose
      </Link>
    );
  }
  if (!onChoose) {
    return (
      <button type="button" className="button secondary" disabled>
        {`${PLAN_CATALOG[id as PaidPlanId].name}`}
      </button>
    );
  }
  if (subscribed && current) {
    return (
      <div className="plans-actions">
        <button type="button" className="button secondary" disabled={disabled} onClick={() => onChoose(id, "portal")}>
          {pending && busy?.action === "portal" ? "Opening…" : "Manage plan"}
        </button>
        {!cancelling && (
          <button type="button" className="button secondary" disabled={disabled} onClick={() => onChoose(id, "cancel")}>
            {pending && busy?.action === "cancel" ? "Opening…" : "Cancel plan"}
          </button>
        )}
      </div>
    );
  }
  if (subscribed) {
    return (
      <button type="button" className="button secondary" disabled={disabled} onClick={() => onChoose(id, "portal")}>
        {pending ? "Opening…" : `Switch to ${PLAN_CATALOG[id as PaidPlanId].name}`}
      </button>
    );
  }
  return (
    <button type="button" className="button primary" disabled={disabled} onClick={() => onChoose(id, "checkout")}>
      {pending ? "Opening checkout…" : `Upgrade to ${PLAN_CATALOG[id as PaidPlanId].name}`}
    </button>
  );
}
