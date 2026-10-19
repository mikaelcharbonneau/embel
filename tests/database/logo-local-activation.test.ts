import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { logoWorkspaceV2Schema } from "../../src/domain/logo-workspace";
import { logoCostQuoteSchema, logoDispatchReceiptSchema } from "../../src/domain/logo-jobs";

const sql = (path: string) => readFile(new URL(`../../supabase/${path}`, import.meta.url), "utf8");
describe("minimal local logo activation rehearsal (no network or credentials)", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase(); await resetFixture(db);
    await db.exec(`alter table auth.users add column is_anonymous boolean not null default false;
      create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant execute on function auth.jwt() to authenticated;`);
    await db.exec(await sql("candidates/logo_worker_storage.sql"));
    await db.exec(await sql("candidates/logo_generative_storage.sql"));
    await db.exec(await sql("activation/logo_concepts_20_storage.sql"));
    await db.exec("create role fixture_logo_default_grantee nologin; alter default privileges grant all on tables to fixture_logo_default_grantee; alter default privileges grant all on functions to fixture_logo_default_grantee");
    await db.exec(await sql("candidates/logo_local_concepts.sql"));
    await db.exec("alter default privileges revoke all on tables from fixture_logo_default_grantee; alter default privileges revoke all on functions from fixture_logo_default_grantee");
  }, 60_000);
  afterAll(async () => { await db?.close(); });
  const rpc = (name: string, args: unknown[], owner = OWNER_A) => asRole(db, "authenticated", owner,
    async () => (await db.query<{ value: unknown }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`, args)).rows[0]!.value);
  it("binds only one passwordless worker, keeps activation disabled, and preserves six owned durable jobs", async () => {
    const workspace = logoWorkspaceV2Schema.parse(await rpc("start_logo_project", [{ requestKey: randomUUID(), brief: {
      name: "Synthetic logo setup", activity: "Local rehearsal", audience: "Testers", personality: "Precise", logoTypes: ["wordmark"],
    } }]));
    await db.query("select set_config('embel.logo_owner_id',$1,false),set_config('embel.logo_project_id',$2,false)", [OWNER_B, workspace.projectId]);
    await expect(db.exec(await sql("activation/logo_concepts_10_principals.sql"))).rejects.toThrow("verified_logo_owner_project_required");
    await db.exec("rollback");
    expect((await db.query("select rolname from pg_roles where rolname like 'fluid_logo%'")).rows).toEqual([]);
    await db.query("select set_config('embel.logo_owner_id',$1,false)", [OWNER_A]);
    await db.exec(await sql("activation/logo_concepts_10_principals.sql"));
    expect((await db.query("select rolname,rolpassword from pg_authid where rolname like 'fluid_logo%'")).rows).toEqual([{ rolname: "fluid_logo_worker", rolpassword: null }]);
    expect((await db.query("select * from fluid_private.logo_asset_web_principals")).rows).toEqual([]);
    expect((await db.query("select * from pg_auth_members where member='fluid_logo_worker'::regrole")).rows).toEqual([]);
    expect((await db.query("select has_table_privilege('fluid_logo_worker','public.jobs','SELECT,INSERT,UPDATE,DELETE') allowed")).rows[0]).toEqual({ allowed: false });
    expect((await db.query("select has_function_privilege('fluid_logo_worker','public.stage_logo_exports(uuid,uuid,jsonb)','EXECUTE') allowed")).rows[0]).toEqual({ allowed: false });
    const grants = (await db.query<{ name: string }>("select p.proname name from pg_proc p cross join lateral aclexplode(p.proacl) a where a.grantee='fluid_logo_worker'::regrole and a.privilege_type='EXECUTE' order by p.proname")).rows.map(row => row.name);
    expect(grants).toEqual(["begin_logo_job_step", "claim_logo_job", "complete_logo_job_step", "expire_logo_job_leases", "finish_logo_job", "heartbeat_logo_job", "logo_worker_owner", "observe_logo_asset", "prepare_logo_asset", "read_leased_logo_record", "read_logo_asset_publication", "record_logo_provider_response", "register_logo_job_plan", "report_logo_worker_ready"]);
    for (const table of ["logo_local_context", "logo_local_jobs", "logo_local_capabilities"])
      expect((await db.query("select has_table_privilege('fixture_logo_default_grantee',$1,'SELECT,INSERT,UPDATE,DELETE') allowed", [`fluid_private.${table}`])).rows[0]).toEqual({ allowed: false });
    expect((await db.query("select has_function_privilege('fixture_logo_default_grantee','public.local_logo_operation(uuid,text,jsonb)','EXECUTE') allowed")).rows[0]).toEqual({ allowed: false });
    const storageUser = randomUUID(), workerId = "synthetic-logo-local", policyIdentity = "a".repeat(64);
    await db.query("insert into auth.users(id) values($1)", [storageUser]);
    for (const [key, value] of Object.entries({ logo_storage_user_id: storageUser, logo_worker_id: workerId, logo_policy_identity: policyIdentity, logo_reservation_microusd: "100" }))
      await db.query("select set_config($1,$2,false)", [`embel.${key}`, value]);
    await db.exec(await sql("activation/logo_concepts_30_bind_disabled.sql"));
    expect((await db.query("select enabled from fluid_private.logo_runtime_policies")).rows).toEqual([{ enabled: false }]);
    expect((await db.query("select enabled from fluid_private.logo_storage_principals")).rows).toEqual([{ enabled: false }]);
    expect((await db.query("select enabled from fluid_private.logo_generative_storage_capabilities")).rows).toEqual([{ enabled: false }]);
    expect((await db.query("select enabled from fluid_private.logo_local_capabilities")).rows).toEqual([{ enabled: false }]);
    const manifest = [{ operation: "identity.logo_concept", policyIdentity, handlerVersion: "logo-image-v1", provider: "openai", model: "gpt-image-2.5-sunburst-2026-09-08", engine: null, maxCostMicrousd: 100 }];
    await db.exec("set session authorization fluid_logo_worker");
    expect((await db.query("select public.report_logo_worker_ready($1,$2,60) ready", [workerId, manifest])).rows[0]).toEqual({ ready: false });
    await db.exec("set session authorization postgres");
    // Explicit fixture-only enablement proves the prepared grants are enough.
    await db.exec("update fluid_private.logo_runtime_policies set enabled=true");
    await db.exec("set session authorization fluid_logo_worker");
    expect((await db.query("select fluid_private.logo_worker_owner() owner_id")).rows[0]).toEqual({ owner_id: OWNER_A });
    expect((await db.query("select public.report_logo_worker_ready($1,$2,60) ready", [workerId, manifest])).rows[0]).toEqual({ ready: true });
    await db.exec("set session authorization postgres");
    const brief = workspace.stages.brief_references!;
    const snapshotId = (await db.query<{ reference_snapshot_id: string }>("select reference_snapshot_id from public.logo_stage_revisions where id=$1", [brief.id])).rows[0]!.reference_snapshot_id;
    const quote = logoCostQuoteSchema.parse(await rpc("quote_logo_operation", [workspace.projectId, { operation: "concepts", expected: workspace.heads,
      briefRevisionId: brief.id, referenceSnapshotId: snapshotId }]));
    const request = { requestKey: randomUUID(), quoteId: quote.id, acceptedMaxCostMicrousd: quote.maxCostMicrousd, expected: workspace.heads };
    await expect(rpc("admit_logo_operation", [workspace.projectId, request], OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    const receipt = logoDispatchReceiptSchema.parse(await rpc("admit_logo_operation", [workspace.projectId, request]));
    expect(receipt.jobIds).toHaveLength(6);
    expect(await rpc("admit_logo_operation", [workspace.projectId, request])).toEqual(receipt);
    expect((await db.query("select count(*)::integer n from public.jobs")).rows[0]).toEqual({ n: 6 });
    await db.exec("set session authorization fluid_logo_worker");
    const claimed = (await db.query<{ id: string; owner_id: string }>("select * from public.claim_logo_job($1,60)", [workerId])).rows[0]!;
    expect(claimed.owner_id).toBe(OWNER_A); expect(receipt.jobIds).toContain(claimed.id);
    await db.exec("set session authorization postgres");

    // Reproduce the real local account's exhausted legacy allowance. The local
    // wrapper must preserve it, while ordinary admission remains blocked.
    await db.exec("update public.usage_accounts set limit_microusd=0 where owner_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; update fluid_private.logo_local_capabilities set enabled=true");
    const quoteInput = { operation: "concepts", expected: workspace.heads, briefRevisionId: brief.id, referenceSnapshotId: snapshotId };
    const localQuote = logoCostQuoteSchema.parse(await rpc("local_logo_operation", [workspace.projectId, "quote", quoteInput]));
    const ordinary = { ...request, requestKey: randomUUID(), quoteId: localQuote.id };
    expect(await rpc("admit_logo_operation", [workspace.projectId, ordinary])).toMatchObject({ kind: "logo_admission_rejected" });
    const localRequest = { ...ordinary, requestKey: randomUUID() };
    const localReceipt = logoDispatchReceiptSchema.parse(await rpc("local_logo_operation", [workspace.projectId, "admit", localRequest]));
    expect(localReceipt.jobIds).toHaveLength(6);
    expect(await rpc("local_logo_operation", [workspace.projectId, "admit", localRequest])).toEqual(localReceipt);
    expect((await db.query<{ job_id: string }>("select job_id from fluid_private.logo_local_jobs order by job_id")).rows.map(row => row.job_id).sort()).toEqual([...localReceipt.jobIds].sort());
    expect((await db.query("select * from fluid_private.logo_local_context")).rows).toEqual([]);
    expect((await db.query("select limit_microusd,spent_microusd,reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows[0])
      .toEqual({ limit_microusd: 0, spent_microusd: 0, reserved_microusd: 1200 });
    await expect(rpc("local_logo_operation", [workspace.projectId, "capabilities", null], OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await expect(asRole(db,"authenticated",OWNER_A,()=>db.query("insert into fluid_private.logo_local_context values(pg_backend_pid(),txid_current(),$1,$2)",[OWNER_A,workspace.projectId]))).rejects.toMatchObject({ code: "42501" });
    await db.exec(`create role fluid_logo_worker_other login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      grant usage on schema public,fluid_private to fluid_logo_worker_other;
      grant execute on function public.report_logo_worker_ready(text,jsonb,integer),public.claim_logo_job(text,integer) to fluid_logo_worker_other;
      insert into fluid_private.logo_worker_principals select rolname,oid,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid from pg_roles where rolname='fluid_logo_worker_other';
      set session authorization fluid_logo_worker_other`);
    expect((await db.query("select public.report_logo_worker_ready($1,$2,60) ready", ["other-local-worker", manifest])).rows[0]).toEqual({ ready: true });
    expect((await db.query("select * from public.claim_logo_job($1,60)", ["other-local-worker"])).rows).toEqual([]);
    await db.exec("set session authorization postgres");
    await db.exec("set session authorization fluid_logo_worker");
    expect((await db.query("select public.report_logo_worker_ready($1,$2,60) ready", ["wrong-worker-id", manifest])).rows[0]).toEqual({ ready: true });
    expect((await db.query("select * from public.claim_logo_job($1,60)", ["wrong-worker-id"])).rows).toEqual([]);
    expect((await db.query("select public.report_logo_worker_ready($1,$2,60) ready", [workerId, manifest])).rows[0]).toEqual({ ready: true });
    const localJob = (await db.query<{ id: string; lease_token: string; plan_manifest: { key: string }[] }>("select * from public.claim_logo_job($1,60)", [workerId])).rows[0]!;
    expect(localReceipt.jobIds).toContain(localJob.id);
    const key = localJob.plan_manifest[0]!.key;
    expect((await db.query("select public.begin_logo_job_step($1,$2,$3,$4,100) value", [localJob.id,localJob.lease_token,key,`${localJob.id}:${key}`])).rows[0]).toEqual({ value: "started" });
    await db.query("select public.complete_logo_job_step($1,$2,$3,'ambiguous',0,$4,null)", [localJob.id,localJob.lease_token,key,{error:"provider_outcome_unknown"}]);
    expect((await db.query("select * from public.claim_logo_job($1,60)", [workerId])).rows).toEqual([]);
    await db.exec("set session authorization postgres");
    await expect(rpc("local_logo_operation", [workspace.projectId, "quote", quoteInput])).rejects.toMatchObject({ code: "55000" });
    await db.exec("update fluid_private.logo_local_capabilities set enabled=false");
    expect(await rpc("local_logo_operation", [workspace.projectId, "admit", localRequest])).toEqual(localReceipt);
    expect((await db.query("select count(*)::integer n from fluid_private.logo_local_jobs")).rows[0]).toEqual({ n: 6 });
  });
});
