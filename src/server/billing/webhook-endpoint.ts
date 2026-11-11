import "server-only";
import Stripe from "stripe";
import { getStripeWebhookSecret } from "../config";
import { ApiError, errorResponse, logServerError, privateJson } from "../http/errors";
import { readBoundedBytes } from "../http/request";
import type { BillingStore } from "./store";
import type { StripeClient } from "./stripe";
import { processStripeEvent } from "./webhook";

/** Stripe's events are a few kilobytes; anything near this is not one of them. */
const MAX_EVENT_BYTES = 512 * 1024;

/**
 * The Stripe webhook endpoint's work. The signature is checked over the exact raw body with
 * STRIPE_WEBHOOK_SECRET before anything else; the event only says what changed, and the
 * handler re-reads the subscription and invoice from Stripe. Each event id is processed
 * once. A failure answers 500 so Stripe retries (every step is idempotent).
 */
export async function handleStripeWebhook(
  request: Request,
  dependencies: () => { stripe: StripeClient; store: BillingStore },
): Promise<Response> {
  let event: Stripe.Event;
  try {
    const secret = getStripeWebhookSecret();
    const signature = request.headers.get("stripe-signature");
    if (!signature || signature.length > 4096) throw new ApiError("invalid_signature");
    const body = await readBoundedBytes(request, MAX_EVENT_BYTES);
    try {
      event = await Stripe.webhooks.constructEventAsync(body, signature, secret);
    } catch {
      throw new ApiError("invalid_signature");
    }
  } catch (error) {
    return errorResponse(error);
  }
  try {
    const { stripe, store } = dependencies();
    if (await store.eventSeen(event.id)) return privateJson({ received: true });
    await processStripeEvent(event, { stripe, store });
    await store.recordEvent(event.id, event.type);
    return privateJson({ received: true });
  } catch (error) {
    logServerError("stripe_webhook_failed", error, { type: event.type.slice(0, 60) });
    return privateJson({ error: { code: "retry" } }, 500);
  }
}
