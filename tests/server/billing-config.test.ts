import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { cancelSubscriptionsForDeletion } from "@/server/billing/account-deletion";
import type { StripeClient } from "@/server/billing/stripe";
import { getStripeSecretKey, getStripeWebhookSecret } from "@/server/config";

// Obvious fake values only.
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
afterEach(() => vi.restoreAllMocks());

describe("Stripe configuration", () => {
  it("accepts test keys, and live keys only in Vercel production", () => {
    expect(getStripeSecretKey({ STRIPE_SECRET_KEY: "sk_test_FakeKeyForTests123" })).toBe("sk_test_FakeKeyForTests123");
    expect(() => getStripeSecretKey({ STRIPE_SECRET_KEY: "sk_live_FakeKeyForTests123" })).toThrow(
      expect.objectContaining({ code: "integration_unavailable" }),
    );
    expect(() =>
      getStripeSecretKey({ STRIPE_SECRET_KEY: "sk_live_FakeKeyForTests123", VERCEL_ENV: "preview" }),
    ).toThrow();
    expect(getStripeSecretKey({ STRIPE_SECRET_KEY: "sk_live_FakeKeyForTests123", VERCEL_ENV: "production" })).toBe(
      "sk_live_FakeKeyForTests123",
    );
    for (const bad of [undefined, "", "pk_test_FakeKeyForTests123", "sk_test_short", "whsec_FakeKeyForTests123"])
      expect(() => getStripeSecretKey({ STRIPE_SECRET_KEY: bad })).toThrow();
  });
  it("requires a webhook signing secret", () => {
    expect(getStripeWebhookSecret({ STRIPE_WEBHOOK_SECRET: "whsec_FakeSigningSecret" })).toBe(
      "whsec_FakeSigningSecret",
    );
    for (const bad of [undefined, "", "   ", "sk_test_FakeKeyForTests123"])
      expect(() => getStripeWebhookSecret({ STRIPE_WEBHOOK_SECRET: bad })).toThrow();
  });
});

describe("cancelling billing before an account deletion", () => {
  const admin = (customerId: string | null) =>
    ({ rpc: vi.fn(async () => ({ data: { customerId, subscription: null }, error: null })) }) as never;
  function stripeWith(statuses: string[]) {
    return {
      subscriptions: {
        list: vi.fn(async () => ({ data: statuses.map((status, index) => ({ id: `sub_${index}`, status })) })),
        cancel: vi.fn(async () => ({})),
      },
    };
  }

  it("cancels every subscription that is not already over", async () => {
    const stripe = stripeWith(["active", "canceled", "past_due", "incomplete_expired"]);
    expect(await cancelSubscriptionsForDeletion(admin("cus_A"), A, () => stripe as unknown as StripeClient)).toBe(2);
    expect(stripe.subscriptions.list).toHaveBeenCalledWith({ customer: "cus_A", status: "all", limit: 100 });
    expect(stripe.subscriptions.cancel.mock.calls.map((call) => (call as unknown[])[0])).toEqual(["sub_0", "sub_2"]);
  });

  it("does nothing without a customer and never stops the deletion on a failure", async () => {
    const make = vi.fn();
    expect(await cancelSubscriptionsForDeletion(admin(null), A, make)).toBe(0);
    expect(make).not.toHaveBeenCalled();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = stripeWith(["active"]);
    failing.subscriptions.cancel.mockRejectedValueOnce(new Error("PRIVATE"));
    expect(await cancelSubscriptionsForDeletion(admin("cus_A"), A, () => failing as unknown as StripeClient)).toBe(0);
    expect(log.mock.calls.flat().join(" ")).toContain("account_deletion_billing_cancel");
    expect(log.mock.calls.flat().join(" ")).not.toContain("PRIVATE");
  });
});
