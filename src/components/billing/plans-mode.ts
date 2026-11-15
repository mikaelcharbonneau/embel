import type { PlanId } from "@/domain/billing";

/** The Plans page's mode (docs/state-machines.md, S8). The billing summary itself is content, not mode. */

export type PlanChoice = "checkout" | "portal" | "cancel";
export type PlanAttempt = { plan: PlanId; action: PlanChoice };

/** The one request the page sends: open Stripe Checkout, or the plan settings (portal, also for Cancel). */
export type PlansRequest =
  | { kind: "idle" }
  /** The link is being fetched, or the browser is on its way to Stripe. Every plan button waits. */
  | { kind: "opening"; attempt: PlanAttempt }
  | { kind: "failed"; attempt: PlanAttempt; message: string; retry: boolean; signIn: boolean };

/** A payment the billing summary does not show yet: after returning from a finished Checkout, or after a
 * new Checkout was refused because an earlier payment is still being confirmed. */
export type PlansConfirmation =
  | "none"
  /** Looking for the subscription (every 2 seconds after a Checkout, once after Check again). */
  | "waiting"
  /** Looked for 30 seconds, could not look, or the server said so: the payment is still being confirmed.
   * Offers Check again. */
  | "unconfirmed";

export type PlansMode = { request: PlansRequest; confirmation: PlansConfirmation };

export type PlansModeEvent =
  | { type: "open_started"; attempt: PlanAttempt }
  | { type: "open_failed"; message: string; retry: boolean; signIn: boolean }
  /** Checkout did not open because an earlier payment is still being confirmed. Nothing failed and nothing was
   * charged twice: the page shows the still-being-confirmed notice instead of an error. */
  | { type: "payment_pending" }
  /** The browser brought the page back as it was left (Back from Stripe): nothing is opening any more. */
  | { type: "page_restored" }
  /** The billing summary answered. `checksLeft`: the page will look again by itself. */
  | { type: "billing_read"; subscribed: boolean; checksLeft: boolean }
  | { type: "billing_read_failed" }
  /** "Check again" on the still-being-confirmed notice. */
  | { type: "check_again" };

const idle: PlansRequest = { kind: "idle" };

export function initialPlansMode(returnedFromCheckout: boolean): PlansMode {
  return { request: idle, confirmation: returnedFromCheckout ? "waiting" : "none" };
}

/** Returns the same object when nothing changes: a second press while a request is opening changes
 * nothing, which is how the page knows to ignore it. */
export function plansModeReducer(state: PlansMode, event: PlansModeEvent): PlansMode {
  switch (event.type) {
    case "open_started":
      return state.request.kind === "opening"
        ? state
        : { ...state, request: { kind: "opening", attempt: event.attempt } };
    case "open_failed":
      return state.request.kind === "opening"
        ? {
            ...state,
            request: {
              kind: "failed",
              attempt: state.request.attempt,
              message: event.message,
              retry: event.retry,
              signIn: event.signIn,
            },
          }
        : state;
    case "payment_pending":
      return state.request.kind === "opening"
        ? { request: idle, confirmation: state.confirmation === "waiting" ? "waiting" : "unconfirmed" }
        : state;
    case "page_restored":
      return state.request.kind === "opening" ? { ...state, request: idle } : state;
    case "billing_read": {
      if (state.confirmation === "none") return state;
      // Only the billing summary may end the wait as paid. Running out of checks is not an answer.
      const confirmation = event.subscribed ? "none" : event.checksLeft ? "waiting" : "unconfirmed";
      return confirmation === state.confirmation ? state : { ...state, confirmation };
    }
    case "billing_read_failed":
      return state.confirmation === "waiting" ? { ...state, confirmation: "unconfirmed" } : state;
    case "check_again":
      return state.confirmation === "unconfirmed" ? { ...state, confirmation: "waiting" } : state;
  }
}

/** The request under way, for the buttons: the one that was pressed shows activity, the others wait. */
export function plansOpening(mode: PlansMode): PlanAttempt | null {
  return mode.request.kind === "opening" ? mode.request.attempt : null;
}
