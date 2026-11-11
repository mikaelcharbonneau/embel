import "server-only";
import type Stripe from "stripe";
import { PLAN_CATALOG, type PaidPlanId } from "@/domain/billing";
import { ApiError } from "../http/errors";
import type { BillingStore } from "./store";
import type { StripeClient } from "./stripe";

export type BillingDependencies = { stripe: StripeClient; store: BillingStore; origin: string };

/** The active monthly price of a plan, found by its lookup key (scripts/stripe/ensure-products.mjs). */
export async function priceForPlan(stripe: StripeClient, plan: PaidPlanId): Promise<Stripe.Price> {
  const lookupKey = PLAN_CATALOG[plan].lookupKey!;
  const prices = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  const price = prices.data[0];
  if (!price || price.lookup_key !== lookupKey || price.recurring?.interval !== "month") {
    throw new ApiError("integration_unavailable");
  }
  return price;
}

/** The account's Stripe customer, created once. The Stripe idempotency key makes two
 * simultaneous first checkouts create the same customer; the database keeps the first. */
export async function customerForOwner(
  { stripe, store }: BillingDependencies,
  owner: { id: string; email: string | null },
  existing: string | null,
): Promise<string> {
  if (existing) return existing;
  const customer = await stripe.customers.create(
    { ...(owner.email ? { email: owner.email } : {}), metadata: { embel_owner_id: owner.id } },
    { idempotencyKey: `embel-customer-${owner.id}` },
  );
  return store.linkCustomer(owner.id, customer.id);
}

function checkedUrl(url: string | null | undefined): string {
  if (!url) throw new ApiError("integration_unavailable");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new ApiError("integration_unavailable");
  return parsed.href;
}

/**
 * A Stripe-hosted Checkout page for a paid plan, with Managed Payments on (Stripe is the
 * merchant of record and handles tax). One click on the Plans page starts it. Parameters that
 * Managed Payments controls itself (automatic_tax, payment_method_types, customer_update,
 * tax_id_collection, invoice_creation and the like) are deliberately absent.
 */
export async function startCheckout(
  deps: BillingDependencies,
  owner: { id: string; email: string | null },
  plan: PaidPlanId,
): Promise<string> {
  const state = await deps.store.ownerState(owner.id);
  // One subscription per account: plan changes and cancellation go through Manage.
  if (state.subscription?.live) throw new ApiError("billing_active");
  const [customer, price] = await Promise.all([
    customerForOwner(deps, owner, state.customerId),
    priceForPlan(deps.stripe, plan),
  ]);
  const metadata = { embel_owner_id: owner.id, embel_plan: plan };
  const session = await deps.stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: owner.id,
    line_items: [{ price: price.id, quantity: 1 }],
    managed_payments: { enabled: true },
    metadata,
    subscription_data: { metadata },
    success_url: `${deps.origin}/plans?checkout=success`,
    cancel_url: `${deps.origin}/plans?checkout=cancelled`,
  });
  return checkedUrl(session.url);
}

/**
 * The Stripe customer portal: cancel at period end, switch between Pro and Studio, update the
 * payment method and see invoices (Managed Payments supports the portal; customers can also
 * manage the same subscription from Link). With `plan`, it opens straight on the confirmation
 * of that plan change.
 */
export async function startPortal(deps: BillingDependencies, ownerId: string, plan?: PaidPlanId): Promise<string> {
  const state = await deps.store.ownerState(ownerId);
  if (!state.customerId) throw new ApiError("not_found");
  const returnUrl = `${deps.origin}/plans`;
  let flow: Stripe.BillingPortal.SessionCreateParams.FlowData | undefined;
  const subscription = state.subscription;
  if (plan && subscription?.live && subscription.planId !== plan) {
    const [current, price] = await Promise.all([
      deps.stripe.subscriptions.retrieve(subscription.id),
      priceForPlan(deps.stripe, plan),
    ]);
    const item = current.items.data[0];
    if (!item || current.items.data.length !== 1) throw new ApiError("conflict");
    flow = {
      type: "subscription_update_confirm",
      subscription_update_confirm: { subscription: current.id, items: [{ id: item.id, price: price.id, quantity: 1 }] },
      after_completion: { type: "redirect", redirect: { return_url: `${returnUrl}?portal=updated` } },
    };
  }
  const session = await deps.stripe.billingPortal.sessions.create({
    customer: state.customerId,
    return_url: returnUrl,
    ...(flow ? { flow_data: flow } : {}),
  });
  return checkedUrl(session.url);
}
