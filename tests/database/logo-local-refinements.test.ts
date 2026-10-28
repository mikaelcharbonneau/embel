import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { legacyLogoCostQuoteSchema as logoCostQuoteSchema, logoDispatchReceiptSchema, type LogoConceptJobInput, type LogoRefinementJobInput } from "../../src/domain/logo-jobs";
import { logoWorkspaceV2Schema, type LogoWorkspaceV2 } from "../../src/domain/logo-workspace";
import type { IdentityAssetReservation } from "../../src/server/data/identity-asset-store";
import { digestBytes, syntheticPng } from "../features/logo-vector/raster-fixtures";

const workerRole = "fluid_logo_worker", workerId = "synthetic-local-refinement";
const storageUser = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const policyIdentity = "a".repeat(64);
const sql = (path: string) => readFile(new URL(`../../supabase/${path}`, import.meta.url), "utf8");
const descriptor = { policyIdentity, handlerVersion: "logo-image-v1", provider: "openai", model: "gpt-image-2.5-sunburst-2026-09-08", engine: null, maxCostMicrousd: 100 };
type Job = { id: string; project_id: string; lease_token: string; input: LogoConceptJobInput | LogoRefinementJobInput };

/** Disposable PostgreSQL, original synthetic PNGs and synthetic provider receipts.
 * Uses the actual restricted role, admission, Storage and completion boundaries;
 * no credentials, network requests, live mutations or paid image generation. */
