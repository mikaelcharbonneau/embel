import { accountAdminClient } from "@/server/account/admin";
import { supabaseBillingStore } from "@/server/billing/store";
import { stripeClient } from "@/server/billing/stripe";
import { handleStripeWebhook } from "@/server/billing/webhook-endpoint";

export const dynamic = "force-dynamic";

/** Stripe webhook (docs/payments.md). No session or origin check: Stripe calls it, and the
 * signature over the raw body is the authentication. */
export async function POST(request: Request) {
  return handleStripeWebhook(request, () => ({
    stripe: stripeClient(),
    store: supabaseBillingStore(accountAdminClient()),
  }));
}
