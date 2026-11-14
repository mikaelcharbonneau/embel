"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { creditSummaryResponseSchema } from "@/domain/generations";
import { Button, ButtonLink } from "@/components/ui/button";
import { InlineMessage } from "@/components/ui/message";
import { boundedAccountRequest } from "../workspace/bounded-account-request";
import { useAccountSession, type VerifiedAccount } from "../workspace/account-session";

/** When the monthly credits renew, as "December 1" (the period ends at midnight UTC). */
export function creditsRenewDate(periodEnd: string | null) {
  const renews = periodEnd ? new Date(periodEnd) : null;
  return renews && !Number.isNaN(renews.getTime())
    ? renews.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })
    : null;
}

export type CreditBalance = { balance: number | null; periodEnd: string | null; refresh(): void };

/**
 * The account's remaining credits (never money), read when the step opens, when the window regains focus and on
 * `refresh()`. Display only: the server admits or refuses every start, whatever this says.
 */
export function useCreditBalance(account: VerifiedAccount): CreditBalance {
  const { isCurrent } = useAccountSession();
  const [state, setState] = useState<{ userId: string; balance: number; periodEnd: string } | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void boundedAccountRequest("/api/credits", creditSummaryResponseSchema, { signal: controller.signal })
      .then(({ credits }) => {
        if (!controller.signal.aborted && isCurrent(account))
          setState({ userId: account.userId, balance: credits.balance, periodEnd: credits.periodEnd });
      })
      .catch(() => {
        /* Unknown: nothing is marked, and the server still decides. */
      });
    const again = () => setVersion((value) => value + 1);
    window.addEventListener("focus", again);
    return () => {
      controller.abort();
      window.removeEventListener("focus", again);
    };
  }, [account, isCurrent, version]);
  const own = state?.userId === account.userId ? state : null;
  return {
    balance: own?.balance ?? null,
    periodEnd: own?.periodEnd ?? null,
    refresh: () => setVersion((value) => value + 1),
  };
}

/** At 0 credits, marked before the click (D-014): one quiet line at the control, with the way to Plans. */
export function NoCreditsNote({ periodEnd }: { periodEnd: string | null }) {
  const date = creditsRenewDate(periodEnd);
  return (
    <InlineMessage form="field" live={false}>
      You have no credits left this month.{date ? ` New credits arrive on ${date}.` : ""}{" "}
      <Link className="e-link" href="/plans">
        See plans
      </Link>
    </InlineMessage>
  );
}

/** Credits just ran out (D-015): the Out-of-credits message in place, at the control that was pressed. */
export function OutOfCreditsInPlace({ periodEnd, onDismiss }: { periodEnd: string | null; onDismiss: () => void }) {
  const date = creditsRenewDate(periodEnd);
  return (
    <InlineMessage
      actions={
        <>
          <Button variant="quiet" onClick={onDismiss}>
            Not now
          </Button>
          <ButtonLink variant="primary" href="/plans" arrow>
            See plans
          </ButtonLink>
        </>
      }
    >
      You&rsquo;ve used this month&rsquo;s credits.{date ? ` New credits arrive on ${date}.` : ""} Your work is saved.
    </InlineMessage>
  );
}
