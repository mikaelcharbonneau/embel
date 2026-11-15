import { describe, expect, it } from "vitest";
import {
  initialPlansMode,
  plansModeReducer,
  plansOpening,
  type PlanAttempt,
  type PlansMode,
  type PlansModeEvent,
} from "@/components/billing/plans-mode";

const pro: PlanAttempt = { plan: "pro", action: "checkout" };
const manage: PlanAttempt = { plan: "pro", action: "portal" };
const run = (events: PlansModeEvent[], from: PlansMode = initialPlansMode(false)) =>
  events.reduce(plansModeReducer, from);
const failed = { type: "open_failed", message: "Checkout couldn’t open.", retry: true, signIn: false } as const;

describe("the Plans page's mode (S8)", () => {
  it("opens one thing at a time: a second press changes nothing", () => {
    const opening = run([{ type: "open_started", attempt: pro }]);
    expect(plansOpening(opening)).toEqual(pro);
    expect(run([{ type: "open_started", attempt: manage }], opening)).toBe(opening);
  });

  it("keeps what failed so Try again repeats it, and a new press replaces the failure", () => {
    const state = run([{ type: "open_started", attempt: manage }, failed]);
    expect(state.request).toEqual({
      kind: "failed",
      attempt: manage,
      message: "Checkout couldn’t open.",
      retry: true,
      signIn: false,
    });
    expect(plansOpening(state)).toBeNull();
    expect(plansOpening(run([{ type: "open_started", attempt: pro }], state))).toEqual(pro);
    // A failure with nothing opening is not recorded.
    expect(run([failed])).toEqual(initialPlansMode(false));
  });

  it("stops opening when the browser restores the page, and leaves everything else alone", () => {
    const opening = run([{ type: "open_started", attempt: pro }], initialPlansMode(true));
    expect(run([{ type: "page_restored" }], opening)).toEqual(initialPlansMode(true));
    const state = run([{ type: "open_started", attempt: pro }, failed]);
    expect(run([{ type: "page_restored" }], state)).toBe(state);
  });

  it("waits after Checkout until the billing summary shows the subscription", () => {
    const waiting = initialPlansMode(true);
    expect(waiting.confirmation).toBe("waiting");
    expect(run([{ type: "billing_read", subscribed: false, checksLeft: true }], waiting)).toBe(waiting);
    expect(run([{ type: "billing_read", subscribed: true, checksLeft: false }], waiting).confirmation).toBe("none");
  });

  it("never ends the wait as paid by running out of checks or failing to read", () => {
    const waiting = initialPlansMode(true);
    const ranOut = run([{ type: "billing_read", subscribed: false, checksLeft: false }], waiting);
    expect(ranOut.confirmation).toBe("unconfirmed");
    expect(run([{ type: "billing_read_failed" }], waiting).confirmation).toBe("unconfirmed");
    expect(run([{ type: "check_again" }], ranOut).confirmation).toBe("waiting");
    expect(run([{ type: "billing_read", subscribed: true, checksLeft: false }], ranOut).confirmation).toBe("none");
  });

  it("does not wait for a payment on an ordinary visit", () => {
    const idle = initialPlansMode(false);
    for (const event of [
      { type: "billing_read", subscribed: false, checksLeft: false },
      { type: "billing_read_failed" },
      { type: "check_again" },
      { type: "page_restored" },
    ] as PlansModeEvent[])
      expect(run([event], idle)).toBe(idle);
  });

  it("keeps waiting for the payment while a plan request opens or fails", () => {
    const state = run([{ type: "open_started", attempt: manage }, failed], initialPlansMode(true));
    expect(state.confirmation).toBe("waiting");
  });

  it("turns a Checkout refused for a payment still being confirmed into that notice, not a failure", () => {
    const refused = run([{ type: "open_started", attempt: pro }, { type: "payment_pending" }]);
    expect(refused).toEqual({ request: { kind: "idle" }, confirmation: "unconfirmed" });
    expect(plansOpening(refused)).toBeNull();
    // Check again looks at the billing summary, and only the summary ends it.
    const checking = run([{ type: "check_again" }], refused);
    expect(checking.confirmation).toBe("waiting");
    expect(run([{ type: "billing_read", subscribed: false, checksLeft: false }], checking).confirmation).toBe(
      "unconfirmed",
    );
    expect(run([{ type: "billing_read", subscribed: true, checksLeft: false }], checking).confirmation).toBe("none");
    // The page is already waiting after a Checkout: it keeps waiting. Nothing opening: nothing changes.
    const waiting = run([{ type: "open_started", attempt: pro }, { type: "payment_pending" }], initialPlansMode(true));
    expect(waiting).toEqual(initialPlansMode(true));
    const idle = initialPlansMode(false);
    expect(run([{ type: "payment_pending" }], idle)).toBe(idle);
  });
});
