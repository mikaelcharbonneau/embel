"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  billingRedirectResponseSchema,
  billingSummaryResponseSchema,
  formatMonthlyPrice,
  PLAN_CATALOG,
  PLAN_MONTHLY_CREDITS,
  type BillingSummary,
  type PlanId,
} from "@/domain/billing";
import {
  COMPLETE_BRAND_CREDITS,
  COMPLETE_BRAND_CREDITS_REQUIRED,
  completeBrandsPerMonth,
  STEP_CREDITS,
} from "@/domain/step-credits";
import { Button, ButtonLink } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/icon";
import { InlineMessage } from "@/components/ui/message";
import { accountRequest, AccountRequestError } from "@/components/workspace/account-api";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import "@/styles/plans.css";

export type PlansReturnState = "checkout_success" | "checkout_cancelled" | "portal_updated" | null;

const ORDER: PlanId[] = ["free", "pro", "studio"];
/** What each plan is for, under its credits. */
const PLAN_PITCH: Record<PlanId, string> = {
  free: "Try the full branding journey, with credits to spare for a second set of logo concepts.",
  pro: "For building a brand from idea to assets, with room to redo any step until it is right.",
  studio: "For people working on several brands.",
};
/** The one plan the page recommends to someone on Free or signed out. */
const RECOMMENDED: PlanId = "pro";

/** Renewal dates read like the out-of-credits message in a step ("December 1", in UTC), so both show the same
 * day for the same credit period. */
function renewalDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

const credits = (value: number) => Math.max(value, 0).toLocaleString("en-US");

type BillingAction = "checkout" | "portal";

/** What the page says after a request fails. Never a cost estimate. */
export function billingErrorMessage(error: unknown, action: BillingAction = "checkout") {
  const opened = action === "checkout" ? "Checkout couldn’t open" : "Your plan settings couldn’t open";
  const nothing = action === "checkout" ? "Nothing was charged." : "Nothing was changed.";
  if (error instanceof AccountRequestError) {
    if (error.status === 409) return "You already have a paid plan. Use Manage plan to change or cancel it.";
    if (error.status === 401) return "Your session ended. Sign in again to continue.";
    if (error.status === 403) return "This request was blocked. Reload the page and try again.";
    if (error.status === 404) return "There’s no paid plan to manage on this account yet.";
    if (error.status === 503) return `${opened} because payments are unavailable right now. ${nothing}`;
  }
  return `${opened}. ${nothing}`;
}

/** Only a failure that a second press can fix offers Try again. */
function retryable(error: unknown) {
  return !(error instanceof AccountRequestError) || ![401, 403, 404, 409].includes(error.status);
}

export function PlansWorkspace({ returnState = null }: { returnState?: PlansReturnState }) {
  const { session } = useAccountSession();
  let body: ReactNode;
  if (session.status === "ready")
    body = <OwnedPlans key={`${session.userId}:${session.generation}`} account={session} returnState={returnState} />;
  else if (session.status === "signed_out")
    body = (
      <>
        <PlanGrid view={{ kind: "signed_out" }} />
        <p className="plans-sign-in">
          Already have an account?{" "}
          <Link className="e-link" href="/sign-in">
            Sign in
          </Link>{" "}
          to see your plan and credits.
        </p>
      </>
    );
  else if (session.status === "checking") body = <LoadingPlans />;
  else
    body = (
      <>
        <InlineMessage tone="danger">
          Your account can’t be checked right now. Check your connection and try again.
        </InlineMessage>
        <PlanGrid view={{ kind: "unavailable" }} />
      </>
    );
  return (
    <div className="e-container e-page plans-page">
      <header className="plans-heading">
        <h1>Plans</h1>
        <p>Every plan includes the full branding journey. Paid plans add more credits each month.</p>
      </header>
      {body}
      <CreditPrices />
      <p className="plans-footnote">
        Prices are in US dollars, billed monthly. Taxes are added at checkout where they apply. Payments are processed
        by Stripe through Link, which handles receipts and billing support. Cancel anytime with Cancel plan; your plan
        stays active until the end of the period you paid for.
      </p>
    </div>
  );
}

