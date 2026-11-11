# Payments: paid plans with Stripe Managed Payments

_November 11, 2026. Tasks C1 and C2 of [execution-plan.md](execution-plan.md)._

Embel sells two monthly plans through **Stripe Managed Payments**: Stripe (through Link) is the merchant
of record, so it calculates, collects and remits sales tax, VAT and GST, handles disputes and fraud, sends
receipts and invoices, and gives customers order support. The business is in Canada, a supported location.

| Plan | Price (USD, monthly) | Credits each month | Stripe lookup key |
|---|---|---|---|
| Free | $0 | 30 | none |
| Pro | $7.99 | 150 | `embel_pro_monthly` |
| Studio | $27.99 | 500 | `embel_studio_monthly` |

Credits per plan live in `fluid_private.plans`; prices and lookup keys in `src/domain/billing.ts` and
`scripts/stripe/ensure-products.mjs` (a test keeps the two equal). Plan prices appear on the Plans page and
at checkout; cost estimates for generations still appear nowhere.

## How it works

1. **Plans page** (`/plans`, linked from the account menu, from Settings → Account → Plan and credits, and
   from the out-of-credits prompt). It shows the three plans, the current plan, credits left and when they
   renew. One click on **Upgrade** calls `POST /api/billing/checkout` and opens Stripe Checkout; there is
   no confirmation screen of our own.
2. **Checkout** (`src/server/billing/sessions.ts`): `mode: subscription`, `managed_payments[enabled]=true`,
   the plan's price found by lookup key, the account's Stripe customer (created once, with
   `metadata.embel_owner_id`, and reused), `client_reference_id` and metadata = the account id, return URLs on
   `APP_ORIGIN` (`/plans?checkout=success|cancelled`). Parameters Managed Payments controls itself are never
   sent (`automatic_tax`, `payment_method_types`, `customer_update`, `tax_id_collection`, `invoice_creation`,
   `subscription_data.default_tax_rates`, `subscription_data.invoice_settings`, Connect fields). An account
   with a live subscription is refused (`409 billing_active`) and uses Manage instead.
3. **Webhook** (`POST /api/billing/stripe-webhook`, `src/server/billing/webhook-endpoint.ts` and
   `webhook.ts`): verifies the `Stripe-Signature` header over the raw body with `STRIPE_WEBHOOK_SECRET`,
   skips event ids already processed, then **re-reads the subscription and invoice from Stripe** (payload
   amounts, prices and ids are never trusted) and calls the database functions with the service-role key.
   The event id is recorded only after everything applied; any failure answers 500 and Stripe retries.
   Events used: `checkout.session.completed`, `customer.subscription.created|updated|deleted|paused|resumed`,
   `invoice.paid`, `invoice.payment_failed`. Everything else is acknowledged and ignored.
4. **Manage** (`POST /api/billing/portal`): the Stripe customer portal, which Managed Payments supports, for
   cancelling (at the period end), switching between Pro and Studio, the payment method and invoices.
   **Switch to …** opens the portal straight on the confirmation of that change
   (`flow_data.type = subscription_update_confirm`). Customers can also manage the same subscription from
   Link (link.com); both paths end in the same webhooks.

## Credit rules (database, migration `20261111100000_stripe_billing`)

- **One allowance per paid period.** A paid invoice for a new billing period moves the account to the
  subscription's plan and Stripe's period and sets the balance to the plan's monthly credits, exactly as a
  Free month does today (credits don't roll over). Each invoice id is applied once
  (`fluid_private.billing_invoice_grants`).
- **Upgrade** (Pro → Studio) is billed immediately with proration (portal setting `always_invoice`). When
  that invoice is paid, the account gets only the difference between Studio's allowance and the largest
  allowance already granted in the period (500 − 150 = 350), and moves to Studio for the rest of the period.
- **Downgrade** (Studio → Pro) keeps the current balance until the next period, which starts with Pro's 150.
  Switching down and back up in one period grants nothing extra.
- **Cancellation** keeps the plan until the end of the paid period. When Stripe ends the subscription
  (`customer.subscription.deleted`), the account returns to Free and gets the Free allowance for the current
  calendar month. If that final event were missed, `ensure_credit_period` does the same once the period is over.
- **Renewal not paid yet** (Stripe retrying a failed payment, `past_due`): the plan stays, nothing new is
  granted until an invoice is paid. A subscription that Stripe finally cancels or marks unpaid returns the
  account to Free.
- **Free accounts** are unchanged: calendar months, 30 credits, granted lazily by `ensure_credit_period`.
- The billing tables are in `fluid_private` and every row has an `owner_id`, so account deletion purges them.
  `billing_events` keeps only Stripe event ids and types.
- Functions callable by the server only (`service_role`): `billing_link_customer`, `billing_owner_state`,
  `billing_owner_for_customer`, `billing_event_seen`, `billing_record_event`, `billing_apply_subscription`,
  `billing_apply_invoice`. For the signed-in person: `get_billing_summary` (plan, balance, period end,
  subscription state, plans; no payment detail).

## Account deletion

Before the purge, `deleteSignedInAccount` cancels the account's Stripe subscriptions immediately (best
effort, logged as `account_deletion_billing_cancel` on failure). As a safety net, a webhook for a
subscription whose Stripe customer is ours (`metadata.embel_owner_id`) but whose account no longer exists
cancels that subscription. The Stripe customer and its invoices stay with Stripe, the merchant of record.

