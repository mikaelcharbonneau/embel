import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { legacyLogoCostQuoteSchema as logoCostQuoteSchema, logoDispatchReceiptSchema, type LogoConceptJobInput } from "../../src/domain/logo-jobs";
import { logoWorkspaceV2Schema } from "../../src/domain/logo-workspace";

const table = "fluid_private.logo_publication_failure_adjudications";
const workerRole = "fluid_logo_worker";
const workerId = "synthetic-publication-adjudication";
const storageUser = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const policyIdentity = "a".repeat(64);
const candidatePath = new URL("../../supabase/activation/logo_concepts_50_publication_adjudication.sql", import.meta.url);
const sql = (path: string) => readFile(new URL(`../../supabase/${path}`, import.meta.url), "utf8");
const decision = "operator-decision:synthetic-local-publication-test";
const reason = "The exact uploaded synthetic object was never committed as a selectable asset.";

/** Disposable PostgreSQL only. The real admission, publication reservation,
 * Storage authorization and ambiguous-completion paths produce this fixture.
 * Only the candidate's five incident hashes are replaced by synthetic hashes;
 * no hosted data, credentials, image generation or live database is involved. */
describe("exact uncommitted logo publication adjudication", () => {
  let db: TestDatabase;
  let projectId: string;
  let jobId: string;
  let lease: string;
  let stepKey: string;
  let stepId: string;
  let providerId: string;
  let publicationId: string;
  let siblingId: string;
  let providerRequestId: string;
  let originalSecurity: unknown;
  let installedSecurity: unknown;

  const rpc = (name: string, args: unknown[], owner = OWNER_A) => asRole(db, "authenticated", owner,
    async () => (await db.query<{ value: unknown }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`, args)).rows[0]!.value);
  const worker = async <T>(run: () => Promise<T>) => {
    await db.exec(`set session authorization ${workerRole}`);
    try { return await run(); } finally { await db.exec("set session authorization postgres"); }
  };
  const workerQuery = <T>(query: string, args: unknown[] = []) => worker(() => db.query<T>(query, args));
  const security = async () => (await db.query(`
    select p.oid,p.proacl,p.proowner,p.prosecdef,p.provolatile,p.proconfig,p.proleakproof
    from pg_proc p where p.oid='fluid_private.logo_local_project_clear(uuid,uuid)'::regprocedure
  `)).rows;
  const matches = async () => (await db.query<{ value: boolean }>(
    "select fluid_private.logo_publication_failure_adjudication_matches($1) value", [jobId])).rows[0]!.value;
  const clear = async () => (await db.query<{ value: boolean }>(
    "select fluid_private.logo_local_project_clear($1,$2) value", [OWNER_A, projectId])).rows[0]!.value;
  const adjudicate = (id = jobId, reference: string | null = decision) => db.query(
    `insert into ${table}(job_id,operator_decision_reference,reason) values($1,$2,$3)`, [id, reference, reason]);
  const snapshot = async () => {
    const result: Record<string, Array<{ data: Record<string, unknown> }>> = {};
    for (const relation of ["public.projects", "public.project_revisions", "public.jobs", "public.job_steps", "public.usage_accounts",
      "public.usage_reservations", "public.logo_provider_responses", "public.logo_asset_publications", "public.assets", "public.asset_versions",
      "public.logo_raster_results", "public.logo_operation_requests", "public.logo_cost_quotes", "public.logo_concept_attempts",
      "storage.objects", "fluid_private.logo_local_jobs", "fluid_private.logo_generative_storage_grants", table]) {
      result[relation] = (await db.query<{ data: Record<string, unknown> }>(`select to_jsonb(t) data from ${relation} t order by to_jsonb(t)::text`)).rows;
    }
    return result;
  };
  async function rejected(run: () => Promise<unknown>) {
    await db.exec("savepoint rejected_adjudication");
    let error: unknown;
    try { await run(); } catch (caught) { error = caught; }
    await db.exec("rollback to savepoint rejected_adjudication; release savepoint rejected_adjudication");
    expect(error).toBeDefined();
  }
  async function tamper(query: string, args: unknown[]) {
    // Explicit fixture-only corruption checks the enduring witness. Production
    // history triggers and all ACLs remain installed and enabled after the seed.
    await db.exec("set session_replication_role=replica");
    try { await db.query(query, args); } finally { await db.exec("set session_replication_role=origin"); }
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    await db.exec("set timezone='UTC'");
    await resetFixture(db);
    await db.exec(`alter table auth.users add column is_anonymous boolean not null default false;
      create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant execute on function auth.jwt() to authenticated;
      alter table storage.objects add column metadata jsonb not null default '{}',add column created_at timestamptz not null default clock_timestamp(),add column version text;
    `);
    for (const path of ["candidates/logo_worker_storage.sql", "candidates/logo_generative_storage.sql", "activation/logo_concepts_20_storage.sql", "candidates/logo_local_concepts.sql"])
      await db.exec(await sql(path));
    const workspace = logoWorkspaceV2Schema.parse(await rpc("start_logo_project", [{ requestKey: randomUUID(), brief: {
      name: "Synthetic publication recovery", activity: "Local tests", audience: "Testers", personality: "Precise", logoTypes: ["wordmark"],
    } }]));
    projectId = workspace.projectId;
    await db.query("select set_config('embel.logo_owner_id',$1,false),set_config('embel.logo_project_id',$2,false)", [OWNER_A, projectId]);
    await db.exec(await sql("activation/logo_concepts_10_principals.sql"));
    await db.query("insert into auth.users(id) values($1)", [storageUser]);
    await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [sessionId, storageUser]);
    for (const [key, value] of Object.entries({ logo_storage_user_id: storageUser, logo_worker_id: workerId, logo_policy_identity: policyIdentity, logo_reservation_microusd: "100" }))
      await db.query("select set_config($1,$2,false)", [`embel.${key}`, value]);
    await db.exec(await sql("activation/logo_concepts_30_bind_disabled.sql"));
    await db.exec(`update fluid_private.logo_runtime_policies set enabled=true;
      update fluid_private.logo_storage_principals set enabled=true;
      update fluid_private.logo_generative_storage_capabilities set enabled=true;
      update fluid_private.logo_local_capabilities set enabled=true;`);
    const manifest = [{ operation: "identity.logo_concept", policyIdentity, handlerVersion: "logo-image-v1", provider: "openai", model: "gpt-image-2.5-sunburst-2026-09-08", engine: null, maxCostMicrousd: 100 }];
    expect((await workerQuery<{ ready: boolean }>("select public.report_logo_worker_ready($1,$2,90) ready", [workerId, manifest])).rows[0]!.ready).toBe(true);
    const brief = workspace.stages.brief_references!;
    const referenceSnapshot = (await db.query<{ id: string }>("select reference_snapshot_id id from public.logo_stage_revisions where id=$1", [brief.id])).rows[0]!.id;
    const quote = logoCostQuoteSchema.parse(await rpc("local_logo_operation", [projectId, "quote", {
      operation: "concepts", expected: workspace.heads, briefRevisionId: brief.id, referenceSnapshotId: referenceSnapshot,
    }]));
    const admission = logoDispatchReceiptSchema.parse(await rpc("local_logo_operation", [projectId, "admit", {
      requestKey: randomUUID(), quoteId: quote.id, acceptedMaxCostMicrousd: quote.maxCostMicrousd, expected: workspace.heads,
    }]));
    const job = (await workerQuery<{ id: string; lease_token: string; input: LogoConceptJobInput }>("select * from public.claim_logo_job($1,300)", [workerId])).rows[0]!;
    jobId = job.id; lease = job.lease_token; siblingId = admission.jobIds.find(id => id !== jobId)!;
    stepKey = `logo-preview-v1:${job.input.slotId}:${job.input.attemptId}`;
    await workerQuery("select public.begin_logo_job_step($1,$2,$3,$4,100)", [jobId, lease, stepKey, `synthetic:${jobId}`]);
    const bytes = Buffer.from("Explicit synthetic uncommitted PNG fixture bytes; no actual artwork.");
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    providerRequestId = `synthetic-provider-${jobId}`;
    providerId = (await workerQuery<{ value: { id: string } }>("select public.record_logo_provider_response($1,$2,$3) value", [jobId, lease, {
      provider: "openai", model: "gpt-image-2.5-sunburst-2026-09-08", providerRequestId, responseHash: "c".repeat(64),
      observedAt: new Date().toISOString(), billing: { status: "recorded", confirmedMicrousd: 15 }, artifactHash: contentHash, normalizedPixelHash: "d".repeat(64),
    }])).rows[0]!.value.id;
    const inputRevisions = (await workerQuery<{ value: unknown }>("select public.read_leased_logo_record($1,$2,'input_revisions',null) value", [jobId, lease])).rows[0]!.value;
    const publication = { requestKey: job.input.attemptId, inputRevisions, mimeType: "image/png", contentHash, byteLength: bytes.length, source: { kind: "concept", sourceId: job.input.attemptId } };
    const reservation = (await workerQuery<{ value: { id: string; storagePath: string } }>("select fluid_private.prepare_logo_asset($1,$2,$3,$4) value", [projectId, { kind: "stage", publication }, jobId, lease])).rows[0]!.value;
    publicationId = reservation.id;
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: storageUser, session_id: sessionId, role: "authenticated", aud: "authenticated", iss: "https://fricsfwqibyhemknqgyf.supabase.co/auth/v1", is_anonymous: false, exp: Math.floor(Date.now() / 1000) + 3600 })]);
    await asRole(db, "authenticated", storageUser, async () => {
      await db.query("select public.authorize_logo_generative_storage($1,$2,$3,'write')", [jobId, lease, publicationId]);
      await db.query("select set_config('storage.operation','object.upload',false)");
      await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata,version) values('fluid-assets',$1,$2,$3,$4)", [reservation.storagePath, storageUser, { size: bytes.length, mimetype: "image/png", contentLength: bytes.length }, randomUUID()]);
    });
    await db.query("select set_config('request.jwt.claims','',false)");
    await workerQuery("select public.complete_logo_job_step($1,$2,$3,'ambiguous',15,$4,$5)", [jobId, lease, stepKey, { error: "publication_unknown" }, providerRequestId]);
    stepId = (await db.query<{ id: string }>("select id from public.job_steps where job_id=$1", [jobId])).rows[0]!.id;
    expect(await clear()).toBe(false);
    const pins = [
      ["pinned_job_sha256", "public.jobs", "id", jobId],
      ["pinned_step_sha256", "public.job_steps", "id", stepId],
      ["pinned_provider_sha256", "public.logo_provider_responses", "id", providerId],
      ["pinned_publication_sha256", "public.logo_asset_publications", "id", publicationId],
      ["pinned_reservation_sha256", "public.usage_reservations", "job_id", jobId],
    ];
    let candidate = await readFile(candidatePath, "utf8");
    for (const [name, relation, key, id] of pins) {
      const digest = (await db.query<{ hash: string }>(`select encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') hash from ${relation} t where ${key}=$1`, [id])).rows[0]!.hash;
      const literal = new RegExp(`(${name}\\s+(?:constant\\s+)?text\\s*(?::=|default)\\s*)'[a-f0-9]{64}'`, "i");
      expect(candidate, `Missing uniquely named incident pin: ${name}`).toMatch(literal);
      candidate = candidate.replace(literal, `$1'${digest}'`);
    }
    originalSecurity = await security();
    await db.exec("create role fixture_logo_adjudication_default nologin; alter default privileges in schema fluid_private grant all on tables to fixture_logo_adjudication_default; alter default privileges in schema fluid_private grant all on functions to fixture_logo_adjudication_default");
    await db.exec(candidate);
    installedSecurity = await security();
  }, 120_000);
  beforeEach(async () => { await db.exec("begin"); });
  afterEach(async () => { await db.exec("rollback; set session authorization postgres; reset role"); });
  afterAll(async () => { await db?.close(); }, 30_000);

  it("installs no decision and preserves the existing gate security without new worker or client grants", async () => {
    expect(installedSecurity).toEqual(originalSecurity);
    expect((await db.query(`select * from ${table}`)).rows).toEqual([]);
    expect(await matches()).toBe(false); expect(await clear()).toBe(false);
    for (const role of ["anon", "authenticated", "service_role", workerRole, "fixture_logo_adjudication_default"]) {
      expect((await db.query<{ allowed: boolean }>("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed", [role, table])).rows[0]!.allowed).toBe(false);
      expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'fluid_private.logo_publication_failure_adjudication_matches(uuid)','EXECUTE') allowed", [role])).rows[0]!.allowed).toBe(false);
    }
    expect((await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass", [table])).rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it("rejects client, cross-owner, worker, missing-decision and wrong-incident attempts atomically", async () => {
    const before = await snapshot();
    for (const role of ["authenticated", "anon", "service_role"] as const)
      await asRole(db, role, OWNER_B, () => rejected(() => adjudicate()));
    await worker(() => rejected(() => adjudicate()));
    await rejected(() => adjudicate(randomUUID()));
    await rejected(() => adjudicate(siblingId));
    await rejected(() => adjudicate(jobId, null));
    await rejected(() => adjudicate(jobId, ""));
    expect(await snapshot()).toEqual(before);
  });

  it("preserves all historical evidence, marks only the job failed and releases only the unused reservation once", async () => {
    const before = await snapshot();
    await adjudicate();
    const after = await snapshot();
    for (const relation of Object.keys(before).filter(key => !["public.jobs", "public.usage_accounts", "public.usage_reservations", table].includes(key)))
      expect(after[relation], relation).toEqual(before[relation]);
    const withoutTerminal = (rows: Array<{ data: Record<string, unknown> }>) => rows.map(({ data }) => {
      if (data.id !== jobId) return data;
      const copy = { ...data }; delete copy.state; delete copy.error_code; delete copy.finished_at; return copy;
    });
    expect(withoutTerminal(after["public.jobs"]!)).toEqual(withoutTerminal(before["public.jobs"]!));
    expect((await db.query("select state,error_code,finished_at is not null finished,actual_cost_microusd from public.jobs where id=$1", [jobId])).rows)
      .toEqual([{ state: "failed", error_code: "publication_not_committed", finished: true, actual_cost_microusd: 15 }]);
    expect((await db.query("select state,reserved_microusd,actual_microusd,captured_microusd from public.usage_reservations where job_id=$1", [jobId])).rows)
      .toEqual([{ state: "settled", reserved_microusd: 100, actual_microusd: 15, captured_microusd: 15 }]);
    const account = (rows: Array<{ data: Record<string, unknown> }>) => rows.find(row => row.data.owner_id === OWNER_A)!.data;
    expect(account(after["public.usage_accounts"]!)).toEqual({ ...account(before["public.usage_accounts"]!), reserved_microusd: Number(account(before["public.usage_accounts"]!).reserved_microusd) - 85 });
    expect(await matches()).toBe(true); expect(await clear()).toBe(true);
    await db.query("select fluid_private.settle_reservation($1)", [jobId]);
    expect(await snapshot()).toEqual(after);
  });

  it("lets exact Strategy testing recognize the existing Logo witness while preserving global and tampered-evidence blocks", async () => {
    // Synthetic account authority only; no runtime activation or production grant.
    await db.query(`insert into fluid_private.api_text_allowance_cohorts(id,role_name,role_oid,deployment_id,operations,
      signup_after,signup_before,expires_at,owner_attempt_limit,owner_cost_limit,owner_active_limit,account_limit,attempt_limit,cost_limit)
      select 'strategy-logo-fixture',rolname,oid,'dpl_synthetic_logo',array['strategy.competitors'],clock_timestamp()-interval '1 day',
      clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day',1,122880,1,1,1,122880 from pg_roles where rolname=$1`, [workerRole]);
    await db.query("insert into fluid_private.api_text_owner_entitlements(owner_id,cohort_id,attempt_limit,cost_limit,active_limit,expires_at) values($1,'strategy-logo-fixture',1,122880,1,clock_timestamp()+interval '1 day')", [OWNER_A]);
    await db.query("insert into fluid_private.api_text_testing_access(owner_id,cohort_id,operation,enabled) values($1,'strategy-logo-fixture','strategy.competitors',true)", [OWNER_A]);
    const strategyPaused = async () => (await db.query<{ value: boolean }>("select fluid_private.api_text_strategy_paused($1,'strategy.competitors',$2) value", [OWNER_A, projectId])).rows[0]!.value;
    expect(await strategyPaused()).toBe(true);
    await adjudicate(); const before = await snapshot();
    expect(await strategyPaused()).toBe(false);
    expect((await db.query<{ value: boolean }>("select fluid_private.api_text_strategy_outcome_resolved($1) value", [jobId])).rows[0]!.value).toBe(true);
    expect((await db.query<{ value: boolean }>("select fluid_private.api_text_paid_paused($1) value", [OWNER_A])).rows[0]!.value).toBe(true);
    expect(await snapshot()).toEqual(before);
    await tamper("update public.job_steps set actual_cost_microusd=16 where id=$1", [stepId]);
    expect(await strategyPaused()).toBe(true);
    expect((await db.query<{ value: boolean }>("select fluid_private.api_text_strategy_outcome_resolved($1) value", [jobId])).rows[0]!.value).toBe(false);
  });

  it("keeps the witness immutable and blocks duplicate adjudication and late ordinary completion", async () => {
    await adjudicate(); const before = await snapshot();
    await rejected(() => db.query(`update ${table} set reason='Changed'`));
    await rejected(() => db.query(`delete from ${table}`));
    await rejected(() => db.query(`truncate ${table}`));
    await rejected(() => adjudicate());
    await worker(() => rejected(() => db.query("select public.complete_logo_job_step($1,$2,$3,'succeeded',15,$4,$5)", [jobId, lease, stepKey, {}, providerRequestId])));
    expect(await snapshot()).toEqual(before);
  });

  it.each(["step", "provider", "publication", "reservation", "job"])("rejects changed %s evidence before recording a decision", async kind => {
    if (kind === "step") await tamper("update public.job_steps set output=output||'{\"changed\":true}' where id=$1", [stepId]);
    if (kind === "provider") await tamper("update public.logo_provider_responses set observation=jsonb_set(observation,'{responseHash}',to_jsonb(repeat('e',64))) where id=$1", [providerId]);
    if (kind === "publication") await tamper("update public.logo_asset_publications set content_hash=repeat('f',64) where id=$1", [publicationId]);
    if (kind === "reservation") await tamper("update public.usage_reservations set actual_microusd=16 where job_id=$1", [jobId]);
    if (kind === "job") await tamper("update public.jobs set input=input||'{\"changed\":true}' where id=$1", [jobId]);
    const before = await snapshot(); await rejected(() => adjudicate());
    expect(await snapshot()).toEqual(before);
  });

  it.each(["step", "provider", "publication", "reservation", "job", "object"])("restores the project block if %s evidence changes after adjudication", async kind => {
    await adjudicate();
    if (kind === "step") await tamper("update public.job_steps set actual_cost_microusd=16 where id=$1", [stepId]);
    if (kind === "provider") await tamper("update public.logo_provider_responses set observation=jsonb_set(observation,'{responseHash}',to_jsonb(repeat('e',64))) where id=$1", [providerId]);
    if (kind === "publication") await tamper("update public.logo_asset_publications set content_hash=repeat('f',64) where id=$1", [publicationId]);
    if (kind === "reservation") await tamper("update public.usage_reservations set state='active' where job_id=$1", [jobId]);
    if (kind === "job") await tamper("update public.jobs set state='queued' where id=$1", [jobId]);
    if (kind === "object") await tamper("update storage.objects set version='changed'", []);
    expect(await matches()).toBe(false); expect(await clear()).toBe(false);
  });

  it("keeps unrelated ambiguous outcomes blocked without hiding an extra ambiguous step", async () => {
    await adjudicate(); expect(await clear()).toBe(true);
    await db.query("update public.jobs set state='failed',error_code='synthetic_other_failure' where id=$1", [siblingId]);
    await db.query("insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd,output) values($1,$2,$3,'synthetic-other-step','synthetic-other-request','ambiguous',100,'{\"error\":\"provider_outcome_unknown\"}')", [siblingId, OWNER_A, projectId]);
    expect(await matches()).toBe(true); expect(await clear()).toBe(false);
    await db.query("delete from public.job_steps where job_id=$1", [siblingId]);
    await db.query("insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd,output) values($1,$2,$3,'synthetic-extra-step','synthetic-extra-request','ambiguous',0,'{\"error\":\"provider_outcome_unknown\"}')", [jobId, OWNER_A, projectId]);
    expect(await matches()).toBe(false); expect(await clear()).toBe(false);
  });
});