function LoadingPlans() {
  return (
    <>
      <div className="e-card e-card--pad plans-summary" role="status" aria-label="Loading your plan" aria-busy="true">
        <div className="plans-summary__stats">
          <div className="e-stat">
            <span className="e-stat__label">Your plan</span>
            <Skeleton shape="title" className="plans-summary__skeleton" />
          </div>
          <div className="e-stat">
            <span className="e-stat__label">Credits left this month</span>
            <Skeleton shape="title" className="plans-summary__skeleton plans-summary__skeleton--short" />
          </div>
        </div>
      </div>
      <PlanGrid view={{ kind: "loading" }} />
    </>
  );
}

type PlanChoice = "checkout" | "portal" | "cancel";
type Attempt = { plan: PlanId; action: PlanChoice };
type Failure = { attempt: Attempt; message: string; retry: boolean; signIn: boolean };

function OwnedPlans({ account, returnState }: { account: VerifiedAccount; returnState: PlansReturnState }) {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<Attempt | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [waiting, setWaiting] = useState(returnState === "checkout_success");
  const inFlight = useRef(false);
  const currentPlan = summary?.subscription?.planId ?? null;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const check = async () => {
      try {
        const { billing } = await accountRequest("/api/billing", billingSummaryResponseSchema, {
          signal: controller.signal,
        });
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
  }, [returnState, reload]);

  const choose = useCallback(
    async (plan: PlanId, action: PlanChoice) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy({ plan, action });
      setFailure(null);
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
        setFailure({
          attempt: { plan, action },
          message: billingErrorMessage(cause, action === "checkout" ? "checkout" : "portal"),
          retry: retryable(cause),
          signIn: cause instanceof AccountRequestError && cause.status === 401,
        });
        setBusy(null);
        inFlight.current = false;
      }
    },
    [account.userId, currentPlan],
  );

  const plan = summary ? planOf(summary) : null;
  const monthly = summary && plan ? monthlyCredits(summary, plan) : null;
  const outOfCredits = summary !== null && summary.balance <= 0;
  const nextStep = plan ? upgradeFrom(plan, Boolean(summary?.subscription)) : null;

  return (
    <>
      {failure && (
        <InlineMessage
          tone="danger"
          actions={
            failure.retry ? (
              <Button
                size="sm"
                icon="rotate-ccw"
                loading={busy !== null}
                onClick={() => void choose(failure.attempt.plan, failure.attempt.action)}
              >
                Try again
              </Button>
            ) : failure.signIn ? (
              <ButtonLink size="sm" href="/sign-in">
                Sign in
              </ButtonLink>
            ) : undefined
          }
        >
          {failure.message}
        </InlineMessage>
      )}
      <ReturnNotice returnState={returnState} waiting={waiting} summary={summary} />
      {loadError && (
        <InlineMessage
          tone="danger"
          actions={
            <Button size="sm" icon="rotate-ccw" onClick={() => setReload((value) => value + 1)}>
              Try again
            </Button>
          }
        >
          Your plan can’t be shown right now. Check your connection and try again.
        </InlineMessage>
      )}
      {summary?.subscription?.status === "past_due" && (
        <InlineMessage tone="warning" live={false}>
          Your last payment didn’t go through. Update your payment method in Manage plan to keep your plan.
        </InlineMessage>
      )}
      {summary && plan && outOfCredits ? (
        <InlineMessage
          live={false}
          className="plans-out-of-credits"
          actions={
            nextStep ? (
              <Button
                variant="primary"
                size="sm"
                loading={busy?.plan === nextStep.plan && busy.action === nextStep.action}
                disabled={busy !== null && !(busy.plan === nextStep.plan && busy.action === nextStep.action)}
                onClick={() => void choose(nextStep.plan, nextStep.action)}
              >
                {nextStep.label}
              </Button>
            ) : undefined
          }
        >
          {outOfCreditsText(monthly ?? 0, renewalDate(summary.periodEnd))}
        </InlineMessage>
      ) : summary && plan ? (
        <CurrentPlan summary={summary} plan={plan} monthly={monthly ?? 0} />
      ) : !loadError ? (
        <LoadingPlans />
      ) : null}
      {summary && plan ? (
        <PlanGrid view={{ kind: "owned", summary, plan, busy, onChoose: (id, action) => void choose(id, action) }} />
      ) : loadError ? (
        <PlanGrid view={{ kind: "unavailable" }} />
      ) : null}
    </>
  );
}

