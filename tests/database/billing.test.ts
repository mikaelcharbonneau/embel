import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";

// Synthetic Stripe ids on the complete migrated PGlite schema. No Stripe API is involved.
let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 180_000);
beforeEach(async () => {
  await resetFixture(db);
  await db.exec("delete from fluid_private.billing_events");
});

const CUSTOMER_A = "cus_TestOwnerA";
const CUSTOMER_B = "cus_TestOwnerB";
const SUB_A = "sub_TestOwnerA";
const DAY = 24 * 3600 * 1000;
const at = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

async function failure(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error as { message: string; code?: string };
  }
  throw new Error("Expected a failure");
}
const service = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  asRole(db, "service_role", null, async () => (await db.query<{ r: T }>(sql, params)).rows[0]!.r);

const link = (owner: string, customer: string) =>
  service<string>("select public.billing_link_customer($1, $2) as r", [owner, customer]);

let synced = 0;
function applySubscription(
  owner: string,
  input: {
    plan?: string;
    status?: string;
    start?: string;
    end?: string;
    cancelAtPeriodEnd?: boolean;
    subscription?: string;
    customer?: string;
  } = {},
) {
  synced += 1;
  return service<{ stored: boolean; live: boolean; accountPlanId: string }>(
    "select public.billing_apply_subscription($1, $2, $3, $4, $5, $6, $7, $8, $9) as r",
    [
      owner,
      input.subscription ?? SUB_A,
      input.customer ?? CUSTOMER_A,
      input.plan ?? "pro",
      input.status ?? "active",
      input.start ?? at(-1),
      input.end ?? at(29),
      input.cancelAtPeriodEnd ?? false,
      new Date(Date.now() + synced).toISOString(),
    ],
  );
}
function applyInvoice(
  owner: string,
  invoice: string,
  plan = "pro",
  start = at(-1),
  end = at(29),
  subscription = SUB_A,
) {
  return service<{ applied: boolean; outcome?: string; credits?: number }>(
    "select public.billing_apply_invoice($1, $2, $3, $4, $5, $6) as r",
    [owner, invoice, subscription, plan, start, end],
  );
}
async function summary(owner: string) {
  return asRole(
    db,
    "authenticated",
    owner,
    async () =>
      (
        await db.query<{
          r: {
            planId: string;
            balance: number;
            periodEnd: string;
            subscription: { planId: string; status: string; cancelAtPeriodEnd: boolean } | null;
            plans: { id: string; monthlyCredits: number }[];
          };
        }>("select public.get_billing_summary() as r")
      ).rows[0]!.r,
  );
}
async function spend(owner: string, credits: number) {
  await db.query(
    "insert into public.credit_entries (owner_id, delta, kind, note) values ($1, $2, 'adjustment', 'test')",
    [owner, -credits],
  );
}

