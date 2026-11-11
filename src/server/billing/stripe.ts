import "server-only";
import Stripe from "stripe";
import { getStripeSecretKey } from "../config";

/** Pinned explicitly: Managed Payments needs 2025-03-31.basil or later, and this is the
 * version stripe@23.0.1 is typed for. Changing it is a reviewed upgrade, not a side effect
 * of a package update. */
export const STRIPE_API_VERSION = "2026-09-30.endive" as const;

export type StripeClient = Stripe;

/** The server's Stripe client. Built per request from the secret key, which never leaves the
 * server ("server-only"); requests retry network failures with Stripe's idempotency keys. */
export function stripeClient(env: Record<string, string | undefined> = process.env): StripeClient {
  return new Stripe(getStripeSecretKey(env), {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: "Embel" },
  });
}