/** The plan the account is on: a live subscription's plan, otherwise the account's own. */
function planOf(summary: BillingSummary): PlanId {
  const id = summary.subscription?.planId ?? summary.planId;
  return id in PLAN_CATALOG ? (id as PlanId) : "free";
}

function monthlyCredits(summary: BillingSummary | null, plan: PlanId) {
  return summary?.plans.find((item) => item.id === plan)?.monthlyCredits ?? PLAN_MONTHLY_CREDITS[plan];
}

/** A zero balance in one sentence, with the renewal date and what is kept. */
function outOfCreditsText(monthly: number, date: string | null) {
  return `You’ve used this month’s ${credits(monthly)} credits.${date ? ` New credits arrive on ${date}.` : ""} Your work is saved.`;
}

/** The next plan up and how to reach it: Checkout from Free, the portal from a paid plan. */
function upgradeFrom(plan: PlanId, subscribed: boolean) {
  if (plan === "studio") return null;
  const next: PlanId = plan === "free" ? "pro" : "studio";
  return subscribed
    ? { plan: next, action: "portal" as const, label: `Switch to ${PLAN_CATALOG[next].name}` }
    : { plan: next, action: "checkout" as const, label: `Upgrade to ${PLAN_CATALOG[next].name}` };
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
    return <InlineMessage>Checkout was cancelled. Nothing was charged.</InlineMessage>;
  if (returnState === "portal_updated")
    return (
      <InlineMessage>Your plan change is saved. New credits appear here once the payment is confirmed.</InlineMessage>
    );
  const active = summary?.subscription ? PLAN_CATALOG[summary.subscription.planId as PlanId] : null;
  return (
    <InlineMessage tone="positive">
      {active
        ? `Thank you. Your ${active.name} plan is active.`
        : waiting
          ? "Thank you. Your payment is being confirmed. Your new plan and credits appear here within a few minutes."
          : "Thank you. Your payment is being confirmed. Your new plan and credits appear here within a few minutes; reload the page to check."}
    </InlineMessage>
  );
}

function CurrentPlan({ summary, plan, monthly }: { summary: BillingSummary; plan: PlanId; monthly: number }) {
  const subscription = summary.subscription;
  const date = renewalDate(subscription?.currentPeriodEnd ?? summary.periodEnd);
  let detail: string | null;
  if (subscription?.status === "past_due") detail = null;
  else if (subscription?.cancelAtPeriodEnd)
    detail = `Your plan ends${date ? ` on ${date}` : ""}. You’ll return to Free after that.`;
  else if (subscription) detail = `Your plan renews${date ? ` on ${date}` : ""} with ${credits(monthly)} new credits.`;
  else detail = date ? `New credits arrive on ${date}.` : "New credits arrive next month.";
  return (
    <section className="e-card e-card--pad plans-summary" aria-label="Your plan and credits">
      <div className="plans-summary__stats">
        <div className="e-stat">
          <span className="e-stat__label">Your plan</span>
          <strong className="e-stat__value">{PLAN_CATALOG[plan].name}</strong>
        </div>
        <div className="e-stat">
          <span className="e-stat__label">Credits left this month</span>
          <strong className="e-stat__value">{credits(summary.balance)}</strong>
        </div>
      </div>
      {detail && <p className="plans-summary__detail">{detail}</p>}
    </section>
  );
}

type GridView =
  | { kind: "signed_out" }
  | { kind: "loading" }
  | { kind: "unavailable" }
  | {
      kind: "owned";
      summary: BillingSummary;
      plan: PlanId;
      busy: Attempt | null;
      onChoose: (plan: PlanId, action: PlanChoice) => void;
    };

