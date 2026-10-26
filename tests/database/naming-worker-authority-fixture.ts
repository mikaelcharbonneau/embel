import { OWNER_A, type TestDatabase } from "./local-supabase";
import { brainPolicy, brainWorker, installBrainFixture, seedBrainFixture } from "./naming-brain-fixture";

export const authorityMigration = "20261026161000_naming_worker_authority.sql";
export type WorkerStatus = { version: 1; leader: boolean; generation: number | null; expiresAt: string | null; serverTime: string; ready: boolean; reason: string };
export type AuthorityJob = { id: string; lease_token: string; input: { runId: string } };
export async function installAuthorityFixture(db: TestDatabase) {
  await installBrainFixture(db);
  // Disposable operator grants: fixture logins are created after migration.
  await db.exec(`grant execute on function public.report_naming_brain_worker_status(jsonb,text,text,bigint,integer),
    public.naming_brain_worker_maintenance_v2(text,text,bigint,text,jsonb) to fixture_naming_brain_a,fixture_naming_brain_b`);
}
export async function seedAuthorityFixture(db: TestDatabase) {
  const project = await seedBrainFixture(db);
  await db.query("insert into fluid_private.strategy_billing_routes(owner_id,billing_mode,revision) values($1,'openai_api',1) on conflict(owner_id) do nothing", [OWNER_A]);
  return project;
}
export async function workerStatus(db: TestDatabase, generation: number | null = null, worker = "fixture-worker", policy: unknown = brainPolicy, deployment = "fixture-deployment") {
  return brainWorker(db, async () => (await db.query<{ result: WorkerStatus }>(
    "select public.report_naming_brain_worker_status($1::jsonb,$2,$3,$4::bigint,60) result", [JSON.stringify(policy), deployment, worker, generation])).rows[0]!.result);
}
export async function maintenance<T = unknown>(db: TestDatabase, generation: number, action: string, payload: unknown = {}, worker = "fixture-worker", deployment = "fixture-deployment") {
  return brainWorker(db, async () => (await db.query<{ result: T }>(
    "select public.naming_brain_worker_maintenance_v2($1,$2,$3::bigint,$4,$5::jsonb) result", [worker, deployment, generation, action, JSON.stringify(payload)])).rows[0]!.result);
}
export async function expireAuthority(db: TestDatabase) {
  await db.exec("update fluid_private.naming_worker_leadership set expires_at=clock_timestamp()-interval '1 second'");
}
export const continuePayload = (job: AuthorityJob) => ({ jobId: job.id, leaseToken: job.lease_token });

/** Include tuple headers and full business values, not just the return code. */
export async function authoritySnapshot(db: TestDatabase) {
  const tables = ["public.jobs", "public.job_steps", "public.usage_accounts", "public.usage_reservations", "fluid_private.strategy_billing_routes",
    "fluid_private.naming_brain_pilots", "fluid_private.naming_brain_runs", "fluid_private.naming_worker_leadership", "fluid_private.naming_worker_job_authority",
    "fluid_private.naming_worker_gateway_context", "fluid_private.naming_brain_receipts", "fluid_private.naming_brain_receipt_totals", "fluid_private.naming_brain_receipt_current"];
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = (await db.query(`select xmin::text,xmax::text,ctid::text,to_jsonb(t) value from ${table} t order by to_jsonb(t)::text`)).rows;
  return result;
}
