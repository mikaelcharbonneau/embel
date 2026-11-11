import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logServerError } from "../http/errors";
import { supabaseBillingStore } from "./store";
import { stripeClient, type StripeClient } from "./stripe";

const ENDED = new Set(["canceled", "incomplete_expired"]);

/**
 * Before an account is deleted: cancels its Stripe subscriptions at once, so nobody keeps
 * paying for a deleted account. Best effort and logged: a failure never stops the deletion,
 * and the webhook cancels any subscription whose account is gone (webhook.ts, cancelOrphan).
 * The Stripe customer and its invoices stay with Stripe, the merchant of record.
 */
export async function cancelSubscriptionsForDeletion(
  admin: SupabaseClient,
  ownerId: string,
  makeStripe: () => StripeClient = () => stripeClient(),
): Promise<number> {
  try {
    const { customerId } = await supabaseBillingStore(admin).ownerState(ownerId);
    if (!customerId) return 0;
    const stripe = makeStripe();
    const subscriptions = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
    let cancelled = 0;
    for (const subscription of subscriptions.data) {
      if (ENDED.has(subscription.status)) continue;
      await stripe.subscriptions.cancel(subscription.id);
      cancelled += 1;
    }
    return cancelled;
  } catch (error) {
    logServerError("account_deletion_billing_cancel", error);
    return 0;
  }
}