function PlanGrid({ view }: { view: GridView }) {
  const owned = view.kind === "owned" ? view : null;
  const current = owned?.plan ?? null;
  const showRecommended = view.kind === "signed_out" || current === "free";
  return (
    <ul className="plans-grid" aria-label="Plans">
      {ORDER.map((id) => {
        const catalog = PLAN_CATALOG[id];
        const monthly = monthlyCredits(owned?.summary ?? null, id);
        const brands = completeBrandsPerMonth(monthly);
        const isCurrent = current === id;
        return (
          <li key={id} className="e-card e-card--pad e-plan plans-card" data-selected={isCurrent || undefined}>
            <header className="plans-card__head">
              <h2>{catalog.name}</h2>
              {isCurrent ? (
                <span className="e-badge">
                  <Icon name="check" size="sm" />
                  Current plan
                </span>
              ) : showRecommended && id === RECOMMENDED ? (
                <span className="e-badge">Recommended</span>
              ) : null}
            </header>
            <p className="e-plan__price">
              {formatMonthlyPrice(catalog.monthlyPriceCents)} <small>USD a month</small>
            </p>
            <p className="plans-card__outcome">
              About {brands} complete {brands === 1 ? "brand" : "brands"} a month
            </p>
            <ul className="e-list-check plans-card__list">
              <li>
                <Icon name="check" size="sm" />
                <span>
                  <strong>{monthly.toLocaleString("en-US")}</strong> credits every month
                </span>
              </li>
              <li>
                <Icon name="check" size="sm" />
                <span>{PLAN_PITCH[id]}</span>
              </li>
            </ul>
            <PlanAction id={id} view={view} />
          </li>
        );
      })}
    </ul>
  );
}

function PlanAction({ id, view }: { id: PlanId; view: GridView }) {
  const name = PLAN_CATALOG[id].name;
  if (view.kind === "signed_out")
    return (
      <div className="plans-card__actions">
        <ButtonLink variant={id === RECOMMENDED ? "primary" : "secondary"} block href="/sign-up">
          {id === "free" ? "Create free account" : `Create account to choose ${name}`}
        </ButtonLink>
      </div>
    );
  if (view.kind === "loading")
    return id === "free" ? null : (
      <div className="plans-card__actions">
        <Skeleton shape="block" />
      </div>
    );
  if (view.kind === "unavailable") return null;

  const { summary, plan, busy, onChoose } = view;
  const subscription = summary.subscription;
  const pending = (action: PlanChoice) => busy?.plan === id && busy.action === action;
  const blocked = (action: PlanChoice) => busy !== null && !pending(action);
  const action = (choice: PlanChoice, label: string, variant: "primary" | "secondary" | "quiet") => (
    <Button
      variant={variant}
      block
      loading={pending(choice)}
      disabled={blocked(choice)}
      onClick={() => onChoose(id, choice)}
    >
      {label}
    </Button>
  );

  if (id === "free") {
    if (!subscription) return null;
    const paid = PLAN_CATALOG[plan].name;
    return (
      <p className="plans-card__note">
        {subscription.cancelAtPeriodEnd
          ? "You return to Free when the month you paid for ends."
          : `If you cancel ${paid}, you return to Free when the month you paid for ends.`}
      </p>
    );
  }
  if (subscription && plan === id)
    return (
      <div className="plans-card__actions">
        {action("portal", "Manage plan", "secondary")}
        {!subscription.cancelAtPeriodEnd && action("cancel", "Cancel plan", "quiet")}
      </div>
    );
  if (subscription)
    return <div className="plans-card__actions">{action("portal", `Switch to ${name}`, "secondary")}</div>;
  return (
    <div className="plans-card__actions">
      {action("checkout", `Upgrade to ${name}`, id === RECOMMENDED ? "primary" : "secondary")}
    </div>
  );
}

function CreditPrices() {
  return (
    <section className="plans-prices" aria-labelledby="plans-prices-title">
      <table className="e-table e-table--stack">
        <caption id="plans-prices-title">What a credit buys</caption>
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">What you get</th>
            <th scope="col" className="is-num">
              Credits
            </th>
          </tr>
        </thead>
        <tbody>
          {STEP_CREDITS.map((row) => (
            <tr key={`${row.step}:${row.delivers}`}>
              <td data-label="Step">{row.step}</td>
              <td data-label="What you get">{row.delivers}</td>
              <td data-label="Credits" className="is-num">
                {row.credits}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="plans-prices__note">
        A complete brand with every step done once uses {COMPLETE_BRAND_CREDITS} credits, or{" "}
        {COMPLETE_BRAND_CREDITS_REQUIRED} without a slogan. Credits pay only for what is delivered: a step that fails
        gives its credits back. Unused credits don’t carry over to the next month.
      </p>
    </section>
  );
}
