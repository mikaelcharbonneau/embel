"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { billingSummaryResponseSchema, PLAN_CATALOG, type BillingSummary, type PlanId } from "@/domain/billing";
import { accountRequest } from "@/components/workspace/account-api";
import { useAccountSession } from "@/components/workspace/account-session";

/** Settings: the account's plan and remaining credits, with the way to the Plans page. */
export function PlanCreditsCard() {
  const { session } = useAccountSession();
  const userId = session.status === "ready" ? session.userId : null;
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    accountRequest("/api/billing", billingSummaryResponseSchema, { signal: controller.signal }).then(
      ({ billing }) => setSummary(billing),
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [userId]);
  if (!userId) return null;
  const plan = summary ? (PLAN_CATALOG[summary.planId as PlanId]?.name ?? summary.planId) : null;
  return (
    <section className="sg-card" aria-label="Plan and credits">
      <div className="sg-row">
        <div className="sg-row-copy">
          <strong>Plan and credits</strong>
          <p>
            {summary
              ? `${plan} plan · ${Math.max(summary.balance, 0).toLocaleString("en-US")} credits left this month`
              : failed
                ? "Your plan can’t be shown right now."
                : "Checking your plan…"}
          </p>
        </div>
        <Link className="button secondary small" href="/plans">
          See plans
        </Link>
      </div>
    </section>
  );
}
