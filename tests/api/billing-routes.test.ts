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
function fakeStore(state: BillingOwnerState): BillingStore & { linkCustomer: ReturnType<typeof vi.fn> } {
  return {
    ownerState: vi.fn(async () => state),
    linkCustomer: vi.fn(async (_owner: string, customer: string) => customer),
    ownerForCustomer: vi.fn(),
    eventSeen: vi.fn(),
    recordEvent: vi.fn(),
    applySubscription: vi.fn(),
    applyInvoice: vi.fn(),
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