## Tax code and tax behavior

Products use **`txcd_10105002`, "Artificial Intelligence as a Service (AIaaS) - Cloud Based - Business
Use"**, eligible for Managed Payments since June 2, 2026 (Managed Payments changelog). Embel is an AI branding
tool used mostly by founders and businesses; the business/personal distinction matters only for US sales.
If most buyers turn out to be individuals, `txcd_10105001` (Personal Use) is the alternative; change
`TAX_CODE` in the script and run it again.

Prices use `tax_behavior: exclusive`, the Managed Payments default: tax is added on top of $7.99 / $27.99
where it applies. The Plans page says so.

## Environment variables

| Variable | Use |
|---|---|
| `STRIPE_SECRET_KEY` | Server only. Checkout, portal, webhook re-reads and deletion. A live key (`sk_live_`/`rk_live_`) is refused unless `VERCEL_ENV=production`. |
| `STRIPE_WEBHOOK_SECRET` | Server only. The endpoint's signing secret (`whsec_…`). Without it the webhook answers 503 and Stripe retries. |
| `EMBEL_ENGINE_SUPABASE_SECRET_KEY` | Existing. The service-role key the webhook and billing routes use for the billing functions. |

`STRIPE_PUBLISHABLE_KEY` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` exist in Vercel but are not read: hosted
Checkout and the portal are redirects and need no browser key.

Pinned versions: `stripe` 23.0.1 (released October 22, 2026), API version `2026-09-30.endive`
(`src/server/billing/stripe.ts`; Managed Payments needs `2025-03-31.basil` or later).

## Release steps (lead)

1. **Stripe sandbox, once:** Dashboard → Settings → Managed Payments: activate it (eligibility review).
   Settings → Billing → Customer portal: save the settings once so a default configuration exists.
   Settings → Checkout: add the terms of service and privacy policy links if wanted.
2. **Products and prices:** `STRIPE_SECRET_KEY=sk_test_… node scripts/stripe/ensure-products.mjs`. It
   prints the product, price and portal configuration ids. Run it again until it reports nothing but
   "portal configuration … updated (default)".
3. **Webhook endpoint:** Dashboard → Developers → Webhooks → Add endpoint
   `https://www.embel.xyz/api/billing/stripe-webhook`, API version `2026-09-30.endive`, events
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`,
   `invoice.paid`, `invoice.payment_failed`. Copy its signing secret.
4. **Vercel:** add `STRIPE_WEBHOOK_SECRET` (Production, secret). `STRIPE_SECRET_KEY` is already there.
5. **Database:** merge, then run the Release database workflow (dry run, then apply) for
   `20261111100000_stripe_billing` ([database-release.md](database-release.md)).
6. **Deploy** the web app, then test as below. Rollback: redeploy the previous release (the Plans page and
   routes disappear; the tables stay harmless), and if needed apply the rollback in the migration header.

## Testing in the sandbox

- Upgrade from `/plans`; pay with `4242 4242 4242 4242`, any future date, any CVC. Back on `/plans` the page
  confirms within seconds: plan Pro, 150 credits. `3D Secure`: `4000 0025 0000 3155`; declined:
  `4000 0000 0000 0341` (attaches, then fails on renewal).
- Try different billing countries at Checkout to see Managed Payments add tax.
- Manage → Switch to Studio: +350 credits on the paid proration invoice. Switch back to Pro: no change until
  renewal. Cancel: the plan shows "ends on …" and stays until the period end.
- **Renewals and cancellation endings with test clocks:** Dashboard → Billing → Test clocks → create a clock,
  create a customer on it with `metadata.embel_owner_id` set to a test account's id and record it with
  `billing_link_customer`, create the subscription for that customer, then advance the clock past the period
  end. The renewal invoice grants a fresh allowance; a cancelled one returns the account to Free. (Customers
  created by Checkout cannot be attached to a clock afterwards.)
- Webhook deliveries and retries: Dashboard → Webhooks → the endpoint → event deliveries. The Stripe CLI
  can forward to a local server (`stripe listen --forward-to localhost:3105/api/billing/stripe-webhook`),
  using the secret it prints as `STRIPE_WEBHOOK_SECRET`.
- In the sandbox, receipt emails are not sent automatically (send them from the payment's page).

## Switching to live keys later

1. Activate Managed Payments in live mode and save the live customer portal settings.
2. `STRIPE_SECRET_KEY=sk_live_… node scripts/stripe/ensure-products.mjs --live`.
3. Create the live webhook endpoint (same URL and events) and set the live `STRIPE_WEBHOOK_SECRET` and
   `STRIPE_SECRET_KEY` in Vercel Production only (previews keep test keys; the app refuses a live key outside
   production). Redeploy.
4. Test-mode customers and subscriptions do not exist in live mode. Test accounts that hold a sandbox
   customer link should start fresh: delete their rows in `fluid_private.billing_customers` and
   `fluid_private.billing_subscriptions` (disposable test data), or use new accounts.

## Not verified here

No Stripe API call was made while building this (no keys locally): the Checkout parameters, portal flow and
event shapes follow the Stripe docs and the `stripe` 23.0.1 types, and are covered by unit tests with fakes.
The first sandbox checkout is the end-to-end test. Whether the portal's plan-switch flow applies to a
Managed Payments subscription exactly as to a normal one is documented by Stripe but not yet tried.
