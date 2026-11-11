import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkedSecretKey,
  ensureStripeCatalog,
  PLANS,
  STRIPE_API_VERSION,
  TAX_CODE,
} from "../../scripts/stripe/ensure-products.mjs";
import { PLAN_CATALOG } from "../../src/domain/billing.ts";
import { readFileSync } from "node:fs";

/** An in-memory Stripe account with just what the script uses. No network, no key. */
function memoryStripe() {
  const products = new Map();
  const prices = [];
  const portals = [];
  const calls = [];
  let next = 0;
  const id = (prefix) => `${prefix}_${++next}`;
  return {
    calls,
    priceRows: prices,
    portals,
    products: {
      async retrieve(productId) {
        const product = products.get(productId);
        if (!product) throw Object.assign(new Error("No such product"), { statusCode: 404 });
        return product;
      },
      async create(params) {
        calls.push("products.create");
        products.set(params.id, { ...params });
        return products.get(params.id);
      },
      async update(productId, params) {
        calls.push("products.update");
        products.set(productId, { ...products.get(productId), ...params });
        return products.get(productId);
      },
    },
    prices: {
      async list({ lookup_keys }) {
        return { data: prices.filter((price) => lookup_keys.includes(price.lookup_key)) };
      },
      async create(params) {
        calls.push("prices.create");
        for (const price of prices) if (price.lookup_key === params.lookup_key) price.lookup_key = null;
        const price = {
          id: id("price"),
          active: true,
          type: "recurring",
          ...params,
          recurring: { ...params.recurring },
        };
        prices.push(price);
        return price;
      },
      async update(priceId, params) {
        calls.push("prices.update");
        Object.assign(
          prices.find((price) => price.id === priceId),
          params,
        );
      },
    },
    billingPortal: {
      configurations: {
        async list() {
          return { data: portals.filter((portal) => portal.is_default) };
        },
        async create(params) {
          calls.push("portal.create");
          const portal = { id: id("bpc"), is_default: portals.length === 0, ...params };
          portals.push(portal);
          return portal;
        },
        async update(portalId, params) {
          calls.push("portal.update");
          const portal = portals.find((entry) => entry.id === portalId);
          Object.assign(portal, params);
          return portal;
        },
      },
    },
  };
}

describe("scripts/stripe/ensure-products.mjs", () => {
  it("sells the same plans and amounts as the app shows", () => {
    for (const plan of PLANS) {
      assert.equal(PLAN_CATALOG[plan.id].monthlyPriceCents, plan.unitAmount, plan.id);
      assert.equal(PLAN_CATALOG[plan.id].lookupKey, plan.lookupKey, plan.id);
    }
    assert.deepEqual(PLANS.map((plan) => plan.id).sort(), ["pro", "studio"]);
    assert.equal(TAX_CODE, "txcd_10105002");
    const server = readFileSync(new URL("../../src/server/billing/stripe.ts", import.meta.url), "utf8");
    assert.ok(server.includes(`STRIPE_API_VERSION = "${STRIPE_API_VERSION}"`), "API versions match");
  });

  it("creates the catalog once and changes nothing on a second run", async () => {
    const stripe = memoryStripe();
    const first = await ensureStripeCatalog(stripe, () => undefined);
    assert.equal(stripe.priceRows.length, 2);
    for (const price of stripe.priceRows) {
      assert.equal(price.currency, "usd");
      assert.equal(price.tax_behavior, "exclusive");
      assert.deepEqual(price.recurring, { interval: "month", interval_count: 1 });
    }
    assert.equal(stripe.portals[0].features.subscription_cancel.mode, "at_period_end");
    assert.equal(stripe.portals[0].features.subscription_update.proration_behavior, "always_invoice");
    stripe.calls.length = 0;
    const second = await ensureStripeCatalog(stripe, () => undefined);
    assert.deepEqual(second.prices, first.prices);
    assert.deepEqual(stripe.calls, ["portal.update"]);
  });

  it("replaces a price whose amount changed and archives the old one", async () => {
    const stripe = memoryStripe();
    await ensureStripeCatalog(stripe, () => undefined);
    stripe.priceRows[0].unit_amount = 500;
    const result = await ensureStripeCatalog(stripe, () => undefined);
    assert.equal(stripe.priceRows.length, 3);
    assert.equal(stripe.priceRows[0].active, false);
    assert.notEqual(result.prices.pro, stripe.priceRows[0].id);
  });

  it("refuses live keys unless --live is passed and never accepts other strings", () => {
    assert.throws(() => checkedSecretKey(undefined, false));
    assert.throws(() => checkedSecretKey("pk_test_abcdefghijklmnop", false));
    assert.throws(() => checkedSecretKey("sk_live_FakeKeyForTests123", false), /--live/);
    assert.equal(checkedSecretKey("sk_live_FakeKeyForTests123", true), "sk_live_FakeKeyForTests123");
    assert.equal(checkedSecretKey("sk_test_FakeKeyForTests123", false), "sk_test_FakeKeyForTests123");
  });
});
