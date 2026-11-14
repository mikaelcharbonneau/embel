"use client";

import { useEffect, useState } from "react";
import { billingSummaryResponseSchema, PLAN_CATALOG, type BillingSummary, type PlanId } from "@/domain/billing";
import { accountRequest } from "@/components/workspace/account-api";
import { useAccountSession } from "@/components/workspace/account-session";
import { creditsRenewDate } from "@/components/workspace/credits-message";

export type BillingState =
  { status: "signed_out" | "loading" | "failed"; summary: null } | { status: "ready"; summary: BillingSummary };

/**
 * The signed-in person's plan and credit balance, read once per account (and again when `refreshKey` changes).
 * Credits only, never money.
 */
export function useBillingSummary(refreshKey = 0): BillingState {
  const { session } = useAccountSession();
  const userId = session.status === "ready" ? session.userId : null;
  const [loaded, setLoaded] = useState<{ key: string; state: BillingState } | null>(null);
  const key = `${userId}:${refreshKey}`;
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    accountRequest("/api/billing", billingSummaryResponseSchema, { signal: controller.signal }).then(
      ({ billing }) => setLoaded({ key, state: { status: "ready", summary: billing } }),
      () => {
        if (!controller.signal.aborted) setLoaded({ key, state: { status: "failed", summary: null } });
      },
    );
    return () => controller.abort();
  }, [userId, key]);
  if (!userId) return { status: session.status === "checking" ? "loading" : "signed_out", summary: null };
  return loaded?.key === key ? loaded.state : { status: "loading", summary: null };
}

export const planName = (summary: BillingSummary) => PLAN_CATALOG[summary.planId as PlanId]?.name ?? summary.planId;

export const creditsLeft = (summary: BillingSummary) => Math.max(summary.balance, 0);

/** "December 1": when the next monthly credits arrive, the same day Plans and the out-of-credits message name. */
export function nextCreditsDate(summary: BillingSummary) {
  return creditsRenewDate(summary.periodEnd);
}