describe("paid plans", () => {
  it("grants the plan's credits once per paid invoice", async () => {
    expect(await summary(OWNER_A)).toMatchObject({ planId: "free", balance: 30, subscription: null });
    expect(await link(OWNER_A, CUSTOMER_A)).toBe(CUSTOMER_A);
    // A second customer for the same account is ignored: the first one stays.
    expect(await link(OWNER_A, "cus_SomethingElse")).toBe(CUSTOMER_A);
    await applySubscription(OWNER_A);
    const start = at(-1),
      end = at(29);
    expect(await applyInvoice(OWNER_A, "in_First", "pro", start, end)).toMatchObject({
      applied: true,
      outcome: "new_period",
      credits: 120,
    });
    expect(await summary(OWNER_A)).toMatchObject({
      planId: "pro",
      balance: 150,
      subscription: { planId: "pro", status: "active", cancelAtPeriodEnd: false },
    });
    expect(new Date((await summary(OWNER_A)).periodEnd).getTime()).toBe(new Date(end).getTime());
    // Replays (webhook retries, duplicate events) never grant again.
    await spend(OWNER_A, 40);
    expect(await applyInvoice(OWNER_A, "in_First", "pro", start, end)).toMatchObject({ applied: false });
    expect((await summary(OWNER_A)).balance).toBe(110);
  });

  it("refuses an invoice before its subscription is live", async () => {
    await link(OWNER_A, CUSTOMER_A);
    await applySubscription(OWNER_A, { status: "incomplete" });
    expect((await failure(() => applyInvoice(OWNER_A, "in_Early"))).message).toContain("subscription_not_live");
    expect((await summary(OWNER_A)).planId).toBe("free");
  });

  it("adds only the difference on an upgrade and never grants twice for a switch down and up", async () => {
    await link(OWNER_A, CUSTOMER_A);
    const start = at(-5),
      end = at(25);
    await applySubscription(OWNER_A, { start, end });
    await applyInvoice(OWNER_A, "in_Pro", "pro", start, end);
    await spend(OWNER_A, 100);
    await applySubscription(OWNER_A, { plan: "studio", start, end });
    expect(await applyInvoice(OWNER_A, "in_Upgrade", "studio", start, end)).toMatchObject({
      outcome: "same_period",
      credits: 350,
    });
    expect(await summary(OWNER_A)).toMatchObject({ planId: "studio", balance: 400 });
    await applySubscription(OWNER_A, { plan: "pro", start, end });
    expect(await applyInvoice(OWNER_A, "in_Downgrade", "pro", start, end)).toMatchObject({ credits: 0 });
    expect(await summary(OWNER_A)).toMatchObject({ planId: "pro", balance: 400 });
    await applySubscription(OWNER_A, { plan: "studio", start, end });
    expect(await applyInvoice(OWNER_A, "in_UpAgain", "studio", start, end)).toMatchObject({ credits: 0 });
    expect(await summary(OWNER_A)).toMatchObject({ planId: "studio", balance: 400 });
  });

  it("starts each renewed period with the plan's allowance and ignores a late invoice of an older period", async () => {
    await link(OWNER_A, CUSTOMER_A);
    await applySubscription(OWNER_A, { start: at(-40), end: at(-10) });
    await applyInvoice(OWNER_A, "in_Old", "pro", at(-40), at(-10));
    await applySubscription(OWNER_A, { start: at(-10), end: at(20) });
    await applyInvoice(OWNER_A, "in_Renewal", "pro", at(-10), at(20));
    await spend(OWNER_A, 140);
    expect((await summary(OWNER_A)).balance).toBe(10);
    expect(await applyInvoice(OWNER_A, "in_LateOld", "pro", at(-40), at(-10))).toMatchObject({
      outcome: "stale",
      credits: 0,
    });
    expect(await applyInvoice(OWNER_A, "in_Next", "pro", at(20), at(50))).toMatchObject({
      outcome: "new_period",
      credits: 140,
    });
    expect((await summary(OWNER_A)).balance).toBe(150);
  });

  it("waits for the renewal invoice instead of renewing a paid period by itself", async () => {
    await link(OWNER_A, CUSTOMER_A);
    await applySubscription(OWNER_A, { start: at(-31), end: at(-1) });
    await applyInvoice(OWNER_A, "in_Period", "pro", at(-31), at(-1));
    await spend(OWNER_A, 100);
    // Stripe has started the next period but its invoice isn't paid yet.
    await applySubscription(OWNER_A, { start: at(-1), end: at(29), status: "past_due" });
    expect(await summary(OWNER_A)).toMatchObject({ planId: "pro", balance: 50 });
    const entries = await db.query("select * from public.credit_entries where owner_id = $1 and kind = 'grant'", [
      OWNER_A,
    ]);
    expect(entries.rows).toHaveLength(2); // the Free allowance, then the first paid invoice
  });

  it("keeps a cancelled plan until its period ends, then returns to Free", async () => {
    await link(OWNER_A, CUSTOMER_A);
    await applySubscription(OWNER_A);
    await applyInvoice(OWNER_A, "in_Paid");
    await applySubscription(OWNER_A, { cancelAtPeriodEnd: true });
    expect(await summary(OWNER_A)).toMatchObject({
      planId: "pro",
      balance: 150,
      subscription: { cancelAtPeriodEnd: true },
    });
    expect(await applySubscription(OWNER_A, { cancelAtPeriodEnd: true, status: "canceled" })).toMatchObject({
      live: false,
      accountPlanId: "free",
    });
    expect(await summary(OWNER_A)).toMatchObject({ planId: "free", balance: 30, subscription: null });
  });

  it("returns to Free when a cancelled period ended and the final event never arrived", async () => {
    await link(OWNER_A, CUSTOMER_A);
    await applySubscription(OWNER_A, { start: at(-31), end: at(-1), cancelAtPeriodEnd: true });
    await db.query("update fluid_private.billing_subscriptions set current_period_end = $1", [at(10)]);
    await applyInvoice(OWNER_A, "in_Last", "pro", at(-31), at(-1));
    await db.query("update fluid_private.billing_subscriptions set current_period_end = $1", [at(-1)]);
    expect(await summary(OWNER_A)).toMatchObject({ planId: "free", balance: 30 });
  });

  it("keeps an older Stripe read from overwriting a newer one", async () => {
    await link(OWNER_A, CUSTOMER_A);
    await applySubscription(OWNER_A, { cancelAtPeriodEnd: true });
    const stale = await service<{ stored: boolean }>(
      "select public.billing_apply_subscription($1, $2, $3, 'pro', 'active', $4, $5, false, $6) as r",
      [OWNER_A, SUB_A, CUSTOMER_A, at(-1), at(29), new Date(0).toISOString()],
    );
    expect(stale.stored).toBe(false);
    expect((await summary(OWNER_A)).subscription).toMatchObject({ cancelAtPeriodEnd: true });
  });

  it("leaves another owner untouched and refuses another owner's customer", async () => {
    await link(OWNER_A, CUSTOMER_A);
    expect((await failure(() => link(OWNER_B, CUSTOMER_A))).message).toMatch(/duplicate|unique/i);
    await link(OWNER_B, CUSTOMER_B);
    await summary(OWNER_B);
    await applySubscription(OWNER_A);
    await applyInvoice(OWNER_A, "in_A");
    expect(await summary(OWNER_B)).toMatchObject({ planId: "free", balance: 30, subscription: null });
    expect((await failure(() => applySubscription(OWNER_B, { customer: CUSTOMER_A }))).message).toContain(
      "customer_mismatch",
    );
    expect(
      (await failure(() => applySubscription(OWNER_B, { customer: CUSTOMER_B, subscription: SUB_A }))).message,
    ).toContain("customer_mismatch");
    expect((await failure(() => applyInvoice(OWNER_B, "in_B"))).message).toContain("subscription_not_live");
    expect(await service("select public.billing_owner_for_customer($1) as r", [CUSTOMER_A])).toBe(OWNER_A);
  });

  it("records each Stripe event once", async () => {
    expect(await service("select public.billing_event_seen('evt_One') as r")).toBe(false);
    expect(await service("select public.billing_record_event('evt_One', 'invoice.paid') as r")).toBe(true);
    expect(await service("select public.billing_record_event('evt_One', 'invoice.paid') as r")).toBe(false);
    expect(await service("select public.billing_event_seen('evt_One') as r")).toBe(true);
  });

  it("reports the account's customer and subscription to the server", async () => {
    expect(await service("select public.billing_owner_state($1) as r", [OWNER_A])).toEqual({
      customerId: null,
      subscription: null,
    });
    await link(OWNER_A, CUSTOMER_A);
    await applySubscription(OWNER_A);
    expect(await service("select public.billing_owner_state($1) as r", [OWNER_A])).toEqual({
      customerId: CUSTOMER_A,
      subscription: { id: SUB_A, planId: "pro", status: "active", cancelAtPeriodEnd: false, live: true },
    });
  });
});

