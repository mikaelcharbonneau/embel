"use client";

import { useEffect, useState } from "react";
import { billingSummaryResponseSchema, PLAN_CATALOG, type BillingSummary, type PlanId } from "@/domain/billing";
import { accountRequest } from "@/components/workspace/account-api";
import { useAccountSession } from "@/components/workspace/account-session";
import { Button, ButtonLink } from "@/components/ui/button";
import { InlineMessage } from "@/components/ui/message";
import { Skeleton } from "@/components/ui/feedback";
import { creditsRenewDate } from "@/components/workspace/credits-message";

/** The day the monthly credits renew, as the rest of the app words it. */
const renewalDate = creditsRenewDate;

/** Settings: the account's plan and the credits left this month, with the way to the Plans page. Credits only,
 * never money. */
export function PlanCreditsCard() {
  const { session } = useAccountSession();
  const userId = session.status === "ready" ? session.userId : null;
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    accountRequest("/api/billing", billingSummaryResponseSchema, { signal: controller.signal }).then(
      ({ billing }) => {
        setSummary(billing);
        setFailed(false);
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [userId, attempt]);
  if (!userId) return null;
  const plan = summary ? (PLAN_CATALOG[summary.planId as PlanId]?.name ?? summary.planId) : null;
  const monthly = summary?.plans.find((entry) => entry.id === summary.planId)?.monthlyCredits ?? null;
  const renews = summary ? renewalDate(summary.periodEnd) : null;
  return (
    <section className="e-section" aria-labelledby="plan-credits-title">
      <h2 className="e-section__title" id="plan-credits-title">
        Plan and credits
      </h2>
      {failed && !summary ? (
        <InlineMessage
          tone="danger"
          actions={
            <Button
              size="sm"
              icon="rotate-ccw"
              onClick={() => {
                setFailed(false);
                setAttempt((value) => value + 1);
              }}
            >
              Try again
            </Button>
          }
        >
          Your plan couldn’t be shown. Check your connection, then try again.
        </InlineMessage>
      ) : (
        <div className="e-setting-row sg-plan">
          <div className="e-setting-row__text">
            <dl className="sg-plan__stats" aria-busy={summary ? undefined : true}>
              <div className="e-stat">
                <dt className="e-stat__label">Plan</dt>
                <dd className="e-stat__value">{plan ?? <Skeleton shape="title" className="sg-plan__skeleton" />}</dd>
              </div>
              <div className="e-stat">
                <dt className="e-stat__label">Credits left this month</dt>
                <dd className="e-stat__value">
                  {summary ? (
                    <>
                      {Math.max(summary.balance, 0).toLocaleString("en-US")}
                      {monthly !== null && <small> of {monthly.toLocaleString("en-US")}</small>}
                    </>
                  ) : (
                    <Skeleton shape="title" className="sg-plan__skeleton sg-plan__skeleton--wide" />
                  )}
                </dd>
              </div>
            </dl>
            {renews && <p className="e-section__hint">New credits arrive on {renews}.</p>}
          </div>
          <ButtonLink href="/plans" arrow>
            See plans
          </ButtonLink>
        </div>
      )}
    </section>
  );
}
