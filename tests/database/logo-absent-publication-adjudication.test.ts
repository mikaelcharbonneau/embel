import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { logoCostQuoteSchema, logoDispatchReceiptSchema, type LogoConceptJobInput } from "../../src/domain/logo-jobs";
import { logoWorkspaceV2Schema } from "../../src/domain/logo-workspace";

const table = "fluid_private.logo_absent_publication_adjudications";
const workerRole = "fluid_logo_worker";
const workerId = "synthetic-absent-publication";
const storageUser = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const policyIdentity = "a".repeat(64);
const candidatePath = new URL("../../supabase/activation/logo_cloud_60_absent_publication_adjudication.sql", import.meta.url);
const sql = (path: string) => readFile(new URL(`../../supabase/${path}`, import.meta.url), "utf8");
const decision = "operator-decision:synthetic-local-publication-test";
const reason = "The confirmed provider output has no publication reservation, grant, Storage upload or selectable asset.";

/** Disposable PostgreSQL only. The real admission, provider receipt and
 * ambiguous-completion paths produce this fixture before publication reservation.
 * Only the candidate's incident ID and five hashes use synthetic values;
 * no hosted data, credentials, image generation or live database is involved. */
describe("exact absent cloud logo publication adjudication", () => {
  let db: TestDatabase;
  let projectId: string;
  let jobId: string;
  let lease: string;
  let stepKey: string;
  let stepId: string;
  let providerId: string;
  let publicationRequest: unknown;
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
    from pg_proc p where p.oid='fluid_private.logo_publication_failure_adjudication_matches(uuid)'::regprocedure
  `)).rows;
  const matches = async () => (await db.query<{ value: boolean }>(
    "select fluid_private.logo_publication_failure_adjudication_matches($1) value", [jobId])).rows[0]!.value;
  const clear = async () => (await db.query<{ value: boolean }>(
    "select fluid_private.logo_local_project_clear($1,$2) value", [OWNER_A, projectId])).rows[0]!.value;
  const adjudicate = (id = jobId, reference: string | null = decision) => db.query(
    `insert into ${table}(job_id,operator_decision_reference,reason) values($1,$2,$3)`, [id, reference, reason]);
  const insertPublication = async () => (await db.query<{ id: string; asset_id: string; version_id: string }>(`
    insert into public.logo_asset_publications(owner_id,project_id,request_key,request,content_hash,mime_type,byte_length,
      purpose,source_receipt_id,source_kind,job_id,lease_token,input_revision,input_hash)
    select owner_id,project_id,($2::jsonb#>>'{publication,requestKey}')::uuid,$2,$2::jsonb#>>'{publication,contentHash}','image/png',
      ($2::jsonb#>>'{publication,byteLength}')::bigint,'brand_asset',($2::jsonb#>>'{publication,source,sourceId}')::uuid,'concept',id,$3,input_revision,input_hash
    from public.jobs where id=$1 returning id,asset_id,version_id`, [jobId, publicationRequest, lease])).rows[0]!;
  const snapshot = async () => {
    const result: Record<string, Array<{ data: Record<string, unknown> }>> = {};
    for (const relation of ["public.projects", "public.project_revisions", "public.jobs", "public.job_steps", "public.usage_accounts",
      "public.usage_reservations", "public.logo_provider_responses", "public.logo_asset_publications", "public.assets", "public.asset_versions",
      "public.logo_raster_results", "public.logo_operation_requests", "public.logo_cost_quotes", "public.logo_concept_attempts",
      "storage.objects", "fluid_private.logo_publication_failure_adjudications", "fluid_private.logo_local_jobs", "fluid_private.logo_generative_storage_grants", table]) {
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
    publicationRequest = { kind: "stage", publication };
    await workerQuery("select public.complete_logo_job_step($1,$2,$3,'ambiguous',15,$4,$5)", [jobId, lease, stepKey, { error: "publication_unknown" }, providerRequestId]);
    stepId = (await db.query<{ id: string }>("select id from public.job_steps where job_id=$1", [jobId])).rows[0]!.id;
    expect(await clear()).toBe(false);
    const pins = [
      ["pinned_job_sha256", "public.jobs", "id", jobId],
      ["pinned_step_sha256", "public.job_steps", "id", stepId],
      ["pinned_provider_sha256", "public.logo_provider_responses", "id", providerId],
      ["pinned_marker_sha256", "fluid_private.logo_local_jobs", "job_id", jobId],
      ["pinned_reservation_sha256", "public.usage_reservations", "job_id", jobId],
    ];
    let candidate = await readFile(candidatePath, "utf8");
    for (const [name, relation, key, id] of pins) {
      const digest = (await db.query<{ hash: string }>(`select encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') hash from ${relation} t where ${key}=$1`, [id])).rows[0]!.hash;
      const literal = new RegExp(`(${name}\\s+(?:constant\\s+)?text\\s*(?::=|default)\\s*)'[a-f0-9]{64}'`, "i");
      expect(candidate, `Missing uniquely named incident pin: ${name}`).toMatch(literal);
      candidate = candidate.replace(literal, `$1'${digest}'`);
    }
    candidate = candidate.replace(/(pinned_job_id constant uuid := )'[a-f0-9-]{36}'/, `$1'${jobId}'`);
    await db.exec(await sql("activation/logo_concepts_50_publication_adjudication.sql"));
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
      for (const signature of ["fluid_private.logo_publication_failure_adjudication_matches(uuid)", "fluid_private.logo_absent_publication_adjudication_matches(uuid)", "fluid_private.record_logo_absent_publication_adjudication()"])
        expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows[0]!.allowed).toBe(false);
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

  it("keeps the witness immutable and blocks duplicate adjudication and late ordinary completion", async () => {
    await adjudicate(); const before = await snapshot();
    await rejected(() => db.query(`update ${table} set reason='Changed'`));
    await rejected(() => db.query(`delete from ${table}`));
    await rejected(() => db.query(`truncate ${table}`));
    await rejected(() => adjudicate());
    await worker(() => rejected(() => db.query("select fluid_private.prepare_logo_asset($1,$2,$3,$4)", [projectId, publicationRequest, jobId, lease])));
    await worker(() => rejected(() => db.query("select public.complete_logo_job_step($1,$2,$3,'succeeded',15,$4,$5)", [jobId, lease, stepKey, {}, providerRequestId])));
    expect(await snapshot()).toEqual(before);
  });

  it.each(["step", "provider", "reservation", "job", "marker"])("rejects changed %s evidence before recording a decision", async kind => {
    if (kind === "step") await tamper("update public.job_steps set output=output||'{\"changed\":true}' where id=$1", [stepId]);
    if (kind === "provider") await tamper("update public.logo_provider_responses set observation=jsonb_set(observation,'{responseHash}',to_jsonb(repeat('e',64))) where id=$1", [providerId]);
    if (kind === "marker") await tamper("update fluid_private.logo_local_jobs set policy_identity=repeat('f',64) where job_id=$1", [jobId]);
    if (kind === "reservation") await tamper("update public.usage_reservations set actual_microusd=16 where job_id=$1", [jobId]);
    if (kind === "job") await tamper("update public.jobs set input=input||'{\"changed\":true}' where id=$1", [jobId]);
    const before = await snapshot(); await rejected(() => adjudicate());
    expect(await snapshot()).toEqual(before);
  });

  it.each(["step", "provider", "reservation", "job", "marker"])("restores the project block if %s evidence changes after adjudication", async kind => {
    await adjudicate();
    if (kind === "step") await tamper("update public.job_steps set actual_cost_microusd=16 where id=$1", [stepId]);
    if (kind === "provider") await tamper("update public.logo_provider_responses set observation=jsonb_set(observation,'{responseHash}',to_jsonb(repeat('e',64))) where id=$1", [providerId]);
    if (kind === "marker") await tamper("update fluid_private.logo_local_jobs set policy_identity=repeat('f',64) where job_id=$1", [jobId]);
    if (kind === "reservation") await tamper("update public.usage_reservations set state='active' where job_id=$1", [jobId]);
    if (kind === "job") await tamper("update public.jobs set state='queued' where id=$1", [jobId]);
    expect(await matches()).toBe(false); expect(await clear()).toBe(false);
  });

  it("refuses a Storage object uploaded since the failed step, retaining all evidence atomically", async () => {
    await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata,version) values('fluid-assets',$1,$2,'{}','synthetic-orphan')", [`${OWNER_A}/${projectId}/${randomUUID()}/${randomUUID()}`, storageUser]);
    const before = await snapshot(); await rejected(() => adjudicate()); expect(await snapshot()).toEqual(before);
  });

  it("refuses an active sibling lease until the worker has drained", async () => {
    await db.query("update public.jobs set state='running',lease_token=$2,lease_expires_at=clock_timestamp()+interval '60 seconds' where id=$1", [siblingId, randomUUID()]);
    const before = await snapshot(); await rejected(() => adjudicate()); expect(await snapshot()).toEqual(before);
  });

  it("rejects a publication that exists before adjudication and restores the block if one appears afterward", async () => {
    await db.exec("savepoint before_publication");
    await insertPublication();
    const before = await snapshot(); await rejected(() => adjudicate()); expect(await snapshot()).toEqual(before);
    await db.exec("rollback to savepoint before_publication; release savepoint before_publication");
    await adjudicate(); expect(await matches()).toBe(true);
    await insertPublication(); expect(await matches()).toBe(false); expect(await clear()).toBe(false);
  });

  it("still accepts the existing uploaded-but-uncommitted witness branch after extension", async () => {
    await adjudicate(); const publication = await insertPublication();
    const path = `${OWNER_A}/${projectId}/${publication.asset_id}/${publication.version_id}`;
    await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata,version) values('fluid-assets',$1,$2,'{}','synthetic-previous-witness')", [path, storageUser]);
    // Fixture-only historical witness: the existing suite independently tests
    // its original insertion trigger. This isolates the old matcher branch;
    // the new absence matcher must reject the publication that now exists.
    await tamper(`insert into fluid_private.logo_publication_failure_adjudications
      (job_id,operator_decision_reference,reason,job_before,step_before,provider_before,publication_before,
       reservation_before,reservation_after,local_marker,storage_grant,storage_object,account_before,account_after,
       operator_role,operator_session,recorded_at)
      select x.job_id,x.operator_decision_reference,x.reason,x.job_before,x.step_before,x.provider_before,to_jsonb(a),
       x.reservation_before,x.reservation_after,x.local_marker,'{}',to_jsonb(o)-array['last_accessed_at'],x.account_before,x.account_after,
       x.operator_role,x.operator_session,x.recorded_at
      from ${table} x join public.logo_asset_publications a on a.job_id=x.job_id
       join storage.objects o on o.bucket_id='fluid-assets' and o.name=$2 where x.job_id=$1`, [jobId, path]);
    expect((await db.query<{ value: boolean }>("select fluid_private.logo_absent_publication_adjudication_matches($1) value", [jobId])).rows[0]!.value).toBe(false);
    expect(await matches()).toBe(true); expect(await clear()).toBe(true);
  });

  it("retains the previous matcher branch and original recording function", async () => {
    const functions = (await db.query<{ matcher: string; original_trigger_hash: string }>("select (select prosrc from pg_proc where oid='fluid_private.logo_publication_failure_adjudication_matches(uuid)'::regprocedure) matcher,(select md5(prosrc) from pg_proc where oid='fluid_private.record_logo_publication_failure_adjudication()'::regprocedure) original_trigger_hash")).rows[0]!;
    expect(functions.matcher).toContain("join public.logo_asset_publications a on a.job_id=j.id");
    expect(functions.matcher).toContain("or fluid_private.logo_absent_publication_adjudication_matches(p_job)");
    expect(functions.original_trigger_hash).toBe("04fb90bddbfe0f8bbc8dd6d1cf848a08");
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