describe("privileges", () => {
  const serverOnly = [
    ["public.billing_link_customer($1, 'cus_X')", [OWNER_A]],
    ["public.billing_owner_state($1)", [OWNER_A]],
    ["public.billing_owner_for_customer('cus_X')", []],
    ["public.billing_event_seen('evt_X')", []],
    ["public.billing_record_event('evt_X', 'x')", []],
    [
      "public.billing_apply_subscription($1, 'sub_X', 'cus_X', 'pro', 'active', now(), now() + interval '1 day', false, now())",
      [OWNER_A],
    ],
    ["public.billing_apply_invoice($1, 'in_X', 'sub_X', 'pro', now(), now() + interval '1 day')", [OWNER_A]],
  ] as const;
  for (const role of ["authenticated", "anon"] as const) {
    for (const [call, params] of serverOnly) {
      it(`refuses ${call.split("(")[0]} to ${role}`, async () => {
        const error = await failure(() =>
          asRole(db, role, role === "authenticated" ? OWNER_A : null, () => db.query(`select ${call}`, [...params])),
        );
        expect(error.message).toContain("permission denied");
      });
    }
  }
  it("refuses the billing summary to anon and private tables to every API role", async () => {
    expect(
      (await failure(() => asRole(db, "anon", null, () => db.query("select public.get_billing_summary()")))).message,
    ).toContain("permission denied");
    for (const role of ["authenticated", "anon", "service_role"] as const) {
      const error = await failure(() =>
        asRole(db, role, role === "authenticated" ? OWNER_A : null, () =>
          db.query("select * from fluid_private.billing_subscriptions"),
        ),
      );
      expect(error.message).toContain("permission denied");
    }
  });
});

describe("account deletion", () => {
  it("purges the account's billing records and keeps the processed event ids", async () => {
    await link(OWNER_A, CUSTOMER_A);
    await applySubscription(OWNER_A);
    await applyInvoice(OWNER_A, "in_A");
    await service("select public.billing_record_event('evt_Kept', 'invoice.paid') as r");
    await link(OWNER_B, CUSTOMER_B);
    await service("select public.account_deletion_begin($1) as r", [OWNER_A]);
    await service("select public.account_deletion_purge($1) as r", [OWNER_A]);
    for (const table of ["billing_customers", "billing_subscriptions", "billing_invoice_grants"]) {
      const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from fluid_private.${table} where owner_id = $1`,
        [OWNER_A],
      );
      expect(rows[0]!.n, table).toBe(0);
    }
    expect(await service("select public.billing_owner_for_customer($1) as r", [CUSTOMER_A])).toBeNull();
    expect(await service("select public.billing_owner_for_customer($1) as r", [CUSTOMER_B])).toBe(OWNER_B);
    expect(await service("select public.billing_event_seen('evt_Kept') as r")).toBe(true);
  });
});
