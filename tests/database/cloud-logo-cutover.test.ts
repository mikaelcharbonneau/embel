import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { logoWorkspaceV2Schema, type LogoWorkspaceV2 } from "../../src/domain/logo-workspace";
import { logoCostQuoteSchema, logoDispatchReceiptSchema } from "../../src/domain/logo-jobs";

const sql = (path: string) => readFile(new URL(`../../supabase/${path}`, import.meta.url), "utf8");
const workerId = "embel-logo-local-20261018", storageUser = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const policy = "175c12bb65f63fe8839b58323ba6e5bbe605d06062a9a708bfdd23efbb8515d5";
const operations = ["identity.logo_concept", "identity.logo_refine"];
const manifest = operations.map(operation => ({ operation, policyIdentity: policy, handlerVersion: "logo-image-v1", provider: "openai",
  model: "gpt-image-2.5-sunburst-2026-09-08", engine: null, maxCostMicrousd: 2_000_000 }));

/** Full disposable PostgreSQL replay. Only live owner/Auth IDs and the role OID
 * are substituted. No network, credentials or live mutation is used. */
describe("cloud Logo cutover operational packets", () => {
  let db: TestDatabase, workspace: LogoWorkspaceV2, request: object, receipt: unknown;
  let freeze: string, enable: string, baseline: string;
  const rpc = (name: string, args: unknown[], owner = OWNER_A) => asRole(db, "authenticated", owner,
    async () => (await db.query<{ value: unknown }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`, args)).rows[0]!.value);
  async function worker<T>(run: () => Promise<T>) {
    await db.exec("set session authorization fluid_logo_worker");
    try { return await run(); } finally { await db.exec("set session authorization postgres"); }
  }
  const ready = () => worker(() => db.query<{ value: boolean }>("select public.report_logo_worker_ready($1,$2,90) value", [workerId, manifest]));
  const claim = () => worker(() => db.query<{ id: string; lease_token: string; plan_manifest: { key: string }[] }>("select * from public.claim_logo_job($1,60)", [workerId]));
  async function reject(packet: string, message: string) {
    await db.exec("savepoint rejected_cutover");
    await expect(db.exec(packet)).rejects.toThrow(message);
    await db.exec("rollback to savepoint rejected_cutover; release savepoint rejected_cutover");
  }
  async function snapshot() {
    const tables = (await db.query<{ name: string }>(`select quote_ident(n.nspname)||'.'||quote_ident(c.relname) name from pg_class c
      join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','fluid_private','storage') and c.relkind='r'
      and c.relname not in('logo_runtime_policies','logo_local_capabilities','logo_storage_principals','logo_generative_storage_capabilities','logo_worker_readiness') order by 1`)).rows;
    const result: Record<string, unknown> = {};
    for (const { name } of tables) result[name] = (await db.query(`select to_jsonb(t) data from ${name} t order by to_jsonb(t)::text`)).rows;
    result.functionSecurity = (await db.query("select oid,proacl,proowner,prosecdef,proconfig,prosrc from pg_proc order by oid")).rows;
    result.roles = (await db.query("select oid,rolname,rolcanlogin,rolinherit,rolsuper,rolbypassrls,rolconnlimit from pg_roles order by oid")).rows;
    return result;
  }
  beforeAll(async () => {
    db = await createTestDatabase(); await resetFixture(db);
    await db.exec(`alter table auth.users add column is_anonymous boolean not null default false;
      create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant execute on function auth.jwt() to authenticated;
      alter table storage.objects add column metadata jsonb not null default '{}',add column created_at timestamptz not null default clock_timestamp(),add column version text;`);
    for (const path of ["candidates/logo_worker_storage.sql", "candidates/logo_generative_storage.sql", "activation/logo_concepts_20_storage.sql",
      "candidates/logo_local_concepts.sql", "activation/logo_concepts_40_download_metadata.sql", "activation/logo_concepts_50_publication_adjudication.sql"])
      await db.exec(await sql(path));
    workspace = logoWorkspaceV2Schema.parse(await rpc("start_logo_project", [{ requestKey: randomUUID(), brief: {
      name: "Synthetic cloud Logo cutover", activity: "Disposable local tests", audience: "Testers", personality: "Precise", logoTypes: ["wordmark"],
    } }]));
    await db.query("select set_config('embel.logo_owner_id',$1,false),set_config('embel.logo_project_id',$2,false)", [OWNER_A, workspace.projectId]);
    await db.exec(await sql("activation/logo_concepts_10_principals.sql"));
    await db.query("insert into auth.users(id) values($1)", [storageUser]);
    for (const [key, value] of Object.entries({ logo_storage_user_id: storageUser, logo_worker_id: workerId,
      logo_policy_identity: policy, logo_reservation_microusd: "2000000" }))
      await db.query("select set_config($1,$2,false)", [`embel.${key}`, value]);
    await db.exec(await sql("activation/logo_concepts_30_bind_disabled.sql"));
    await db.exec(`update fluid_private.logo_runtime_policies set enabled=true; update fluid_private.logo_storage_principals set enabled=true;
      update fluid_private.logo_generative_storage_capabilities set enabled=true; update fluid_private.logo_local_capabilities set enabled=true;`);
    await db.exec(await sql("candidates/logo_local_refinements.sql"));
    await db.exec(await sql("activation/logo_refinements_10_activate.sql"));
    await ready();
    const brief = workspace.stages.brief_references!;
    const snapshotId = (await db.query<{ id: string }>("select reference_snapshot_id id from public.logo_stage_revisions where id=$1", [brief.id])).rows[0]!.id;
    const quote = logoCostQuoteSchema.parse(await rpc("local_logo_operation", [workspace.projectId, "quote", {
      operation: "concepts", expected: workspace.heads, briefRevisionId: brief.id, referenceSnapshotId: snapshotId,
    }]));
    request = { requestKey: randomUUID(), quoteId: quote.id, acceptedMaxCostMicrousd: quote.maxCostMicrousd, expected: workspace.heads };
    receipt = logoDispatchReceiptSchema.parse(await rpc("local_logo_operation", [workspace.projectId, "admit", request]));
    const roleOid = (await db.query<{ oid: number }>("select oid from pg_roles where rolname='fluid_logo_worker'")).rows[0]!.oid;
    const fixture = (source: string) => source.replaceAll("6840f4c2-15a6-45a7-97be-41e7e5e37f42", OWNER_A)
      .replaceAll("853fa383-9606-4577-924f-966194dc2f67", storageUser).replace("r constant oid:=25288", `r constant oid:=${roleOid}`)
      .replace(/^begin(?: read only)?;$/m, "").replace(/^commit;$/m, "");
    freeze = fixture(await sql("candidates/cloud_logo_cutover_freeze.sql"));
    enable = fixture(await sql("candidates/cloud_logo_cutover_enable.sql"));
    baseline = fixture(await sql("candidates/cloud_logo_cutover_baseline.sql"));
  }, 120_000);
  beforeEach(async () => { await db.exec("begin"); await ready(); });
  afterEach(async () => { await db.exec("rollback; set session authorization postgres; reset role"); });
  afterAll(async () => { await db?.close(); });

  it("freezes and enables only six operational flags; preserves every other row and security definition", async () => {
    const before = await snapshot();
    await db.exec(freeze); await db.exec(freeze);
    expect((await db.query("select * from fluid_private.logo_worker_readiness")).rows).toEqual([]);
    expect((await ready()).rows[0]!.value).toBe(false);
    expect((await claim()).rows).toEqual([]);
    expect(await rpc("local_logo_operation", [workspace.projectId, "admit", request])).toEqual(receipt);
    await db.exec(enable); await db.exec(enable);
    expect((await db.query("select * from fluid_private.logo_worker_readiness")).rows).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect((await ready()).rows[0]!.value).toBe(true);
    expect((await claim()).rows).toHaveLength(1);
  });
  it("repeating enable after cloud claims is a no-op and never clears its lease or heartbeat", async () => {
    await db.exec(freeze); await db.exec(enable); await ready(); await claim();
    const before = await snapshot(), readiness = (await db.query("select * from fluid_private.logo_worker_readiness order by operation")).rows;
    await db.exec(enable);
    expect(await snapshot()).toEqual(before);
    expect((await db.query("select * from fluid_private.logo_worker_readiness order by operation")).rows).toEqual(readiness);
  });
  it("produces only counts, digests, readiness and blocker counts in its preservation baseline", async () => {
    const results = await db.exec(baseline);
    const value = results.find(result => result.rows.length)?.rows[0]?.baseline as { preservation: unknown[]; blockers: object; pending_steps: number };
    expect(value.preservation).toHaveLength(39);
    expect(value.blockers).toEqual({ active_or_leased: 0, queued: 6, total: 6 });
    expect(value.pending_steps).toBe(0);
    expect(JSON.stringify(value)).not.toContain("Synthetic cloud Logo cutover");
  });
  it("continues to deny a different account", async () => {
    await asRole(db, "authenticated", OWNER_B, async () => {
      await db.exec("savepoint other_owner");
      await expect(db.query("select public.local_logo_operation($1,'admit',$2)", [workspace.projectId, request])).rejects.toMatchObject({ code: "P0002" });
      await db.exec("rollback to savepoint other_owner; release savepoint other_owner");
    });
  });
  it("rejects an unavailable image model at the existing policy constraint", async () => {
    await reject("update fluid_private.logo_runtime_policies set model='wrong-model'", "logo_runtime_policies_check1");
  });
  for (const [label, mutation, message] of [
    ["owner binding", `update fluid_private.logo_local_capabilities set owner_id='${OWNER_B}'`, "query returned no rows"],
    ["role OID", "update fluid_private.logo_local_capabilities set role_oid=1", "cloud_logo_binding_mismatch"],
    ["worker identity", "update fluid_private.logo_storage_principals set worker_id='other-worker'", "cloud_logo_binding_mismatch"],
    ["policy identity", "update fluid_private.logo_runtime_policies set policy_identity=repeat('b',64)", "cloud_logo_policy_mismatch"],
    ["reservation", "update fluid_private.logo_runtime_policies set max_cost_microusd=1", "cloud_logo_policy_mismatch"],
    ["unexpected operation", "delete from fluid_private.logo_generative_storage_capabilities where operation='identity.logo_refine'", "cloud_logo_policy_mismatch"],
    ["partial enabled state", "update fluid_private.logo_storage_principals set enabled=false", "cloud_logo_unexpected_freeze_state"],
    ["role membership", "grant authenticated to fluid_logo_worker", "cloud_logo_binding_mismatch"],
    ["role inheritance", "alter role fluid_logo_worker inherit", "cloud_logo_binding_mismatch"],
    ["connection limit drift", "alter role fluid_logo_worker connection limit 4", "cloud_logo_binding_mismatch"],
    ["table grant", "grant select on public.jobs to fluid_logo_worker", "cloud_logo_privilege_drift"],
    ["column grant", "grant select(id) on public.jobs to fluid_logo_worker", "cloud_logo_privilege_drift"],
    ["function grant", "grant execute on function public.get_logo_workspace(uuid) to fluid_logo_worker", "cloud_logo_privilege_drift"],
    ["function ACL", "grant execute on function public.local_logo_operation(uuid,text,jsonb) to anon", "cloud_logo_function_drift"],
    ["function owner", "alter function public.local_logo_operation(uuid,text,jsonb) owner to service_role", "cloud_logo_function_drift"],
    ["function search path", "alter function public.local_logo_operation(uuid,text,jsonb) set search_path=public", "cloud_logo_function_drift"],
    ["function security mode", "alter function public.local_logo_operation(uuid,text,jsonb) security invoker", "cloud_logo_function_drift"],
    ["function drift", "create or replace function fluid_private.logo_local_project_clear(p_owner uuid,p_project uuid) returns boolean language sql stable set search_path='' as $$select true$$", "cloud_logo_function_drift"],
  ]) it(`rejects ${label} before changing any row`, async () => {
    await db.exec(mutation!); const before = await snapshot();
    await reject(freeze, message!); expect(await snapshot()).toEqual(before);
  });
  it("refuses a current or expired but uncleared execution lease", async () => {
    await claim(); await reject(freeze, "cloud_logo_active_or_unresolved_work");
    await db.exec("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 hour' where state='running'");
    await reject(freeze, "cloud_logo_active_or_unresolved_work");
  });
  it("refuses in-flight or ambiguous provider outcomes after a cleared lease", async () => {
    const job = (await claim()).rows[0]!;
    await worker(() => db.query("select public.begin_logo_job_step($1,$2,$3,$4,2000000)", [job.id, job.lease_token, job.plan_manifest[0]!.key, `${job.id}:test`]));
    await db.query("update public.jobs set state='failed',lease_token=null,lease_expires_at=null where id=$1", [job.id]);
    await reject(freeze, "cloud_logo_pending_provider_outcome");
    await db.query("update public.job_steps set state='ambiguous' where job_id=$1", [job.id]);
    await reject(freeze, "cloud_logo_pending_provider_outcome");
  });
  it("rechecks active work between freeze and enable", async () => {
    await db.exec(freeze);
    await db.exec("update public.jobs set state='needs_reconciliation' where id=(select id from public.jobs limit 1)");
    await reject(enable, "cloud_logo_active_or_unresolved_work");
  });
  it("rejects partial re-enablement", async () => {
    await db.exec(freeze); await db.exec("update fluid_private.logo_storage_principals set enabled=true");
    await reject(enable, "cloud_logo_not_exactly_frozen");
  });
});
