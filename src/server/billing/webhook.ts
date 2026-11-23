import "server-only";
import type Stripe from "stripe";
import { z } from "zod";
import { planForLookupKey, type PaidPlanId } from "@/domain/billing";
import { logServerError } from "../http/errors";
import type { BillingStore } from "./store";
import type { StripeClient } from "./stripe";

/** The events the webhook endpoint subscribes to (docs/payments.md). Anything else is acknowledged and ignored. */
export const HANDLED_STRIPE_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
  // A switch to a smaller plan waits for the renewal in a subscription schedule.
  "subscription_schedule.created",
  "subscription_schedule.updated",
  "subscription_schedule.released",
  "subscription_schedule.canceled",
] as const;

const STATUSES = new Set([
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
]);

/** The statuses of a subscription that still pays for its plan (billing_subscription_live). */
const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

/** A retryable failure: the endpoint answers 500 and Stripe sends the event again later. */
export class RetryableBillingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RetryableBillingError";
  }
}

const idOf = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : (value?.id ?? null);
const fromSeconds = (seconds: number) => new Date(seconds * 1000);
const ownerIdSchema = z.uuid();

type Synced = { ownerId: string; subscription: Stripe.Subscription; planId: PaidPlanId; live: boolean };

/**
 * Reads the subscription from Stripe and saves its state. Never uses the event payload's copy.
 * A subscription of one of our customers whose account no longer exists (deleted while the
 * subscription was still being set up, or a cancellation that failed during deletion) is
 * cancelled so nobody keeps paying for a deleted account.
 */
export async function syncSubscription(
  stripe: StripeClient,
  store: BillingStore,
  subscriptionId: string,
  now: () => Date = () => new Date(),
): Promise<Synced | null> {
  // Taken before the read: the saved state is then at least as new as its time says, so a read
  // that was slow to come back can never overwrite one that started after it
  // (billing_apply_subscription keeps the row with the later stripe_synced_at).
  const syncedAt = now();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const customerId = idOf(subscription.customer);
  if (!customerId) return null;
  const ownerId = await store.ownerForCustomer(customerId);
  if (!ownerId) {
    await cancelOrphan(stripe, subscription, customerId);
    return null;
  }
  const item = subscription.items.data[0];
  const planId = subscription.items.data.length === 1 ? planForLookupKey(item?.price.lookup_key) : null;
  if (!item || !planId) {
    logServerError("billing_unknown_price", new Error("unknown_price"), { subscription: subscription.id });
    return null;
  }
  if (!STATUSES.has(subscription.status)) throw new RetryableBillingError("unknown_subscription_status");
  const periodEnd = item.current_period_end;
  // The customer portal may cancel at the period end with cancel_at instead of the flag.
  const cancelAtPeriodEnd =
    subscription.cancel_at_period_end || (subscription.cancel_at !== null && subscription.cancel_at <= periodEnd);
  const pendingPlanId = await scheduledPlan(stripe, subscription, planId, periodEnd);
  const { live, planLowered } = await store.applySubscription({
    ownerId,
    subscriptionId: subscription.id,
    customerId,
    planId,
    status: subscription.status,
    periodStart: fromSeconds(item.current_period_start),
    periodEnd: fromSeconds(periodEnd),
    cancelAtPeriodEnd,
    pendingPlanId,
    syncedAt,
  });
  if (planLowered) {
    // The portal schedules a switch to a smaller plan for the renewal (scripts/stripe/ensure-products.mjs).
    // One applied at once means Stripe gave money back for the unused time while the larger plan's
    // credits stayed: the portal configuration is not the one this app sets up, or someone changed
    // the subscription by hand.
    logServerError("billing_plan_lowered_mid_period", new Error("plan_lowered_mid_period"), {
      subscription: subscription.id,
    });
  }
  if (live) await flagSecondLiveSubscription(store, ownerId, subscription.id);
  return { ownerId, subscription, planId, live };
}

/**
 * The plan the subscription changes to at its next renewal, or null. The customer portal holds
 * a scheduled switch to a smaller plan in a subscription schedule: the phase that starts when
 * the paid period ends carries the next price. A schedule this app does not understand (several
 * items, an unknown price) reads as nothing scheduled; a failed read is retried with the event.
 */