describe("local saved-preview refinements", () => {
  let db: TestDatabase, workspace: LogoWorkspaceV2, conceptJob: Job, base: IdentityAssetReservation;
  let source: Record<string, unknown>, securityBefore: unknown, securityAfter: unknown, grantsBefore: unknown;
  let activation: string;
  const rawRpc = async (name: string, args: unknown[]) => (await db.query<{ value: unknown }>(
    `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`, args)).rows[0]!.value;
  const rpc = (name: string, args: unknown[], owner = OWNER_A) => asRole(db, "authenticated", owner, () => rawRpc(name, args));
  async function worker<T>(run: () => Promise<T>) {
    await db.exec(`set session authorization ${workerRole}`);
    try { return await run(); } finally { await db.exec("set session authorization postgres"); }
  }
  const wq = <T>(query: string, args: unknown[] = []) => worker(() => db.query<T>(query, args));
  async function rejected(run: () => Promise<unknown>, message?: string) {
    await db.exec("savepoint denied_refinement"); let error: unknown;
    try { await run(); } catch (caught) { error = caught; }
    await db.exec("rollback to savepoint denied_refinement; release savepoint denied_refinement");
    expect(error).toBeDefined();
    if (message) expect(String(error)).toContain(message);
  }
  const deniedRpc = (name: string, args: unknown[], owner = OWNER_A, message?: string) =>
    asRole(db, "authenticated", owner, () => rejected(() => rawRpc(name, args), message));
  const currentWorkspace = async (project = workspace.projectId) => logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace", [project]));
  const security = async () => (await db.query(`select oid,proowner,proacl,prosecdef,provolatile,proconfig,proleakproof from pg_proc where oid in(
    'fluid_private.logo_local_project_clear(uuid,uuid)'::regprocedure,'fluid_private.logo_local_job_allowed(uuid,text)'::regprocedure,
    'public.local_logo_operation(uuid,text,jsonb)'::regprocedure,'public.admit_logo_operation(uuid,jsonb)'::regprocedure,
    'fluid_private.logo_operation_ready(uuid,text)'::regprocedure) order by oid`)).rows;
  const grants = async () => (await db.query(`select p.oid,a.privilege_type,a.is_grantable from pg_proc p cross join lateral aclexplode(p.proacl) a
    where a.grantee='fluid_logo_worker'::regrole order by p.oid`)).rows;
  const account = async () => (await db.query<{ limit_microusd: number; spent_microusd: number; provider_actual_microusd: number; reserved_microusd: number }>(
    "select limit_microusd,spent_microusd,provider_actual_microusd,reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows[0]!;
  const ready = () => wq<{ value: boolean }>("select public.report_logo_worker_ready($1,$2,90) value", [workerId,
    ["identity.logo_concept", "identity.logo_refine"].map(operation => ({ ...descriptor, operation }))]);
  const claim = async () => (await wq<Job>("select * from public.claim_logo_job($1,300)", [workerId])).rows[0]!;
  const stepKey = (job: Job) => job.input.operation === "identity.logo_concept" ? `logo-preview-v1:${job.input.slotId}:${job.input.attemptId}` : "generate-refinement";
  const begin = (job: Job) => wq<{ value: string }>("select public.begin_logo_job_step($1,$2,$3,$4,100) value", [job.id, job.lease_token, stepKey(job), `${job.id}:${stepKey(job)}`]);
  async function storage<T>(run: () => Promise<T>, owner = storageUser) {
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: owner, session_id: sessionId, role: "authenticated", aud: "authenticated", iss: "https://fricsfwqibyhemknqgyf.supabase.co/auth/v1", is_anonymous: false, exp: Math.floor(Date.now() / 1000) + 3600 })]);
    try { return await asRole(db, "authenticated", owner, run); }
    finally { await db.query("select set_config('request.jwt.claims','',false)"); }
  }
  const authorize = (job: Job, reservation: IdentityAssetReservation | null, mode = "read") =>
    db.query<{ value: { member: string; reservation: IdentityAssetReservation } }>("select public.authorize_logo_generative_storage($1,$2,$3,$4) value", [job.id, job.lease_token, reservation?.id ?? null, mode]);
  async function complete(job: Job) {
    expect((await begin(job)).rows[0]!.value).toBe("started");
    const bytes = syntheticPng(8, 8, (x, y) => x + y > 6 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
    const contentHash = digestBytes(bytes), input = job.input;
    const sourceId = input.operation === "identity.logo_concept" ? input.attemptId : input.rasterRevisionId;
    const inputRevisions = (await wq<{ value: unknown }>("select public.read_leased_logo_record($1,$2,'input_revisions',null) value", [job.id, job.lease_token])).rows[0]!.value;
    const reservation = (await wq<{ value: IdentityAssetReservation }>("select fluid_private.prepare_logo_asset($1,$2,$3,$4) value", [job.project_id, { kind: "stage", publication: {
      requestKey: sourceId, source: { kind: "concept", sourceId }, inputRevisions, mimeType: "image/png", contentHash, byteLength: bytes.length,
    } }, job.id, job.lease_token])).rows[0]!.value;
    await storage(async () => {
      await authorize(job, reservation, "write");
      await db.query("select set_config('storage.operation','object.upload',false)");
      await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata,version) values('fluid-assets',$1,$2,$3,$4)", [reservation.storagePath, storageUser, { size: bytes.length, mimetype: "image/png", contentLength: bytes.length }, randomUUID()]);
    });
    await wq("select fluid_private.observe_logo_asset($1,$2,$3,$4)", [reservation.id, { status: "verified", checkedAt: new Date().toISOString(), contentHash, mimeType: "image/png", byteLength: bytes.length }, job.id, job.lease_token]);
    const providerRequestId = `synthetic-${job.id}`;
    const provider = (await wq<{ value: { id: string } }>("select public.record_logo_provider_response($1,$2,$3) value", [job.id, job.lease_token, {
      provider: descriptor.provider, model: descriptor.model, providerRequestId, responseHash: "c".repeat(64), observedAt: new Date().toISOString(),
      billing: { status: "recorded", confirmedMicrousd: 1 }, artifactHash: contentHash, normalizedPixelHash: "d".repeat(64),
    }])).rows[0]!.value;
    const output = input.operation === "identity.logo_concept"
      ? { version: 2, kind: "logo_concept", batchId: input.batchId, slotId: input.slotId, attemptId: input.attemptId, publicationId: reservation.id, providerResponseReceiptId: provider.id }
      : { version: 2, kind: "logo_refinement_raster", rasterRevisionId: input.rasterRevisionId, publicationId: reservation.id, providerResponseReceiptId: provider.id };
    await wq("select public.complete_logo_job_step($1,$2,$3,'succeeded',1,$4,$5)", [job.id, job.lease_token, stepKey(job), output, providerRequestId]);
    await wq("select public.finish_logo_job($1,$2,'succeeded')", [job.id, job.lease_token]);
    return (await db.query<{ value: IdentityAssetReservation }>("select fluid_private.logo_asset_reservation(r) value from public.logo_asset_publications r where id=$1", [reservation.id])).rows[0]!.value;
  }
  async function refinement(selected = source, instruction = "Refine the synthetic spacing.") {
    const w = await currentWorkspace();
    const quote = logoCostQuoteSchema.parse(await rpc("local_logo_operation", [w.projectId, "quote", { operation: "refine_preview", expected: w.heads, source: selected, instruction }]));
    const request = { requestKey: randomUUID(), quoteId: quote.id, acceptedMaxCostMicrousd: quote.maxCostMicrousd, expected: w.heads };
    const receipt = logoDispatchReceiptSchema.parse(await rpc("local_logo_operation", [w.projectId, "admit", request]));
    return { quote, request, receipt };
  }
  const originalEvidence = async () => (await db.query(`select jsonb_build_object(
    'job',(select to_jsonb(j) from public.jobs j where id=$1),'result',(select to_jsonb(r) from public.logo_raster_results r where job_id=$1),
    'provider',(select to_jsonb(r) from public.logo_provider_responses r where job_id=$1),'step',(select to_jsonb(s) from public.job_steps s where job_id=$1),
    'publication',(select to_jsonb(p) from public.logo_asset_publications p where id=$2),
    'version',(select to_jsonb(v) from public.asset_versions v where id=$3)) evidence`, [conceptJob.id, base.id, base.reference.versionId])).rows;

  beforeAll(async () => {
    db = await createTestDatabase(); await db.exec("set timezone='UTC'"); await resetFixture(db);
    await db.exec(`alter table auth.users add column is_anonymous boolean not null default false;
      create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant execute on function auth.jwt() to authenticated;
      alter table storage.objects add column metadata jsonb not null default '{}',add column created_at timestamptz not null default clock_timestamp(),add column version text;`);
    for (const path of ["candidates/logo_worker_storage.sql", "candidates/logo_generative_storage.sql", "activation/logo_concepts_20_storage.sql", "candidates/logo_local_concepts.sql", "activation/logo_concepts_40_download_metadata.sql", "activation/logo_concepts_50_publication_adjudication.sql"])
      await db.exec(await sql(path));
    workspace = logoWorkspaceV2Schema.parse(await rpc("start_logo_project", [{ requestKey: randomUUID(), brief: {
      name: "Synthetic local refinement", activity: "Local tests", audience: "Testers", personality: "Precise", logoTypes: ["wordmark"],
    } }]));
    await db.query("select set_config('embel.logo_owner_id',$1,false),set_config('embel.logo_project_id',$2,false)", [OWNER_A, workspace.projectId]);
    await db.exec(await sql("activation/logo_concepts_10_principals.sql"));
    await db.query("insert into auth.users(id) values($1)", [storageUser]);
    await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [sessionId, storageUser]);
    for (const [key, value] of Object.entries({ logo_storage_user_id: storageUser, logo_worker_id: workerId, logo_policy_identity: policyIdentity, logo_reservation_microusd: "100" }))
      await db.query("select set_config($1,$2,false)", [`embel.${key}`, value]);
    await db.exec(await sql("activation/logo_concepts_30_bind_disabled.sql"));
    await db.exec(`update fluid_private.logo_runtime_policies set enabled=true; update fluid_private.logo_storage_principals set enabled=true;
      update fluid_private.logo_generative_storage_capabilities set enabled=true; update fluid_private.logo_local_capabilities set enabled=true;`);
    securityBefore = await security(); grantsBefore = await grants();
    await db.exec(await sql("candidates/logo_local_refinements.sql")); securityAfter = await security();
    activation = await sql("activation/logo_refinements_10_activate.sql"); await db.exec(activation);
    expect((await ready()).rows[0]!.value).toBe(true);
    const brief = workspace.stages.brief_references!;
    const snapshot = (await db.query<{ id: string }>("select reference_snapshot_id id from public.logo_stage_revisions where id=$1", [brief.id])).rows[0]!.id;
    const quote = logoCostQuoteSchema.parse(await rpc("local_logo_operation", [workspace.projectId, "quote", { operation: "concepts", expected: workspace.heads, briefRevisionId: brief.id, referenceSnapshotId: snapshot }]));
    const receipt = logoDispatchReceiptSchema.parse(await rpc("local_logo_operation", [workspace.projectId, "admit", { requestKey: randomUUID(), quoteId: quote.id, acceptedMaxCostMicrousd: quote.maxCostMicrousd, expected: workspace.heads }]));
    conceptJob = await claim();
    for (const id of receipt.jobIds.filter(id => id !== conceptJob.id)) await rpc("request_job_cancel", [id]);
    base = await complete(conceptJob);
    const input = conceptJob.input as LogoConceptJobInput;
    source = { kind: "concept", batchId: input.batchId, slotId: input.slotId, attemptId: input.attemptId };
    workspace = await currentWorkspace();
    await db.query("update public.usage_accounts set limit_microusd=0 where owner_id=$1", [OWNER_A]);
  }, 120_000);
  beforeEach(async () => { await db.exec("begin"); await ready(); });
  afterEach(async () => { await db.exec("rollback; set session authorization postgres; reset role"); });
  afterAll(async () => { await db?.close(); }, 30_000);

  it("preserves the existing function security and 14 grants, activates only the same owner's exact image descriptor", async () => {
    expect(securityAfter).toEqual(securityBefore); expect(await grants()).toEqual(grantsBefore); expect(grantsBefore).toHaveLength(14);
    expect((await db.query("select operation,owner_id,policy_identity,provider,model,max_cost_microusd,enabled from fluid_private.logo_runtime_policies order by operation")).rows)
      .toEqual(["identity.logo_concept", "identity.logo_refine"].map(operation => ({ operation, owner_id: OWNER_A, policy_identity: policyIdentity, provider: descriptor.provider, model: descriptor.model, max_cost_microusd: 100, enabled: true })));
    expect((await db.query("select operation,auth_user_id,policy_identity,enabled from fluid_private.logo_generative_storage_capabilities order by operation")).rows)
      .toEqual(["identity.logo_concept", "identity.logo_refine"].map(operation => ({ operation, auth_user_id: storageUser, policy_identity: policyIdentity, enabled: true })));
    for (const name of ["jobs", "logo_raster_results", "logo_raster_refinements"])
      expect((await db.query("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') allowed", [workerRole, `public.${name}`])).rows[0]).toEqual({ allowed: false });
    expect((await db.query("select * from pg_auth_members where member='fluid_logo_worker'::regrole")).rows).toEqual([]);
  });

  it("admits and executes exactly one local preview refinement at zero allowance while ordinary admission stays gated", async () => {
    const before = await account(), { quote, request, receipt } = await refinement();
    expect(receipt.jobIds).toHaveLength(1); expect(receipt.operation).toBe("identity.logo_refine");
    expect(await rpc("local_logo_operation", [workspace.projectId, "admit", request])).toEqual(receipt);
    const ordinaryQuote = logoCostQuoteSchema.parse(await rpc("local_logo_operation", [workspace.projectId, "quote", {
      operation: "refine_preview", expected: workspace.heads, source, instruction: "Fresh ordinary request at zero allowance.",
    }]));
    expect(await rpc("admit_logo_operation", [workspace.projectId, { ...request, quoteId: ordinaryQuote.id, requestKey: randomUUID() }])).toMatchObject({ kind: "logo_admission_rejected" });
    const job = await claim(); expect(job.id).toBe(receipt.jobIds[0]);
    expect(job.input).toMatchObject({ ownerId: OWNER_A, source: { kind: "preview", raster: source }, instruction: "Refine the synthetic spacing." });
    expect((await begin(job)).rows[0]!.value).toBe("started");
    expect((await db.query("select job_id,owner_id,worker_id,policy_identity from fluid_private.logo_local_jobs where job_id=$1", [job.id])).rows)
      .toEqual([{ job_id: job.id, owner_id: OWNER_A, worker_id: workerId, policy_identity: policyIdentity }]);
    expect(await account()).toEqual({ ...before, reserved_microusd: Number(before!.reserved_microusd) + quote.maxCostMicrousd });
    expect((await db.query("select * from fluid_private.logo_local_context")).rows).toEqual([]);
  });

  it("fences request reuse and acknowledges the exact original request after disablement", async () => {
    const { request, receipt } = await refinement();
    const before = await account();
    await deniedRpc("local_logo_operation", [workspace.projectId, "admit", { ...request, acceptedMaxCostMicrousd: request.acceptedMaxCostMicrousd + 1 }]);
    await db.exec("update fluid_private.logo_local_capabilities set enabled=false");
    expect(await rpc("local_logo_operation", [workspace.projectId, "admit", request])).toEqual(receipt);
    expect(await account()).toEqual(before);
    expect((await db.query("select count(*)::int n from public.logo_raster_refinements")).rows[0]).toEqual({ n: 1 });
    expect((await wq("select * from public.claim_logo_job($1,300)", [workerId])).rows).toEqual([]);
  });

  it("enforces owner and source-project boundaries without trusting a client owner or marker", async () => {
    const input = { operation: "refine_preview", expected: workspace.heads, source, instruction: "Synthetic edit" };
    await deniedRpc("local_logo_operation", [workspace.projectId, "quote", input], OWNER_B, "logo_project_not_found");
    await deniedRpc("local_logo_operation", [workspace.projectId, "quote", { ...input, ownerId: OWNER_B }]);
    await deniedRpc("local_logo_operation", [workspace.projectId, "quote", { ...input, source: { ...source, attemptId: randomUUID() } }]);
    const other = logoWorkspaceV2Schema.parse(await rpc("start_logo_project", [{ requestKey: randomUUID(), brief: { name: "Other synthetic project", activity: "Tests", audience: "Testers", personality: "Calm", logoTypes: ["wordmark"] } }]));
    await deniedRpc("local_logo_operation", [other.projectId, "quote", { ...input, expected: other.heads }]);
    await asRole(db, "authenticated", OWNER_A, () => rejected(() => db.query("insert into fluid_private.logo_local_context values(pg_backend_pid(),txid_current(),$1,$2)", [OWNER_A, workspace.projectId])));
    const { request } = await refinement();
    await deniedRpc("local_logo_operation", [workspace.projectId, "admit", request], OWNER_B);
  });

  it("publishes a new immutable preview and can refine that saved refinement without replacing its original source", async () => {
    const before = await originalEvidence();
    await refinement(); const first = await claim();
    const inputs = (await wq<{ value: { basePreview: unknown } }>("select public.read_leased_logo_record($1,$2,'refinement_inputs',null) value", [first.id, first.lease_token])).rows[0]!.value;
    expect(inputs.basePreview).toEqual(base.reference);
    expect((await storage(() => authorize(first, base))).rows[0]!.value.member).toBe("base");
    const result = await complete(first);
    expect(result.reference.versionId).not.toBe(base.reference.versionId);
    expect(await originalEvidence()).toEqual(before);
    const nextSource = { kind: "refinement", rasterRevisionId: (first.input as LogoRefinementJobInput).rasterRevisionId };
    await refinement(nextSource, "Refine the saved synthetic revision."); const second = await claim();
    expect(second.input).toMatchObject({ source: { kind: "preview", raster: nextSource } });
    expect((await storage(() => authorize(second, result))).rows[0]!.value.member).toBe("base");
    await storage(() => rejected(() => authorize(second, base)));
    await complete(second);
    expect(await originalEvidence()).toEqual(before);
    expect((await db.query("select count(*)::int n from public.logo_raster_results")).rows[0]).toEqual({ n: 3 });
    expect(await account()).toEqual({ limit_microusd: 0, spent_microusd: 3, provider_actual_microusd: 3, reserved_microusd: 0 });
  });

  it("keeps the frozen source, quote and local marker immutable", async () => {
    const { quote, receipt } = await refinement();
    for (const query of ["update public.logo_cost_quotes set source_inputs='{}' where id=$1", "delete from public.logo_cost_quotes where id=$1"])
      await rejected(() => db.query(query, [quote.id]));
    await rejected(() => db.query("update public.logo_raster_refinements set source='{}' where job_id=$1", [receipt.jobIds[0]]));
    await rejected(() => db.query("delete from fluid_private.logo_local_jobs where job_id=$1", [receipt.jobIds[0]]));
  });

  it("cancels a queued refinement before dispatch and releases its unused hold without a provider receipt", async () => {
    const before = await account(), { receipt } = await refinement();
    await rpc("request_job_cancel", [receipt.jobIds[0]]);
    expect((await wq("select * from public.claim_logo_job($1,300)", [workerId])).rows).toEqual([]);
    expect((await db.query("select state from public.jobs where id=$1", [receipt.jobIds[0]])).rows[0]).toEqual({ state: "cancelled" });
    expect((await db.query("select * from public.logo_provider_responses where job_id=$1", [receipt.jobIds[0]])).rows).toEqual([]);
    expect(await account()).toEqual(before);
  });

  it("revokes an active refinement's exact base read and fences dispatch after cancellation", async () => {
    await refinement(); const job = await claim();
    await storage(() => authorize(job, base));
    await rpc("request_job_cancel", [job.id]);
    await storage(() => rejected(() => authorize(job, base)));
    await worker(() => rejected(() => db.query("select public.begin_logo_job_step($1,$2,'generate-refinement',$3,100)", [job.id, job.lease_token, `${job.id}:generate-refinement`])));
    await storage(async () => {
      await db.query("select set_config('storage.operation','object.get_authenticated_info',false)");
      expect((await db.query("select id from storage.objects where name=$1", [base.storagePath])).rows).toEqual([]);
    });
  });

  it("halts further concepts and refinements after an uncertain refinement without fabricating a refund or output", async () => {
    const first = await refinement(); const job = await claim(); await begin(job);
    const second = await refinement(); const before = await account();
    await wq("select public.complete_logo_job_step($1,$2,'generate-refinement','ambiguous',0,$3,null)", [job.id, job.lease_token, { error: "provider_outcome_unknown" }]);
    expect((await wq("select * from public.claim_logo_job($1,300)", [workerId])).rows).toEqual([]);
    expect((await db.query("select state from public.jobs where id=$1", [second.receipt.jobIds[0]])).rows[0]).toEqual({ state: "queued" });
    expect((await db.query("select fluid_private.logo_local_project_clear($1,$2) value", [OWNER_A, workspace.projectId])).rows[0]).toEqual({ value: false });
    await deniedRpc("local_logo_operation", [workspace.projectId, "quote", { operation: "refine_preview", expected: workspace.heads, source, instruction: "Uncertain retry" }], OWNER_A, "logo_runtime_unavailable");
    await deniedRpc("local_logo_operation", [workspace.projectId, "quote", { operation: "concepts" }], OWNER_A, "logo_runtime_unavailable");
    expect(await rpc("local_logo_operation", [workspace.projectId, "admit", first.request])).toEqual(first.receipt);
    expect(await account()).toEqual(before);
    expect((await db.query("select * from public.logo_raster_results where job_id=$1", [job.id])).rows).toEqual([]);
    expect((await db.query("select fluid_private.logo_local_project_clear($1,$2) value", [OWNER_B, workspace.projectId])).rows[0]).toEqual({ value: true });
  });

  it("requires the bound worker ID and enabled refinement descriptor at dispatch", async () => {
    await refinement();
    await wq("select public.report_logo_worker_ready($1,$2,90)", ["wrong-worker", ["identity.logo_concept", "identity.logo_refine"].map(operation => ({ ...descriptor, operation }))]);
    expect((await wq("select * from public.claim_logo_job($1,300)", ["wrong-worker"])).rows).toEqual([]);
    const job = await claim();
    await db.exec("update fluid_private.logo_runtime_policies set enabled=false where operation='identity.logo_refine'");
    await worker(() => rejected(() => db.query("select public.begin_logo_job_step($1,$2,'generate-refinement',$3,100)", [job.id, job.lease_token, `${job.id}:generate-refinement`])));
    await storage(() => rejected(() => authorize(job, base)));
  });

  it("does not enable vector, directions, export or vector-source refinement", async () => {
    for (const operation of ["refine_vector", "directions", "export", "vectorize"])
      await deniedRpc("local_logo_operation", [workspace.projectId, "quote", { operation, expected: workspace.heads, source, instruction: "Synthetic unsupported edit" }]);
    await deniedRpc("local_logo_operation", [workspace.projectId, "quote", { operation: "refine_preview", expected: workspace.heads, source: { kind: "vector", assetVersionId: base.reference.versionId }, instruction: "Synthetic vector edit" }]);
    expect((await db.query("select operation from fluid_private.logo_runtime_policies where operation not in('identity.logo_concept','identity.logo_refine')")).rows).toEqual([]);
    expect((await db.query("select count(*)::int n from public.logo_raster_refinements")).rows[0]).toEqual({ n: 0 });
  });
});
