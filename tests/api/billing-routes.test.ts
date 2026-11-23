import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mock = vi.hoisted(() => ({ context: vi.fn(), deps: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ getVerifiedAccountContext: mock.context }));
vi.mock("@/server/billing/dependencies", () => ({ billingDependencies: mock.deps }));
import { POST as checkout } from "@/app/api/billing/checkout/route";
import { POST as portal } from "@/app/api/billing/portal/route";
import { ApiError } from "@/server/http/errors";
import type { BillingOwnerState, BillingStore } from "@/server/billing/store";

// Obvious fakes only: no Stripe key, no network.
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORIGIN = "http://localhost:3105";

function fakeStripe() {
  const price = (plan: string) => ({
    id: `price_${plan}`,
    lookup_key: `embel_${plan}_monthly`,
    recurring: { interval: "month" },
  });
  return {
    customers: { create: vi.fn(async () => ({ id: "cus_New" })) },
    prices: {
      list: vi.fn(async ({ lookup_keys }: { lookup_keys: string[] }) => ({
        data: [price(lookup_keys[0]!.replace("embel_", "").replace("_monthly", ""))],
      })),
    },
    checkout: {
      sessions: {
        create: vi.fn<(params: unknown) => Promise<{ url: string }>>(async () => ({
          url: "https://checkout.stripe.com/c/pay/cs_test_fake",
        })),
        list: vi.fn<(params: unknown) => Promise<{ data: { id: string }[]; has_more: boolean }>>(async () => ({
          data: [],
          has_more: false,
        })),
        expire: vi.fn<(id: string) => Promise<{ id: string; status: string }>>(async (id) => ({
          id,
          status: "expired",
        })),
        retrieve: vi.fn<(id: string) => Promise<{ id: string; status: string }>>(async (id) => ({
          id,
          status: "open",
        })),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn<(params: unknown) => Promise<{ url: string }>>(async () => ({
          url: "https://billing.stripe.com/p/session/test_fake",
        })),
      },
    },
    subscriptions: {
      retrieve: vi.fn(async (id: string) => ({ id, items: { data: [{ id: "si_Item", price: price("pro") }] } })),
    },
  };
}
function fakeStore(state: BillingOwnerState): BillingStore & {
  linkCustomer: ReturnType<typeof vi.fn>;
  claimCheckout: ReturnType<typeof vi.fn>;
  releaseCheckout: ReturnType<typeof vi.fn>;
} {
  return {
    ownerState: vi.fn(async () => state),
    linkCustomer: vi.fn(async (_owner: string, customer: string) => customer),
    ownerForCustomer: vi.fn(),
    eventSeen: vi.fn(),
    recordEvent: vi.fn(),
    applySubscription: vi.fn(),
    applyInvoice: vi.fn(),
    claimCheckout: vi.fn(async () => true),
    releaseCheckout: vi.fn(async () => undefined),
    liveSubscriptionCount: vi.fn(async () => 1),
  };
}