async function scheduledPlan(
  stripe: StripeClient,
  subscription: Stripe.Subscription,
  planId: PaidPlanId,
  periodEnd: number,
): Promise<PaidPlanId | null> {
  const scheduleId = idOf(subscription.schedule);
  if (!scheduleId || !LIVE_STATUSES.has(subscription.status)) return null;
  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId, { expand: ["phases.items.price"] });
  if (schedule.status !== "active" && schedule.status !== "not_started") return null;
  const next = schedule.phases.find((phase) => phase.start_date >= periodEnd);
  if (!next || next.items.length !== 1) return null;
  const price = next.items[0]!.price;
  const pending = typeof price === "string" ? null : planForLookupKey("lookup_key" in price ? price.lookup_key : null);
  return pending && pending !== planId ? pending : null;
}

/** One account, one paid plan. Two live subscriptions mean the person pays twice (credits are
 * not doubled): this logs it so it shows in the error report. Nothing is cancelled or refunded
 * here, and a failed count never stops the event from being applied. */
async function flagSecondLiveSubscription(store: BillingStore, ownerId: string, subscriptionId: string) {
  try {
    const count = await store.liveSubscriptionCount(ownerId);
    if (count > 1) {
      logServerError("billing_second_live_subscription", new Error("second_live_subscription"), {
        subscription: subscriptionId,
        live: String(count),
      });
    }
  } catch (error) {
    logServerError("billing_live_subscription_count_failed", error, { subscription: subscriptionId });
  }
}

async function cancelOrphan(stripe: StripeClient, subscription: Stripe.Subscription, customerId: string) {
  if (["canceled", "incomplete_expired"].includes(subscription.status)) return;
  const customer = await stripe.customers.retrieve(customerId);
  const ours = "metadata" in customer && ownerIdSchema.safeParse(customer.metadata?.embel_owner_id).success;
  if (!ours) return; // Not an Embel customer: leave it alone.
  await stripe.subscriptions.cancel(subscription.id);
  logServerError("billing_orphan_subscription_cancelled", new Error("orphan_subscription"), {
    subscription: subscription.id,
  });
}

/** Applies one verified event. Safe to repeat: every database call is idempotent. */
export async function processStripeEvent(
  event: Stripe.Event,
  deps: { stripe: StripeClient; store: BillingStore; now?: () => Date },
): Promise<"applied" | "ignored"> {
  const { stripe, store } = deps;
  switch (event.type) {
    case "checkout.session.completed": {
      const session = await stripe.checkout.sessions.retrieve(event.data.object.id);
      const subscriptionId = session.mode === "subscription" ? idOf(session.subscription) : null;
      if (!subscriptionId) return "ignored";
      return (await syncSubscription(stripe, store, subscriptionId, deps.now)) ? "applied" : "ignored";
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      return (await syncSubscription(stripe, store, event.data.object.id, deps.now)) ? "applied" : "ignored";
    case "subscription_schedule.created":
    case "subscription_schedule.updated":
    case "subscription_schedule.released":
    case "subscription_schedule.canceled": {
      const schedule = event.data.object;
      const subscriptionId = idOf(schedule.subscription) ?? idOf(schedule.released_subscription);
      if (!subscriptionId) return "ignored";
      return (await syncSubscription(stripe, store, subscriptionId, deps.now)) ? "applied" : "ignored";
    }
    case "invoice.payment_failed": {
      const invoice = await stripe.invoices.retrieve(event.data.object.id!);
      const subscriptionId = idOf(invoice.parent?.subscription_details?.subscription);
      if (!subscriptionId) return "ignored";
      return (await syncSubscription(stripe, store, subscriptionId, deps.now)) ? "applied" : "ignored";
    }
    case "invoice.paid": {
      const invoice = await stripe.invoices.retrieve(event.data.object.id!);
      const subscriptionId = idOf(invoice.parent?.subscription_details?.subscription);
      if (invoice.status !== "paid" || !invoice.id || !subscriptionId) return "ignored";
      const synced = await syncSubscription(stripe, store, subscriptionId, deps.now);
      if (!synced) return "ignored";
      if (!synced.live) {
        // Still finishing its first payment: try again later. An ended one grants nothing.
        if (synced.subscription.status === "incomplete") throw new RetryableBillingError("subscription_not_live");
        return "ignored";
      }
      const item = synced.subscription.items.data[0]!;
      await store.applyInvoice({
        ownerId: synced.ownerId,
        invoiceId: invoice.id,
        subscriptionId,
        planId: synced.planId,
        periodStart: fromSeconds(item.current_period_start),
        periodEnd: fromSeconds(item.current_period_end),
      });
      return "applied";
    }
    default:
      return "ignored";
  }
}
