import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import Stripe from "stripe";
import { syncSubscription } from "@/server/billing/webhook";
import { handleStripeWebhook } from "@/server/billing/webhook-endpoint";
import type { BillingStore } from "@/server/billing/store";
import type { StripeClient } from "@/server/billing/stripe";

// Obvious fakes only: a made-up signing secret, synthetic ids, no network.
const SECRET = "whsec_FakeSigningSecretForTests";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const START = 1_800_000_000;
const END = START + 30 * 24 * 3600;

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_A",
    customer: "cus_A",
    status: "active",
    cancel_at_period_end: false,
    cancel_at: null,
    items: {
      data: [
        {
          id: "si_A",
          current_period_start: START,
          current_period_end: END,
          price: { id: "price_pro", lookup_key: "embel_pro_monthly" },
        },
      ],
    },
    ...overrides,
  };
}

function fakeStripe(sub = subscription()) {
  return {
    subscriptions: { retrieve: vi.fn(async () => sub), cancel: vi.fn(async () => ({})) },
    invoices: {
      retrieve: vi.fn(async (id: string) => ({
        id,
        status: "paid",
        parent: { subscription_details: { subscription: "sub_A" } },
      })),
    },
    checkout: {
      sessions: { retrieve: vi.fn(async (id: string) => ({ id, mode: "subscription", subscription: "sub_A" })) },
    },
    customers: {
      retrieve: vi.fn(async () => ({ id: "cus_A", metadata: { embel_owner_id: A } as Record<string, string> })),
    },
  };
}
function fakeStore(): { [K in keyof BillingStore]: ReturnType<typeof vi.fn> } {
  return {
    ownerState: vi.fn(),
    linkCustomer: vi.fn(),
    ownerForCustomer: vi.fn(async () => A),
    eventSeen: vi.fn(async () => false),
    recordEvent: vi.fn(async () => undefined),
    applySubscription: vi.fn(async (state: { status: string; cancelAtPeriodEnd: boolean }) => ({
      live: ["active", "trialing", "past_due"].includes(state.status),
    })),
    applyInvoice: vi.fn(async () => undefined),
    claimCheckout: vi.fn(),
    releaseCheckout: vi.fn(),
    liveSubscriptionCount: vi.fn(async () => 1),
  };
}

let stripe: ReturnType<typeof fakeStripe>;
let store: ReturnType<typeof fakeStore>;
const deps = () => ({ stripe: stripe as unknown as StripeClient, store: store as unknown as BillingStore });

function event(type: string, object: Record<string, unknown>, id = "evt_One") {
  return JSON.stringify({ id, object: "event", type, api_version: "2026-09-30.endive", data: { object } });
}
async function deliver(payload: string, signature?: string | null) {
  const header =
    signature === undefined
      ? await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: SECRET })
      : signature;
  return handleStripeWebhook(
    new Request("http://localhost:3105/api/billing/stripe-webhook", {
      method: "POST",
      headers: { "content-type": "application/json", ...(header ? { "stripe-signature": header } : {}) },
      body: payload,
    }),
    deps,
  );
}

beforeEach(() => {
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
  stripe = fakeStripe();
  store = fakeStore();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("signature", () => {
  it("rejects a missing, wrong or tampered signature before reading anything", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const payload = event("invoice.paid", { id: "in_1" });
    expect((await deliver(payload, null)).status).toBe(400);
    expect((await deliver(payload, "t=1,v1=deadbeef")).status).toBe(400);
    const otherSecret = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: "whsec_SomeoneElse" });
    expect((await deliver(payload, otherSecret)).status).toBe(400);
    const signed = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: SECRET });
    expect((await deliver(payload.replace("in_1", "in_2"), signed)).status).toBe(400);
    expect(store.eventSeen).not.toHaveBeenCalled();
    expect(stripe.invoices.retrieve).not.toHaveBeenCalled();
  });

  it("logs a signed delivery that does not verify (a wrong signing secret), and not an unsigned request", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const payload = event("invoice.paid", { id: "in_1" });
    expect((await deliver(payload, null)).status).toBe(400);
    expect(logged).not.toHaveBeenCalled();
    const otherSecret = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: "whsec_SomeoneElse" });
    expect((await deliver(payload, otherSecret)).status).toBe(400);
    expect(JSON.stringify(logged.mock.calls)).toContain("stripe_webhook_signature_rejected");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("whsec_");
  });

  it("answers 503 (Stripe retries) while the signing secret is not configured", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    expect((await deliver(event("invoice.paid", { id: "in_1" }))).status).toBe(503);
    expect(store.eventSeen).not.toHaveBeenCalled();
  });
});

describe("the time of a Stripe read", () => {
  it("is taken before the read, so a slow older read never looks newer than a later one", async () => {
    stripe = fakeStripe();
    store = fakeStore();
    let clock = 1_000;
    // The read takes five seconds; another event's read could start and finish meanwhile.
    stripe.subscriptions.retrieve.mockImplementationOnce(async () => {
      clock += 5_000;
      return subscription();
    });
    await syncSubscription(
      stripe as unknown as StripeClient,
      store as unknown as BillingStore,
      "sub_A",
      () => new Date(clock),
    );
    expect(store.applySubscription.mock.calls[0]![0]).toMatchObject({ syncedAt: new Date(1_000) });
  });
});