let stripe: ReturnType<typeof fakeStripe>;
let store: ReturnType<typeof fakeStore>;
const request = (path: string, body: unknown, headers: Record<string, string> = {}, query = "") =>
  new Request(`${ORIGIN}/api/billing/${path}${query}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", "X-Embel-Account": A, ...headers },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ORIGIN", ORIGIN);
  stripe = fakeStripe();
  store = fakeStore({ customerId: null, subscription: null });
  mock.context.mockResolvedValue({ client: {}, user: { id: A, email: "owner@example.invalid" } });
  mock.deps.mockImplementation(() => ({ stripe, store, origin: ORIGIN }));
});
afterEach(() => vi.unstubAllEnvs());

describe("checkout", () => {
  it("opens a Managed Payments subscription checkout for the session's own account", async () => {
    const response = await checkout(request("checkout", { plan: "studio" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_fake" });
    expect(stripe.customers.create).toHaveBeenCalledWith(
      { email: "owner@example.invalid", metadata: { embel_owner_id: A } },
      { idempotencyKey: `embel-customer-${A}` },
    );
    expect(store.linkCustomer).toHaveBeenCalledWith(A, "cus_New");
    const params = stripe.checkout.sessions.create.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(params).toMatchObject({
      mode: "subscription",
      customer: "cus_New",
      client_reference_id: A,
      line_items: [{ price: "price_studio", quantity: 1 }],
      managed_payments: { enabled: true },
      subscription_data: { metadata: { embel_owner_id: A, embel_plan: "studio" } },
      success_url: `${ORIGIN}/plans?checkout=success`,
      cancel_url: `${ORIGIN}/plans?checkout=cancelled`,
    });
    // Parameters Managed Payments controls itself are never sent.
    for (const key of [
      "automatic_tax",
      "payment_method_types",
      "customer_update",
      "tax_id_collection",
      "invoice_creation",
    ])
      expect(params).not.toHaveProperty(key);
  });

  it("reuses the account's existing Stripe customer", async () => {
    store = fakeStore({ customerId: "cus_Existing", subscription: null });
    expect((await checkout(request("checkout", { plan: "pro" }))).status).toBe(200);
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create.mock.calls[0]![0]).toMatchObject({ customer: "cus_Existing" });
  });

  it("closes an earlier Checkout page that is still open before opening the new one", async () => {
    store = fakeStore({ customerId: "cus_Existing", subscription: null });
    stripe.checkout.sessions.list.mockResolvedValueOnce({
      data: [{ id: "cs_test_old1" }, { id: "cs_test_old2" }],
      has_more: false,
    });
    expect((await checkout(request("checkout", { plan: "pro" }))).status).toBe(200);
    expect(stripe.checkout.sessions.list).toHaveBeenCalledWith({
      customer: "cus_Existing",
      status: "open",
      limit: 100,
    });
    expect(stripe.checkout.sessions.expire.mock.calls.map(([id]) => id)).toEqual(["cs_test_old1", "cs_test_old2"]);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    const lastExpire = Math.max(...stripe.checkout.sessions.expire.mock.invocationCallOrder);
    expect(lastExpire).toBeLessThan(stripe.checkout.sessions.create.mock.invocationCallOrder[0]!);
  });

  it("closes nothing when no earlier page is open, and does not look for one before the account has a customer", async () => {
    store = fakeStore({ customerId: "cus_Existing", subscription: null });
    expect((await checkout(request("checkout", { plan: "pro" }))).status).toBe(200);
    expect(stripe.checkout.sessions.list).toHaveBeenCalledTimes(1);
    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
    store = fakeStore({ customerId: null, subscription: null });
    expect((await checkout(request("checkout", { plan: "pro" }))).status).toBe(200);
    expect(stripe.checkout.sessions.list).toHaveBeenCalledTimes(1);
    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
  });

  it("opens no second page when the open ones cannot be listed or closed", async () => {
    store = fakeStore({ customerId: "cus_Existing", subscription: null });
    stripe.checkout.sessions.list.mockRejectedValueOnce(new Error("stripe is down sk_test_never_shown"));
    let response = await checkout(request("checkout", { plan: "pro" }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/sk_|stripe is down/);
    // An earlier page that cannot be closed and is still open.
    stripe.checkout.sessions.list.mockResolvedValueOnce({ data: [{ id: "cs_test_old1" }], has_more: false });
    stripe.checkout.sessions.expire.mockRejectedValueOnce(new Error("timeout"));
    response = await checkout(request("checkout", { plan: "pro" }));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("integration_unavailable");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("lets one Checkout request per account through at a time and gives the turn back afterwards", async () => {
    store = fakeStore({ customerId: "cus_Existing", subscription: null });
    // Another request of this account is opening Checkout right now.
    store.claimCheckout.mockResolvedValueOnce(false);
    let response = await checkout(request("checkout", { plan: "pro" }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("checkout_opening");
    expect(stripe.checkout.sessions.list).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(store.releaseCheckout).not.toHaveBeenCalled(); // The turn belongs to the other request.
    // The turn is taken before open pages are looked at, and given back once the page exists.
    response = await checkout(request("checkout", { plan: "pro" }));
    expect(response.status).toBe(200);
    expect(store.claimCheckout.mock.invocationCallOrder[1]!).toBeLessThan(
      stripe.checkout.sessions.list.mock.invocationCallOrder[0]!,
    );
    expect(stripe.checkout.sessions.create.mock.invocationCallOrder[0]!).toBeLessThan(
      store.releaseCheckout.mock.invocationCallOrder[0]!,
    );
    // Given back after a failure too, so trying again is not held up.
    stripe.checkout.sessions.list.mockRejectedValueOnce(new Error("network"));
    expect((await checkout(request("checkout", { plan: "pro" }))).status).toBe(503);
    expect(store.releaseCheckout).toHaveBeenCalledTimes(2);
    // A release that fails does not turn an opened page into an error: the turn ends by itself.
    store.releaseCheckout.mockRejectedValueOnce(new Error("database"));
    expect((await checkout(request("checkout", { plan: "pro" }))).status).toBe(200);
  });

  it("answers that a payment is being confirmed when the earlier page was just paid", async () => {
    store = fakeStore({ customerId: "cus_Existing", subscription: null });
    stripe.checkout.sessions.list.mockResolvedValueOnce({ data: [{ id: "cs_test_paid" }], has_more: false });
    stripe.checkout.sessions.expire.mockRejectedValueOnce(new Error("Only open sessions can be expired"));
    stripe.checkout.sessions.retrieve.mockResolvedValueOnce({ id: "cs_test_paid", status: "complete" });
    const response = await checkout(request("checkout", { plan: "pro" }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("billing_pending");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("refuses a second subscription", async () => {
    store = fakeStore({
      customerId: "cus_Existing",
      subscription: { id: "sub_1", planId: "pro", status: "active", cancelAtPeriodEnd: false, live: true },
    });
    const response = await checkout(request("checkout", { plan: "studio" }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("billing_active");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("refuses a second checkout while an earlier one's first payment is still being confirmed", async () => {
    store = fakeStore({
      customerId: "cus_Existing",
      subscription: { id: "sub_1", planId: "pro", status: "incomplete", cancelAtPeriodEnd: false, live: false },
    });
    const response = await checkout(request("checkout", { plan: "pro" }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("billing_pending");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it.each(["canceled", "incomplete_expired"])(
    "opens checkout again after a subscription ended (%s)",
    async (status) => {
      store = fakeStore({
        customerId: "cus_Existing",
        subscription: { id: "sub_1", planId: "pro", status, cancelAtPeriodEnd: false, live: false },
      });
      expect((await checkout(request("checkout", { plan: "pro" }))).status).toBe(200);
    },
  );

  it("validates the plan and refuses any other input", async () => {
    for (const body of [
      { plan: "free" },
      { plan: "enterprise" },
      {},
      { plan: "pro", ownerId: B },
      { plan: "pro", price: 1 },
    ])
      expect((await checkout(request("checkout", body))).status, JSON.stringify(body)).toBe(422);
    expect((await checkout(request("checkout", { plan: "pro" }, {}, `?ownerId=${B}`))).status).toBe(422);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("requires a signed-in session, the same account and the site's own origin", async () => {
    mock.context.mockRejectedValueOnce(new ApiError("unauthenticated"));
    expect((await checkout(request("checkout", { plan: "pro" }))).status).toBe(401);
    expect((await checkout(request("checkout", { plan: "pro" }, { "X-Embel-Account": B }))).status).toBe(401);
    expect((await checkout(request("checkout", { plan: "pro" }, { origin: "https://foreign.invalid" }))).status).toBe(
      403,
    );
    expect((await checkout(request("checkout", { plan: "pro" }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("reports a missing price or Stripe configuration as unavailable, without details", async () => {
    stripe.prices.list.mockResolvedValueOnce({ data: [] });
    expect((await checkout(request("checkout", { plan: "pro" }))).status).toBe(503);
    mock.deps.mockImplementationOnce(() => {
      throw new ApiError("integration_unavailable");
    });
    const response = await checkout(request("checkout", { plan: "pro" }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/sk_|whsec_/);
  });
});

describe("portal", () => {
  it("opens the portal for the account's own customer", async () => {
    store = fakeStore({
      customerId: "cus_Existing",
      subscription: { id: "sub_1", planId: "pro", status: "active", cancelAtPeriodEnd: false, live: true },
    });
    const response = await portal(request("portal", {}));
    expect(response.status).toBe(200);
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: "cus_Existing",
      return_url: `${ORIGIN}/plans`,
    });
  });

  it("opens straight on the confirmation of a plan switch", async () => {
    store = fakeStore({
      customerId: "cus_Existing",
      subscription: { id: "sub_1", planId: "pro", status: "active", cancelAtPeriodEnd: false, live: true },
    });
    expect((await portal(request("portal", { plan: "studio" }))).status).toBe(200);
    expect(stripe.billingPortal.sessions.create.mock.calls[0]![0]).toMatchObject({
      customer: "cus_Existing",
      flow_data: {
        type: "subscription_update_confirm",
        subscription_update_confirm: { subscription: "sub_1", items: [{ id: "si_Item", price: "price_studio" }] },
      },
    });
  });

  it("opens the portal home when a plan change already waits for the renewal", async () => {
    store = fakeStore({
      customerId: "cus_Existing",
      subscription: {
        id: "sub_1",
        planId: "studio",
        status: "active",
        cancelAtPeriodEnd: false,
        live: true,
        pendingPlanId: "pro",
      },
    });
    expect((await portal(request("portal", { plan: "pro" }))).status).toBe(200);
    expect(stripe.billingPortal.sessions.create.mock.calls[0]![0]).toEqual({
      customer: "cus_Existing",
      return_url: `${ORIGIN}/plans`,
    });
  });

  it("opens straight on cancelling the plan at the period end", async () => {
    store = fakeStore({
      customerId: "cus_Existing",
      subscription: { id: "sub_1", planId: "pro", status: "active", cancelAtPeriodEnd: false, live: true },
    });
    expect((await portal(request("portal", { action: "cancel" }))).status).toBe(200);
    expect(stripe.billingPortal.sessions.create.mock.calls[0]![0]).toMatchObject({
      customer: "cus_Existing",
      flow_data: {
        type: "subscription_cancel",
        subscription_cancel: { subscription: "sub_1" },
        after_completion: { type: "redirect", redirect: { return_url: `${ORIGIN}/plans?portal=updated` } },
      },
    });
  });

  it("refuses to cancel without a live plan, twice, or together with a plan change", async () => {
    store = fakeStore({
      customerId: "cus_Existing",
      subscription: { id: "sub_1", planId: "pro", status: "active", cancelAtPeriodEnd: true, live: true },
    });
    expect((await portal(request("portal", { action: "cancel" }))).status).toBe(409);
    store = fakeStore({
      customerId: "cus_Existing",
      subscription: { id: "sub_1", planId: "pro", status: "canceled", cancelAtPeriodEnd: false, live: false },
    });
    expect((await portal(request("portal", { action: "cancel" }))).status).toBe(409);
    expect((await portal(request("portal", { action: "cancel", plan: "studio" }))).status).toBe(422);
    expect((await portal(request("portal", { action: "delete" }))).status).toBe(422);
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it("has nothing to manage without a customer, and checks origin and account", async () => {
    expect((await portal(request("portal", {}))).status).toBe(404);
    expect((await portal(request("portal", {}, { "X-Embel-Account": B }))).status).toBe(401);
    expect((await portal(request("portal", {}, { origin: "https://foreign.invalid" }))).status).toBe(403);
    expect((await portal(request("portal", { plan: "gold" }))).status).toBe(422);
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });
});
