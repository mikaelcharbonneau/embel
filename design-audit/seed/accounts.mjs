// Account reset, creation, credits and billing for the design-audit seed. Local stack only.
// The reset follows the app's own account deletion (src/server/account/deletion.ts): purge the
// database rows, remove the account's Storage files, delete the Auth user, close the receipt.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { auditDir } from "./stack.mjs";

export const CREDENTIALS = path.join(auditDir, ".audit-credentials");
const BUCKET = "fluid-assets";
export const SEED_NOTE = "Design audit seed";

export function adminClient(stack) {
  return createClient(stack.apiUrl, stack.secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
export async function withDatabase(stack, work) {
  const client = new pg.Client({ connectionString: stack.adminDatabaseUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Stable passwords: reused from .audit-credentials when present, so logins never change. */
export function loadPasswords(accounts) {
  const saved = existsSync(CREDENTIALS) ? JSON.parse(readFileSync(CREDENTIALS, "utf8")) : { accounts: [] };
  return Object.fromEntries(
    accounts.map((a) => [
      a.email,
      saved.accounts?.find((row) => row.email === a.email)?.password ??
        `Audit-${randomBytes(12).toString("base64url")}`,
    ]),
  );
}
export function saveCredentials(stack, accounts, passwords) {
  const body = {
    note: "Local design-audit test accounts (LOCAL stack only, never production). Do not commit.",
    signIn: `${stack.appOrigin}/sign-in`,
    accounts: accounts.map((a) => ({
      account: `audit-${a.key}`,
      email: a.email,
      password: passwords[a.email],
      plan: a.plan,
    })),
  };
  writeFileSync(CREDENTIALS, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
}

async function findUser(admin, email) {
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const user = data.users.find((u) => u.email === email);
    if (user || data.users.length < 200) return user ?? null;
  }
}

/** Deletes one audit account and everything it owns, the way Settings → Delete account does. */
export async function resetAccount(stack, email) {
  if (!/^audit-[a-z]+@example\.test$/u.test(email)) throw new Error(`Refusing to reset a non-audit account: ${email}`);
  const admin = adminClient(stack);
  const user = await findUser(admin, email);
  if (!user) return false;
  const owner = user.id;
  const call = async (fn, args) => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  // Stop anything still running for the account first (the stand-in answers quickly anyway).
  await withDatabase(stack, (db) =>
    db.query(
      "update public.generation_runs set cancel_requested_at = coalesce(cancel_requested_at, now()) where owner_id = $1 and status in ('queued','running')",
      [owner],
    ),
  );
  await call("account_deletion_begin", { p_owner: owner });
  // Known app issue (November 11): the purge alone is refused (account_purge_blocked) for any
  // account that chose a name, because name_candidates -> name_selections -> naming_sessions
  // (current_selection_id) -> name_candidates form a foreign-key cycle. Clearing the session's
  // current selection in the same transaction breaks the cycle; the purge then deletes it all.
  await withDatabase(stack, async (db) => {
    await db.query("begin");
    try {
      await db.query(
        "update public.naming_sessions set current_selection_id = null where owner_id = $1 and current_selection_id is not null",
        [owner],
      );
      await db.query("select public.account_deletion_purge($1)", [owner]);
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw new Error(`account_deletion_purge for ${email}: ${error.message} ${error.detail ?? ""}`);
    }
  });
  for (;;) {
    const paths = await call("account_storage_objects", { p_owner: owner, p_limit: 100 });
    if (!paths?.length) break;
    const { error } = await admin.storage.from(BUCKET).remove(paths);
    if (error) throw new Error(`storage remove: ${error.message}`);
    await call("account_deletion_files_removed", { p_owner: owner, p_count: paths.length });
  }
  const { error } = await admin.auth.admin.deleteUser(owner, false);
  if (error && !/not.?found/iu.test(error.message)) throw new Error(`deleteUser: ${error.message}`);
  await call("account_deletion_complete", { p_owner: owner });
  return true;
}

export async function createAccount(stack, email, password) {
  const admin = adminClient(stack);
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message ?? "no user"}`);
  return data.user.id;
}

/** Starts the monthly period (as the app does lazily), then adds seed credits for the journeys. */
export async function grantSeedCredits(stack, owner, credits) {
  await withDatabase(stack, async (db) => {
    await db.query("select fluid_private.ensure_credit_period($1)", [owner]);
    await db.query("insert into public.credit_entries (owner_id, delta, kind, note) values ($1, $2, 'grant', $3)", [
      owner,
      credits,
      `${SEED_NOTE}: temporary credits to build the seed brands`,
    ]);
  });
}
/** Leaves the account with exactly `target` credits (0 puts a Free account at its limit). */
export async function settleCredits(stack, owner, target) {
  return withDatabase(stack, async (db) => {
    const { rows } = await db.query("select fluid_private.credit_balance($1)::int as balance", [owner]);
    const delta = target - rows[0].balance;
    if (delta !== 0)
      await db.query("insert into public.credit_entries (owner_id, delta, kind, note) values ($1, $2, $3, $4)", [
        owner,
        delta,
        delta > 0 ? "grant" : "charge",
        `${SEED_NOTE}: set balance to ${target}`,
      ]);
    return target;
  });
}

/**
 * A Pro subscription recorded exactly as the Stripe webhook records one (billing_apply_subscription
 * and billing_apply_invoice), with test-style identifiers. Nothing is sent to Stripe.
 */
export async function applyProPlan(stack, owner) {
  const admin = adminClient(stack);
  const customer = "cus_auditPro0001",
    subscription = "sub_auditPro0001",
    invoice = `in_auditPro${Date.now()}`;
  const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 10));
  const end = new Date(start.getTime() + 30 * 86_400_000);
  const rpc = async (fn, args) => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  await rpc("billing_link_customer", { p_owner: owner, p_customer: customer });
  await rpc("billing_apply_subscription", {
    p_owner: owner,
    p_subscription: subscription,
    p_customer: customer,
    p_plan: "pro",
    p_status: "active",
    p_period_start: start.toISOString(),
    p_period_end: end.toISOString(),
    p_cancel_at_period_end: false,
    p_synced_at: new Date().toISOString(),
  });
  await rpc("billing_apply_invoice", {
    p_owner: owner,
    p_invoice: invoice,
    p_subscription: subscription,
    p_plan: "pro",
    p_period_start: start.toISOString(),
    p_period_end: end.toISOString(),
  });
}