describe("two live subscriptions on one account", () => {
  const sync = () => syncSubscription(stripe as unknown as StripeClient, store as unknown as BillingStore, "sub_A");
  it("logs it, saves what Stripe reports all the same, and stays quiet for one", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await sync()).toMatchObject({ live: true });
      expect(logged).not.toHaveBeenCalled();
      store.liveSubscriptionCount.mockResolvedValueOnce(2);
      expect(await sync()).toMatchObject({ live: true });
      expect(store.applySubscription).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(logged.mock.calls)).toContain("billing_second_live_subscription");
      // A count that cannot be read never stops the event.
      store.liveSubscriptionCount.mockRejectedValueOnce(new Error("database"));
      expect(await sync()).toMatchObject({ live: true });
    } finally {
      logged.mockRestore();
    }
  });
});

describe("a switch to a smaller plan that waits for the renewal", () => {
  const sync = () => syncSubscription(stripe as unknown as StripeClient, store as unknown as BillingStore, "sub_A");
  const studio = () =>
    subscription({
      schedule: "sub_sched_A",
      items: {
        data: [
          {
            id: "si_A",
            current_period_start: START,
            current_period_end: END,
            price: { id: "price_studio", lookup_key: "embel_studio_monthly" },
          },
        ],
      },
    });
  const schedule = (overrides: Record<string, unknown> = {}) => ({
    id: "sub_sched_A",
    status: "active",
    phases: [
      {
        start_date: START,
        end_date: END,
        items: [{ price: { id: "price_studio", lookup_key: "embel_studio_monthly" } }],
      },
      {
        start_date: END,
        end_date: END + 30 * 24 * 3600,
        items: [{ price: { id: "price_pro", lookup_key: "embel_pro_monthly" } }],
      },
    ],
    ...overrides,
  });
  function withSchedule(value: ReturnType<typeof schedule>) {
    const retrieve = vi.fn(async () => value);
    stripe = Object.assign(fakeStripe(studio()), { subscriptionSchedules: { retrieve } });
    return retrieve;
  }

  it("saves the plan of the phase that starts when the paid period ends", async () => {
    const retrieve = withSchedule(schedule());
    await sync();
    expect(retrieve).toHaveBeenCalledWith("sub_sched_A", { expand: ["phases.items.price"] });
    expect(store.applySubscription).toHaveBeenLastCalledWith(
      expect.objectContaining({ planId: "studio", pendingPlanId: "pro" }),
    );
  });

  it("saves nothing pending without a schedule, for the same plan, or for a schedule it cannot read as one plan", async () => {
    await sync();
    expect(store.applySubscription).toHaveBeenLastCalledWith(expect.objectContaining({ pendingPlanId: null }));
    const same = schedule();
    same.phases[1]!.items = [{ price: { id: "price_studio", lookup_key: "embel_studio_monthly" } }];
    withSchedule(same);
    await sync();
    expect(store.applySubscription).toHaveBeenLastCalledWith(expect.objectContaining({ pendingPlanId: null }));
    for (const odd of [
      schedule({ status: "released" }),
      schedule({ phases: [schedule().phases[0]] }),
      schedule({ phases: [schedule().phases[0], { start_date: END, items: [{ price: "price_pro" }] }] }),
      schedule({ phases: [schedule().phases[0], { start_date: END, items: [{ price: { lookup_key: "other" } }] }] }),
    ]) {
      withSchedule(odd as ReturnType<typeof schedule>);
      await sync();
      expect(store.applySubscription).toHaveBeenLastCalledWith(expect.objectContaining({ pendingPlanId: null }));
    }
  });

  it("follows a schedule event to its subscription", async () => {
    withSchedule(schedule());
    const payload = event("subscription_schedule.updated", { id: "sub_sched_A", subscription: "sub_A" });
    expect((await deliver(payload)).status).toBe(200);
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_A");
    expect(store.applySubscription).toHaveBeenLastCalledWith(expect.objectContaining({ pendingPlanId: "pro" }));
    const released = event(
      "subscription_schedule.released",
      { id: "sub_sched_A", subscription: null, released_subscription: "sub_A" },
      "evt_Released",
    );
    stripe = fakeStripe();
    expect((await deliver(released)).status).toBe(200);
    expect(store.applySubscription).toHaveBeenLastCalledWith(
      expect.objectContaining({ planId: "pro", pendingPlanId: null }),
    );
  });

  it("answers 500 when the schedule cannot be read, so Stripe sends the event again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    withSchedule(schedule()).mockRejectedValueOnce(new Error("stripe"));
    expect((await deliver(event("customer.subscription.updated", { id: "sub_A" }))).status).toBe(500);
    expect(store.applySubscription).not.toHaveBeenCalled();
    expect(store.recordEvent).not.toHaveBeenCalled();
  });

  it("logs a plan that dropped inside a paid period, and saves it all the same", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await sync();
    expect(logged).not.toHaveBeenCalled();
    store.applySubscription.mockResolvedValueOnce({ live: true, planLowered: true });
    expect(await sync()).toMatchObject({ live: true, planId: "pro" });
    expect(JSON.stringify(logged.mock.calls)).toContain("billing_plan_lowered_mid_period");
  });
});

