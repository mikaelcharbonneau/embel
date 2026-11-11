import "server-only";
import { accountAdminClient } from "../account/admin";
import { getApplicationOrigin } from "../config";
import type { BillingDependencies } from "./sessions";
import { supabaseBillingStore } from "./store";
import { stripeClient } from "./stripe";

/** Stripe, the billing records (service role) and the site's own origin for return URLs. */
export function billingDependencies(): BillingDependencies {
  return { stripe: stripeClient(), store: supabaseBillingStore(accountAdminClient()), origin: getApplicationOrigin() };
}
