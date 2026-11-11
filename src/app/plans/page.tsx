import type { Metadata } from "next";
import { PlansWorkspace, type PlansReturnState } from "@/components/billing/plans-workspace";

export const metadata: Metadata = { title: "Plans" };

/** Stripe returns here from Checkout (?checkout=success|cancelled) and from a plan change
 * in the customer portal (?portal=updated). Nothing else in the address is read. */
export default async function PlansPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const returnState: PlansReturnState =
    params.checkout === "success"
      ? "checkout_success"
      : params.checkout === "cancelled"
        ? "checkout_cancelled"
        : params.portal === "updated"
          ? "portal_updated"
          : null;
  return <PlansWorkspace returnState={returnState} />;
}
