import { readFile } from "node:fs/promises";
import { strategyPolicy } from "../../src/server/ai/config";
import { asRole, createTestDatabase, installApiTextRuntimeCandidate, installApiTextWorkerFixture,
  OWNER_A, OWNER_B, resetFixture, seedProject, type TestDatabase } from "./local-supabase";

export const MULTI_DEPLOYMENT = "dpl_multi_account_fixture";
export const MULTI_POLICY = strategyPolicy("strategy.reformulate");
export async function createMultiAccountFixture() {
  const db = await createTestDatabase();
  await installApiTextRuntimeCandidate(db); await installApiTextWorkerFixture(db);
  await db.exec("alter table auth.users add column created_at timestamptz default clock_timestamp(), add column email_confirmed_at timestamptz");
  await db.exec(await readFile(new URL("../../supabase/candidates/api_text_multi_account.sql", import.meta.url), "utf8"));
  // Disposable test grants. The production candidate creates no worker grant.
  await db.exec("grant execute on function public.api_text_dispatch_action(jsonb,text,jsonb),public.list_api_text_dispatches_v2(integer),public.api_text_multi_account_readiness(jsonb,text) to fixture_api_text_a,fixture_api_text_b");
  return db;
}
export async function resetMultiAccountFixture(db: TestDatabase) {
  await resetFixture(db);
  await db.exec("truncate fluid_private.api_text_allowance_rollout,fluid_private.api_text_allowance_cohorts cascade; insert into fluid_private.api_text_allowance_rollout(singleton) values(true); delete from fluid_private.strategy_runtime_policy; update public.usage_accounts set limit_microusd=0; update auth.users set email_confirmed_at=clock_timestamp()");
  await db.query("insert into fluid_private.api_text_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_api_text_a'", [OWNER_A]);
  await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values('strategy.reformulate',true,$1)", [MULTI_POLICY]);
  return { a: (await seedProject(db, OWNER_A)).id, b: (await seedProject(db, OWNER_B)).id };
}
export async function enableSyntheticCohort(db: TestDatabase, options: { attempts?: number; ownerCost?: number; globalAttempts?: number; globalCost?: number; accounts?: number } = {}) {
  const attempts = options.attempts ?? 1; const ownerCost = options.ownerCost ?? 122880;
  await db.query(`insert into fluid_private.api_text_allowance_cohorts(id,enabled,role_name,role_oid,deployment_id,operations,
    signup_after,signup_before,expires_at,owner_attempt_limit,owner_cost_limit,owner_active_limit,account_limit,attempt_limit,cost_limit)
    select 'fixture',true,rolname,oid,$1,array['strategy.reformulate'],clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day',
    $2,$3,1,10,20,2457600 from pg_roles where rolname='fixture_api_text_a'`, [MULTI_DEPLOYMENT, attempts, ownerCost]);
  await db.query("update fluid_private.api_text_allowance_rollout set enabled=true,signup_cohort='fixture',account_limit=$1,attempt_limit=$2,cost_limit=$3 where singleton", [options.accounts ?? 10, options.globalAttempts ?? 20, options.globalCost ?? 2457600]);
}
export async function enableLegacyOwner(db: TestDatabase) {
  await db.query("update public.usage_accounts set limit_microusd=5000000 where owner_id=$1", [OWNER_A]);
  await db.query("insert into fluid_private.strategy_billing_routes values($1,'openai_api',1)", [OWNER_A]);
  await db.query("insert into fluid_private.api_strategy_bindings(owner_id,operation,role_oid,policy_identity,deployment_id,enabled) select $1,'strategy.reformulate',role_oid,encode(sha256(convert_to($2::jsonb::text,'UTF8')),'hex'),$3,true from fluid_private.api_text_worker_principals where owner_id=$1", [OWNER_A, MULTI_POLICY, MULTI_DEPLOYMENT]);
}
export function availability(db: TestDatabase, owner: string, project: string) {
  return asRole(db, "authenticated", owner, async () => (await db.query<{ result: { status: string; operations: unknown[]; reason?: string } }>("select public.get_strategy_availability($1) result", [project])).rows[0]!.result);
}
export function admit(db: TestDatabase, owner: string, project: string, key = "multi-account-fixture-request", accepted = 122880) {
  return asRole(db, "authenticated", owner, async () => (await db.query<{ result: { id: string; dispatch: { version: 1; jobId: string; policyIdentity: string; deploymentId: string; dispatchIdentity: string } } }>("select public.enqueue_strategy_job($1,1,'strategy.reformulate',$2,$3) result", [project, key, accepted])).rows[0]!.result);
}
export async function multiAccountSnapshot(db: TestDatabase) {
  const snapshot: Record<string, unknown> = {};
  for (const table of ["public.jobs", "public.job_steps", "public.usage_accounts", "public.usage_reservations", "fluid_private.api_text_dispatches",
    "fluid_private.api_text_allowance_rollout", "fluid_private.api_text_allowance_cohorts", "fluid_private.api_text_owner_entitlements",
    "fluid_private.api_text_allowance_admissions", "fluid_private.api_strategy_bindings", "fluid_private.strategy_billing_routes", "fluid_private.api_text_gateway_context"]) {
    snapshot[table] = (await db.query(`select to_jsonb(t) data from ${table} t order by to_jsonb(t)::text`)).rows;
  }
  return snapshot;
}
