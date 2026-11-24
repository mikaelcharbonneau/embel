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
   `invoice.paid`, `invoice.payment_failed` and `subscription_schedule.created|updated|released|canceled`
   (a switch to a smaller plan waiting for its renewal). Everything else is acknowledged and ignored.
   A signed delivery that does not verify answers 400 and logs `stripe_webhook_signature_rejected`: with
   a wrong `STRIPE_WEBHOOK_SECRET` every event is refused and paid plans never arrive, so look for that
   line when a payment does not show up.
4. **Manage** (`POST /api/billing/portal`): the Stripe customer portal, which Managed Payments supports, for
   cancelling (at the period end), switching between Pro and Studio, the payment method and invoices.
   **Switch to …** opens the portal straight on the confirmation of that change
   (`flow_data.type = subscription_update_confirm`). A switch to the larger plan applies at once; a switch
   to the smaller plan starts at the next renewal (see "A smaller plan starts at the renewal" below).
   Customers can also manage the same subscription from Link (link.com); both paths end in the same webhooks.

_November 14, 2026: checkout is refused with `billing_pending` (409, "A plan payment is still being
confirmed. Check again in a few minutes.") while an earlier subscription is still `incomplete`; the
Plans page shows it as a neutral notice with Check again. The webhook takes its sync time before it
reads Stripe, so of two events handled at once the older read cannot overwrite the newer._

**Only one Checkout page can be paid** (November 14, 2026; `expireOpenCheckouts` in
`src/server/billing/sessions.ts`). Two pages opened before either was paid could both be completed and
create two subscriptions. So before a new page is created, the account's Stripe customer is asked for
its open Checkout sessions (`checkout.sessions.list` with `status: open`) and each one is expired
(`checkout.sessions.expire`); an account with no Stripe customer yet has none. The earlier tab then
shows Stripe's expired page. The rule when Stripe does not cooperate: a new page is opened only when no
earlier one can still be paid.

- The open sessions cannot be listed, or one can neither be expired nor read back as expired: 503
  `integration_unavailable`, nothing is opened, and trying again is safe.
- A session turns out to be paid already (finished a moment ago in the other tab): 409
  `billing_pending`, the same notice as for a first payment still being confirmed.

**One Checkout request per account at a time** (November 15, 2026; migration
`20261115100000_checkout_claim`). Two requests arriving in the same instant could each find nothing open
and each open a page. Before it looks at open pages, the server now takes a short claim on the
account's billing row (`billing_claim_checkout`) and gives it back as soon as the new page exists or
the attempt failed (`billing_release_checkout`). The request that does not get the claim answers 409
`checkout_opening` ("Checkout is already opening for this account. Try again in a moment."), which the
Plans page shows with Try again. A claim that is never given back ends by itself after 30 seconds.

If two subscriptions ever become live for one account anyway, the webhook logs
`billing_second_live_subscription` (it shows in Vercel's error report), and credits are not added twice: the second
subscription's first invoice starts a new paid period, which sets the balance back to the plan's
allowance (150, not 150 + 150), and each later renewal does the same; both subscriptions are saved as
Stripe reports them and the plan stays paid while either is live (database test "never adds a second
allowance…"). The person is charged twice by Stripe, though, and nothing cancels the extra subscription
automatically: cancel and refund it in the Stripe dashboard. Not tried against Stripe: that a Managed
Payments Checkout session lists and expires like any other (the `stripe` 23.0.1 types have both calls
and no exception for it).

## Credit rules (database, migration `20261111100000_stripe_billing`)

- **One allowance per paid period.** A paid invoice for a new billing period moves the account to the
  subscription's plan and Stripe's period and sets the balance to the plan's monthly credits, exactly as a
  Free month does today (credits don't roll over). Each invoice id is applied once
  (`fluid_private.billing_invoice_grants`).
- **Upgrade** (Pro → Studio) is billed immediately with proration (portal setting `always_invoice`). When
  that invoice is paid, the account gets only the difference between Studio's allowance and the largest
  allowance already granted in the period (500 − 150 = 350), and moves to Studio for the rest of the period.
- **Downgrade** (Studio → Pro) starts at the next renewal: until then the plan, the balance and the
  credits stay Studio's, and the renewal invoice starts the period with Pro's 150. Nothing is paid back
  mid-period. Switching down and back up in one period grants nothing extra.
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

## A smaller plan starts at the renewal (November 23, 2026)

**The hole.** The portal applied every plan change at once with proration. Pro → Studio granted the 350
extra credits on a small prorated invoice; switching straight back made Stripe credit the unused Studio
time while the credits stayed. At each renewal the granted allowance went back to 150, so the round trip
worked again every month: Studio's 500 credits for about the Pro price.

**The fix.** `scripts/stripe/ensure-products.mjs` sets the portal's
`subscription_update.schedule_at_period_end` to `decreasing_item_amount`: Stripe holds a switch to a
cheaper plan in a subscription schedule and applies it when the paid period ends, so no money comes back.
An upgrade is unchanged (at once, prorated, +350 on the paid invoice).

- The webhook reads the schedule (`scheduledPlan` in `src/server/billing/webhook.ts`): the phase that
  starts when the period ends carries the next price. It is saved as
  `billing_subscriptions.pending_plan_id` (migration `20261123100000_billing_pending_plan`).
- The Plans page says "Your plan changes to Pro on …, with 150 new credits", marks the Pro card "Starts on
  …" and offers no second switch; **Manage plan** opens the portal home, where the change can be undone.
- If a plan ever drops inside a paid period anyway (the portal configuration was not updated, or someone
  changed the subscription by hand in the dashboard), the webhook logs `billing_plan_lowered_mid_period`.
  Nothing is taken back automatically.

**To release it:** apply the migration, deploy, then run `ensure-products.mjs` again against the sandbox
(and later with `--live`), and add the four `subscription_schedule.*` events to the webhook endpoint.
Until the script has run, the portal still applies a downgrade at once.

**Not tried against Stripe** (no key in the session that wrote this): that the portal schedules the
downgrade for a Managed Payments subscription, that the deep link to the confirmation works for a
scheduled change, and the exact shape of the schedule's phases. Check in the sandbox: Studio → Switch to
Pro should show "changes to Pro on …" on `/plans`, the subscription should stay Studio in the dashboard
with a schedule attached, and no credit note should appear.

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
   `invoice.paid`, `invoice.payment_failed`, `subscription_schedule.created`,
   `subscription_schedule.updated`, `subscription_schedule.released`, `subscription_schedule.canceled`.
   Copy its signing secret.
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
- Manage → Switch to Studio: +350 credits on the paid proration invoice. Switch back to Pro: the page says
  the plan changes to Pro at the renewal; plan and credits stay until then, and Stripe pays nothing back.
  Cancel: the plan shows "ends on …" and stays until the period end.
- **Renewals and cancellation endings with test clocks:** Dashboard → Billing → Test clocks → create a clock,
  create a customer on it with `metadata.embel_owner_id` set to a test account's id and record it with
  `billing_link_customer`, create the subscription for that customer, then advance the clock past the period
  end. The renewal invoice grants a fresh allowance; a cancelled one returns the account to Free. (Customers
  created by Checkout cannot be attached to a clock afterwards.)
- Webhook deliveries and retries: Dashboard → Webhooks → the endpoint → event deliveries. The Stripe CLI
  can forward to a local server (`stripe listen --forward-to localhost:3105/api/billing/stripe-webhook`),
  using the secret it prints as `STRIPE_WEBHOOK_SECRET`.
- In the sandbox, receipt emails are not sent automatically (send them from the payment's page).

## Switching to live keys

_Checked November 18, 2026 (read only): Vercel project `embel`, the live Stripe account and the
production database._

**What the check found**

- **No sandbox payment has completed yet.** The production database has no billing customers,
  subscriptions, invoice grants or webhook events. The sandbox end-to-end test ("Testing in the sandbox"
  above) comes first; going live before it would make the first real customer the first test.
- **Nothing to clean up in the database.** With no billing rows, no account holds a sandbox customer or
  subscription, so step 4 of the old list (deleting test rows) is not needed today. If sandbox tests run
  before the switch, see "Database" below.
- **The Stripe keys come from the Vercel Stripe integration** (a sandbox store) and apply to Production,
  Preview and Development at once. Production needs its own live key while previews keep the sandbox one,
  so the integration's variables must stop covering Production first (Vercel does not allow two values of
  one variable for the same environment). `STRIPE_WEBHOOK_SECRET` is already Production only.
- **The live Stripe account has nothing for Embel yet:** no Embel products or prices, no customer portal
  configuration, no active subscriptions. It has two other live webhook endpoints: "Grok automations"
  (leave it) and `https://tryfluid.app/api/stripe/webhook`, an endpoint from the app's earlier name. That
  old endpoint would also receive every Embel event; disable it unless something still uses it.
- **No code change is needed.** The app already refuses a live key outside Vercel production, sends no
  browser key, reads prices by lookup key (so live price ids need no configuration) and verifies each
  webhook with its own secret, so sandbox events can never be applied in live mode.

**Steps (in order)**

1. **Sandbox test first.** Complete the sandbox steps under "Release steps" and "Testing in the sandbox":
   a Pro checkout, a switch to Studio, a cancel. Confirm in Stripe (sandbox → Webhooks → event
   deliveries) that every delivery answered 200.
2. **Stripe live account, Dashboard (owner):**
   - Finish account activation (business details, bank account for payouts, identity), if not done.
   - Settings → Managed Payments: activate it in live mode (eligibility review; this can take time).
   - Settings → Public details: statement descriptor and support email/URL that say Embel.
   - Settings → Checkout: terms of service and privacy policy links. Embel has no Terms or Privacy
     page yet; Stripe's review and Managed Payments may ask for them.
   - Settings → Billing → Customer portal: save the settings once so a default configuration exists.
   - Developers → Webhooks: disable `https://tryfluid.app/api/stripe/webhook` unless still used.
3. **Live products and prices:** with a live secret key in the shell only (never pasted into files or
   chat): `STRIPE_SECRET_KEY=sk_live_… node scripts/stripe/ensure-products.mjs --live`. Run it again
   until it reports nothing but "portal configuration … updated (default)".
4. **Live webhook endpoint:** Developers → Webhooks → Add endpoint, in live mode:
   `https://www.embel.xyz/api/billing/stripe-webhook`, API version `2026-09-30.endive`, the same eight
   events as the sandbox endpoint (step 3 of "Release steps"). Copy its signing secret (`whsec_…`).
5. **Live key for the app:** create a restricted key (`rk_live_…`, Developers → API keys → Create
   restricted key) rather than using the full secret key. It needs write access to Customers, Checkout
   Sessions, Subscriptions and Customer portal, and read access to Prices and Invoices. If a call is
   refused, Vercel's logs show `integration_unavailable`; widen that one permission.
6. **Vercel (owner), project `embel` → Settings → Environment Variables:**
   - Stop the Stripe integration's sandbox variables from covering Production: Storage → the Stripe
     store → Projects → `embel` → environments: Preview and Development only. Check afterwards that
     `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` and
     `STRIPE_MCP_KEY` no longer list Production.
   - Add `STRIPE_SECRET_KEY` = the live restricted key, Production only, Sensitive.
   - Edit `STRIPE_WEBHOOK_SECRET` (Production) = the live endpoint's signing secret.
   - The publishable keys are not read by the app; no live publishable key is needed.
7. **Redeploy production** (release lead, from a clean clone of `main`:
   `vercel deploy --prod --scope embel`). Environment variables apply only to new deployments.
8. **First live check:** buy Pro with a real card on a test account, confirm `/plans` shows Pro and 150
   credits and the live endpoint's delivery answered 200, then cancel and refund it in the Stripe
   Dashboard (Payments → the payment → Refund). The refund is a real one and Stripe keeps the record.
9. **Disable the sandbox webhook endpoint** that points at `www.embel.xyz`: after the switch it can only
   fail signature checks and retry.

**Database.** If sandbox purchases were made on production accounts before the switch, those accounts
hold sandbox customer and subscription ids that do not exist in live mode (checkout would fail with
"No such customer"). They are disposable test data; at the switch, delete them:

```sql
delete from fluid_private.billing_subscriptions;
delete from fluid_private.billing_customers;
```

Paid plans then return to Free by themselves (`ensure_credit_period` sees no live subscription).
`billing_invoice_grants` and `billing_events` can stay; their ids never repeat in live mode.

**Rollback.** Put the sandbox key back on Production (or remove the live variable and re-include
Production in the integration store), restore the sandbox `STRIPE_WEBHOOK_SECRET`, and redeploy. Live
subscriptions already sold keep billing in Stripe; cancel or honor them by hand.

## Not verified here

No Stripe API call was made while building this (no keys locally): the Checkout parameters, portal flow and
event shapes follow the Stripe docs and the `stripe` 23.0.1 types, and are covered by unit tests with fakes.
The first sandbox checkout is the end-to-end test. Whether the portal's plan-switch flow applies to a
Managed Payments subscription exactly as to a normal one is documented by Stripe but not yet tried.
