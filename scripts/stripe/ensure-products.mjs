#!/usr/bin/env node
// Sets up Embel's paid plans in Stripe, idempotently (docs/payments.md):
//   * the products "embel_pro" and "embel_studio" with the Managed Payments tax code,
//   * one active monthly USD price per product, found by its lookup key,
//   * the default customer portal configuration (cancel at period end, switch between the
//     two plans with immediate proration, payment method, invoice history).
// Running it again changes nothing unless a value differs. A changed amount creates a new
// price, moves the lookup key to it and archives the old one (Stripe prices are immutable).
//
// Usage: STRIPE_SECRET_KEY=sk_test_... node scripts/stripe/ensure-products.mjs [--live]
// Refuses a live key unless --live is passed. Prints ids only, never keys.

import Stripe from "stripe";

/** Pinned with src/server/billing/stripe.ts. */
export const STRIPE_API_VERSION = "2026-09-30.endive";

/** AI as a Service, cloud based, business use: eligible for Managed Payments since June 2, 2026.
 * Embel is an AI branding tool used mostly by founders and businesses (docs/payments.md). */
export const TAX_CODE = "txcd_10105002";

/** Same numbers as PLAN_CATALOG in src/domain/billing.ts (a test keeps them equal). */
export const PLANS = [
  {
    id: "pro",
    productId: "embel_pro",
    name: "Embel Pro",
    description: "150 credits every month for the Embel branding journey.",
    lookupKey: "embel_pro_monthly",
    unitAmount: 799,
  },
  {
    id: "studio",
    productId: "embel_studio",
    name: "Embel Studio",
    description: "500 credits every month for the Embel branding journey.",
    lookupKey: "embel_studio_monthly",
    unitAmount: 2799,
  },
];

const CURRENCY = "usd";
/** Managed Payments adds tax on top of the price unless the price says otherwise. */
const TAX_BEHAVIOR = "exclusive";

function priceMatches(price, plan) {
  return (
    price.active &&
    price.currency === CURRENCY &&
    price.unit_amount === plan.unitAmount &&
    price.recurring?.interval === "month" &&
    price.recurring?.interval_count === 1 &&
    price.tax_behavior === TAX_BEHAVIOR &&
    price.type === "recurring"
  );
}

async function ensureProduct(stripe, plan) {
  const wanted = {
    name: plan.name,
    description: plan.description,
    tax_code: TAX_CODE,
    active: true,
    metadata: { embel_plan: plan.id },
  };
  let product;
  try {
    product = await stripe.products.retrieve(plan.productId);
  } catch (error) {
    if (error?.statusCode !== 404) throw error;
    return { product: await stripe.products.create({ id: plan.productId, ...wanted }), changed: "created" };
  }
  const taxCode = typeof product.tax_code === "string" ? product.tax_code : product.tax_code?.id;
  if (
    product.name === wanted.name &&
    product.description === wanted.description &&
    taxCode === TAX_CODE &&
    product.active &&
    product.metadata?.embel_plan === plan.id
  ) {
    return { product, changed: "unchanged" };
  }
  return { product: await stripe.products.update(plan.productId, wanted), changed: "updated" };
}

async function ensurePrice(stripe, plan) {
  const existing = (await stripe.prices.list({ lookup_keys: [plan.lookupKey], limit: 10 })).data;
  const current = existing.find((price) => {
    const product = typeof price.product === "string" ? price.product : price.product?.id;
    return product === plan.productId && priceMatches(price, plan);
  });
  if (current) return { price: current, changed: "unchanged" };
  const price = await stripe.prices.create({
    product: plan.productId,
    currency: CURRENCY,
    unit_amount: plan.unitAmount,
    recurring: { interval: "month", interval_count: 1 },
    tax_behavior: TAX_BEHAVIOR,
    lookup_key: plan.lookupKey,
    transfer_lookup_key: true,
    metadata: { embel_plan: plan.id },
  });
  for (const old of existing) {
    if (old.id !== price.id && old.active) await stripe.prices.update(old.id, { active: false });
  }
  return { price, changed: existing.length ? "replaced" : "created" };
}

function portalFeatures(prices) {
  return {
    customer_update: { enabled: false },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: {
      enabled: true,
      mode: "at_period_end",
      proration_behavior: "none",
      cancellation_reason: {
        enabled: true,
        options: ["too_expensive", "missing_features", "switched_service", "unused", "other"],
      },
    },
    subscription_update: {
      enabled: true,
      default_allowed_updates: ["price"],
      proration_behavior: "always_invoice",
      products: PLANS.map((plan) => ({ product: plan.productId, prices: [prices[plan.id].id] })),
    },
  };
}

async function ensurePortal(stripe, prices) {
  const features = portalFeatures(prices);
  const metadata = { embel: "plans" };
  const current = (await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 })).data[0];
  if (current) {
    const configuration = await stripe.billingPortal.configurations.update(current.id, { features, metadata });
    return { configuration, changed: "updated" };
  }
  const configuration = await stripe.billingPortal.configurations.create({ features, metadata, name: "Embel plans" });
  return { configuration, changed: "created" };
}

/** The whole setup against one Stripe client. Returns the ids it ensured. */
export async function ensureStripeCatalog(stripe, log = console.log) {
  const prices = {};
  for (const plan of PLANS) {
    const product = await ensureProduct(stripe, plan);
    log(`product ${product.product.id}: ${product.changed}`);
    const price = await ensurePrice(stripe, plan);
    prices[plan.id] = price.price;
    log(`price ${price.price.id} (${plan.lookupKey}): ${price.changed}`);
  }
  const portal = await ensurePortal(stripe, prices);
  log(
    `portal configuration ${portal.configuration.id}: ${portal.changed}${portal.configuration.is_default ? " (default)" : ""}`,
  );
  return {
    prices: Object.fromEntries(Object.entries(prices).map(([plan, price]) => [plan, price.id])),
    portalConfiguration: portal.configuration.id,
    portalIsDefault: portal.configuration.is_default === true,
  };
}

/** Checks the key's shape and mode without ever printing it. */
export function checkedSecretKey(key, live) {
  const match = typeof key === "string" ? /^(?:sk|rk)_(test|live)_[A-Za-z0-9]{10,500}$/u.exec(key.trim()) : null;
  if (!match) throw new Error("STRIPE_SECRET_KEY is missing or is not a Stripe secret key.");
  if (match[1] === "live" && !live) throw new Error("Refusing a live key. Pass --live to set up live mode.");
  return key.trim();
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--live");
  if (unknown.length) throw new Error("Usage: node scripts/stripe/ensure-products.mjs [--live]");
  const key = checkedSecretKey(process.env.STRIPE_SECRET_KEY, args.includes("--live"));
  const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2 });
  const result = await ensureStripeCatalog(stripe);
  if (!result.portalIsDefault) {
    console.log(
      "The portal configuration is not the default one. Save the customer portal settings once in the Stripe Dashboard, then run this again.",
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // Stripe errors carry a type and code; their messages never include the key.
    console.error(`ensure-products failed: ${error?.type ?? error?.name ?? "error"} ${error?.code ?? ""}`.trim());
    process.exitCode = 1;
  });
}