describe("events", () => {
  it("grants credits for a paid invoice from what Stripe reports, never from the payload", async () => {
    const payload = event("invoice.paid", {
      id: "in_1",
      amount_paid: 999_999,
      parent: { subscription_details: { subscription: "sub_Forged" } },
      lines: { data: [{ price: { lookup_key: "embel_studio_monthly" } }] },
    });
    const response = await deliver(payload);
    expect(response.status).toBe(200);
    expect(stripe.invoices.retrieve).toHaveBeenCalledWith("in_1");
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_A");
    expect(store.applySubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: A,
        subscriptionId: "sub_A",
        customerId: "cus_A",
        planId: "pro",
        status: "active",
        periodStart: new Date(START * 1000),
        periodEnd: new Date(END * 1000),
        cancelAtPeriodEnd: false,
      }),
    );
    expect(store.applyInvoice).toHaveBeenCalledWith({
      ownerId: A,
      invoiceId: "in_1",
      subscriptionId: "sub_A",
      planId: "pro",
      periodStart: new Date(START * 1000),
      periodEnd: new Date(END * 1000),
    });
    expect(store.recordEvent).toHaveBeenCalledWith("evt_One", "invoice.paid");
  });

  it("acknowledges a replayed event without applying it again", async () => {
    store.eventSeen.mockResolvedValue(true);
    expect((await deliver(event("invoice.paid", { id: "in_1" }))).status).toBe(200);
    expect(stripe.invoices.retrieve).not.toHaveBeenCalled();
    expect(store.applyInvoice).not.toHaveBeenCalled();
  });

  it("answers 500 and records nothing when applying fails, so Stripe retries", async () => {
    store.applyInvoice.mockRejectedValueOnce(Object.assign(new Error("PRIVATE DETAIL"), { code: "55000" }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await deliver(event("invoice.paid", { id: "in_1" }));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("PRIVATE");
    expect(store.recordEvent).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join(" ")).not.toContain("PRIVATE");
  });

  it("retries an invoice whose subscription is still finishing its first payment", async () => {
    stripe = fakeStripe(subscription({ status: "incomplete" }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await deliver(event("invoice.paid", { id: "in_1" }))).status).toBe(500);
    expect(store.applyInvoice).not.toHaveBeenCalled();
  });

  it("saves subscription changes, including a cancellation at the period end and the end itself", async () => {
    stripe = fakeStripe(subscription({ cancel_at: END }));
    expect((await deliver(event("customer.subscription.updated", { id: "sub_A" }))).status).toBe(200);
    expect(store.applySubscription).toHaveBeenLastCalledWith(expect.objectContaining({ cancelAtPeriodEnd: true }));
    stripe = fakeStripe(subscription({ status: "canceled", cancel_at_period_end: true }));
    expect((await deliver(event("customer.subscription.deleted", { id: "sub_A" }, "evt_Two"))).status).toBe(200);
    expect(store.applySubscription).toHaveBeenLastCalledWith(expect.objectContaining({ status: "canceled" }));
    expect(store.applyInvoice).not.toHaveBeenCalled();
  });

  it("follows a completed checkout to its subscription", async () => {
    expect(
      (await deliver(event("checkout.session.completed", { id: "cs_1", subscription: "sub_Forged" }))).status,
    ).toBe(200);
    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledWith("cs_1");
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_A");
    expect(store.applySubscription).toHaveBeenCalled();
  });

  it("cancels the subscription of a deleted account, and leaves other customers alone", async () => {
    store.ownerForCustomer.mockResolvedValue(null);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await deliver(event("customer.subscription.updated", { id: "sub_A" }))).status).toBe(200);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_A");
    expect(store.applySubscription).not.toHaveBeenCalled();
    stripe.subscriptions.cancel.mockClear();
    stripe.customers.retrieve.mockResolvedValueOnce({ id: "cus_A", metadata: {} });
    expect((await deliver(event("customer.subscription.updated", { id: "sub_A" }, "evt_Other"))).status).toBe(200);
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it("ignores prices that are not Embel plans and events it does not handle", async () => {
    stripe = fakeStripe(
      subscription({
        items: {
          data: [{ id: "si_X", current_period_start: START, current_period_end: END, price: { lookup_key: "other" } }],
        },
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await deliver(event("invoice.paid", { id: "in_1" }))).status).toBe(200);
    expect(store.applyInvoice).not.toHaveBeenCalled();
    expect((await deliver(event("charge.refunded", { id: "ch_1" }, "evt_Charge"))).status).toBe(200);
    expect(store.recordEvent).toHaveBeenLastCalledWith("evt_Charge", "charge.refunded");
  });
});
