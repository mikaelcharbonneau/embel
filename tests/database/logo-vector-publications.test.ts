import { reportLogoFixtureReady, SYNTHETIC_CONCEPT_READINESS } from './logo-readiness-fixture';
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { logoCostQuoteSchema, logoDispatchReceiptSchema } from "../../src/domain/logo-jobs";
import { logoWorkspaceV2Schema, type LogoMutationReceipt } from "../../src/domain/logo-workspace";
import { logoVectorHistoryPageSchema } from "../../src/features/logo-vector/model/history";
import { logoVectorRevisionSchema } from "../../src/domain/logo-vector";
import type { ClaimedJob } from "../../src/domain/jobs";
import type { LogoWorkerConnection } from "../../src/server/data/logo-jobs";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import type { IdentityConnectionFactory } from "../../src/server/data/identity-transaction";
import { createLogoTransactionService } from "../../src/server/data/logo-transaction";
import { createLogoWorkspaceService } from "../../src/server/data/logo-workspace";
import { createLogoVectorMutationProducers } from "../../src/features/logo-vector/server/mutations";
import { createIdentityAssetStore, createPostgresIdentityAssetBackend } from "../../src/server/data/identity-asset-store";
import { publishLogoVectorResult } from "../../src/features/logo-vector/server/publication";
import { canonicalLogoDocumentBytes, validateLogoVectorCandidate, verifyLogoVectorRevision } from "../../src/features/logo-vector/server/revisions";
import type { LogoVectorConversionResult } from "../../src/features/logo-vector/server/converter";
import { QUALIFIED_VTRACER } from "../../worker/logo-vector/engine";
import { parseClaimedJob } from "../../worker/postgres-store";
import { separatedLogoDocument } from "../features/logo-vector/fixtures";
import { syntheticConversionInput } from "../features/logo-vector/raster-fixtures";

/** Disposable PostgreSQL + private in-memory blobs. All provider observations
 * and drawings are explicitly synthetic; this makes no hosted/provider claim. */
describe("atomic vector publication through existing durable jobs", () => {
  let db: TestDatabase;
  const blobs = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  beforeAll(async () => {
    db = await createTestDatabase();
    await db.exec(`create role fixture_vector_worker login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      grant usage on schema public,fluid_private to fixture_vector_worker;
      grant execute on function public.claim_logo_job(text,integer),public.begin_logo_job_step(uuid,uuid,text,text,bigint),public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text),public.finish_logo_job(uuid,uuid,text),public.record_logo_provider_response(uuid,uuid,jsonb),public.read_leased_logo_record(uuid,uuid,text,jsonb),fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid),fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid),fluid_private.read_logo_asset_publication(uuid,jsonb,uuid,uuid),fluid_private.stage_logo_vector_publication(uuid,uuid,jsonb) to fixture_vector_worker;
      create role fixture_vector_web login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      grant usage on schema public,fluid_private to fixture_vector_web;
      grant execute on function fluid_private.read_logo_trusted_request(uuid,jsonb),fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb),fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid),fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid) to fixture_vector_web;`);
  }, 60_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await resetFixture(db); blobs.clear();
    await db.query("insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_vector_worker' on conflict(role_name) do nothing", [OWNER_A]);
    await db.query("insert into fluid_private.logo_asset_web_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_vector_web' on conflict(role_name) do nothing", [OWNER_A]);
    await db.query(`insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled) values($1,'identity.logo_concept',$2,'logo-image-v1','openai','gpt-image-2.5-sunburst-2026-09-08',100,true) on conflict(owner_id,operation) do update set enabled=true`, [OWNER_A, "a".repeat(64)]);
    await db.query(`insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,engine,max_cost_microusd,enabled) values($1,'identity.logo_vectorize',$2,'1',$3,0,true) on conflict(owner_id,operation) do update set enabled=true`, [OWNER_A, "b".repeat(64), { id: "vtracer", version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm }]);
    await reportLogoFixtureReady(db,'fixture_vector_worker',['vector-test'],[SYNTHETIC_CONCEPT_READINESS,{operation:'identity.logo_vectorize',policyIdentity:'b'.repeat(64),handlerVersion:'1',provider:null,model:null,engine:{id:'vtracer',version:QUALIFIED_VTRACER.version,artifactHash:QUALIFIED_VTRACER.wasm},maxCostMicrousd:0}]);
  });
  async function worker<T>(run: () => Promise<T>): Promise<T> {
    await db.exec("set session authorization fixture_vector_worker");
    try { return await run(); } finally { await db.exec("set session authorization postgres"); }
  }
  const connection: LogoWorkerConnection = { async query<Row>(sql: string, args?: unknown[]) { return worker(() => db.query<Row>(sql, args)); } };
  const owned: IdentityConnectionFactory = { async acquire(ownerId) {
    if (ownerId !== OWNER_A) throw Error("foreign_writer");
    const role = (await db.query<{ oid: number }>("select oid from pg_roles where rolname='fixture_vector_web'")).rows[0]!;
    await db.exec("set session authorization fixture_vector_web");
    return { binding: { ownerId, roleName: "fixture_vector_web", roleOid: role.oid }, connection: {
      query: (sql, args) => db.query(sql, args ? [...args] : undefined),
      release: async () => { await db.exec("set session authorization postgres"); }, discard: async () => { await db.exec("set session authorization postgres"); },
    } };
  } };
  function store() {
    return createIdentityAssetStore({ backend: createPostgresIdentityAssetBackend({ owned, worker: connection }), storage: {
      async putIfAbsent(path, bytes, mimeType) { const old = blobs.get(path); if (old && (!Buffer.from(old.bytes).equals(Buffer.from(bytes)) || old.mimeType !== mimeType)) throw Error("immutable_blob_conflict"); if (!old) blobs.set(path, { bytes: Uint8Array.from(bytes), mimeType }); },
      async read(path) { const file = blobs.get(path); if (!file) throw Error("missing_blob"); return { ...file, bytes: Uint8Array.from(file.bytes) }; },
    } });
  }
  const rpc = (name: string, args: unknown[], owner = OWNER_A) => asRole(db, "authenticated", owner, async () => (await db.query<{ value: unknown }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`, args)).rows[0]!.value);
  async function read(projectId: string) { return logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace", [projectId])); }
  async function history(projectId: string) { return logoVectorHistoryPageSchema.parse(await rpc("list_logo_vector_history", [projectId, {}])); }
  function auth(owner = OWNER_A): AuthenticatedContext {
    return { userId: owner, client: { rpc(name: string, args: Record<string, unknown>) {
      const params = name === "read_logo_asset" ? [args.p_reference] : name === "read_logo_workspace_record" ? [args.p_project_id, args.p_kind, args.p_id] : [args.p_project_id];
      const result = rpc(name, params, owner).then(data => ({ data, error: null })).catch(error => ({ data: null, error }));
      return Object.assign(result, { abortSignal: () => result });
    } } } as unknown as AuthenticatedContext;
  }
  function mutations(source: ReturnType<typeof store>) {
    const reads = createLogoWorkspaceService({ assetStore: source, verifyVectorRevision: verifyLogoVectorRevision });
    return createLogoTransactionService(owned, createLogoVectorMutationProducers({ assetStore: source, readVectorDetail: reads.readLogoVectorDetail, getWorkspace: reads.getLogoWorkspace, readCurrentVectorRevisionId: reads.readLogoCurrentVectorRevisionId, readStageRevision: reads.getLogoStageRevision }));
  }
  async function published() {
    const f = await setup(), publication = await publishLogoVectorResult(connection, f.source, f.job, f.result); await complete(f.job, publication.id);
    const revision = logoVectorRevisionSchema.parse((await db.query<{ record: unknown }>("select record from public.logo_vector_revisions")).rows[0]!.record);
    return { ...f, revision, service: mutations(f.source) };
  }
  async function claim(): Promise<ClaimedJob> { return parseClaimedJob((await connection.query("select * from public.claim_logo_job('vector-test',300)")).rows[0]); }
  async function begin(job: ClaimedJob, key: string, cost = 0) { await connection.query("select public.begin_logo_job_step($1,$2,$3,$4,$5)", [job.id, job.leaseToken, key, `${job.id}:${key}`, cost]); }
  async function setup() {
    const w = logoWorkspaceV2Schema.parse(await rpc("start_logo_project", [{ requestKey: randomUUID(), brief: { name: "Synthetic Vector", activity: "Studio", audience: "Testers", personality: "Calm", logoTypes: ["combination"] } }]));
    const reference = (await db.query<{ reference_snapshot_id: string }>("select reference_snapshot_id from public.logo_stage_revisions where id=$1", [w.stages.brief_references!.id])).rows[0]!;
    const q = logoCostQuoteSchema.parse(await rpc("quote_logo_operation", [w.projectId, { operation: "concepts", expected: w.heads, briefRevisionId: w.stages.brief_references!.id, referenceSnapshotId: reference.reference_snapshot_id }]));
    const admission = logoDispatchReceiptSchema.parse(await rpc("admit_logo_operation", [w.projectId, { requestKey: randomUUID(), quoteId: q.id, acceptedMaxCostMicrousd: q.maxCostMicrousd, expected: w.heads }]));
    const concept = await claim(); const input = concept.input as { attemptId: string; slotId: string; batchId: string };
    const conceptStep = `logo-preview-v1:${input.slotId}:${input.attemptId}`;
    await begin(concept, conceptStep, 100);
    const raster = syntheticConversionInput("combination");
    const inputRevisions = (await connection.query<{ value: [] }>("select public.read_leased_logo_record($1,$2,'input_revisions',null) value", [concept.id, concept.leaseToken])).rows[0]!.value;
    const source = store(); const receipt = await source.publishLeasedAsset(concept, { requestKey: randomUUID(), inputRevisions, mimeType: "image/png", contentHash: raster.source.reference.contentHash, byteLength: raster.source.bytes.length, source: { kind: "concept", sourceId: input.attemptId } }, raster.source.bytes);
    const provider = (await connection.query<{ value: { id: string } }>("select public.record_logo_provider_response($1,$2,$3) value", [concept.id, concept.leaseToken, { provider: "openai", model: "gpt-image-2.5-sunburst-2026-09-08", providerRequestId: "synthetic-image", responseHash: "c".repeat(64), observedAt: "2026-10-07T00:00:00Z", billing: { status: "recorded", confirmedMicrousd: 1 }, artifactHash: receipt.reference.contentHash, normalizedPixelHash: "d".repeat(64) }])).rows[0]!.value;
    await connection.query("select public.complete_logo_job_step($1,$2,$3,'succeeded',1,$4,'synthetic-image')", [concept.id, concept.leaseToken, conceptStep, { version: 2, kind: "logo_concept", batchId: input.batchId, slotId: input.slotId, attemptId: input.attemptId, publicationId: receipt.id, providerResponseReceiptId: provider.id }]);
    await connection.query("select public.finish_logo_job($1,$2,'succeeded')", [concept.id, concept.leaseToken]);
    for (const id of admission.jobIds.filter(id => id !== concept.id)) await rpc("request_job_cancel", [id]);
    const rasterSource = { kind: "concept", batchId: input.batchId, slotId: input.slotId, attemptId: input.attemptId };
    await rpc("apply_logo_workspace_command", [w.projectId, { method: "selectLogoRaster", body: { requestKey: randomUUID(), expected: w.heads, source: rasterSource } }]);
    const selected = await read(w.projectId);
    const vectorQuote = logoCostQuoteSchema.parse(await rpc("quote_logo_operation", [w.projectId, { operation: "vectorize", expected: selected.heads, source: rasterSource, settings: raster.settings }]));
    await rpc("admit_logo_operation", [w.projectId, { requestKey: randomUUID(), quoteId: vectorQuote.id, acceptedMaxCostMicrousd: 0, expected: selected.heads }]);
    const job = await claim(); await begin(job, "convert-vector");
    const verified = await source.readLeasedAsset(job, receipt.reference), document = separatedLogoDocument();
    const derived = validateLogoVectorCandidate({ base: null, candidate: document, locks: [], expectedSource: verified.reference, source: verified });
    const result: LogoVectorConversionResult = { source: verified.reference, sourceContentHash: verified.reference.contentHash, logoType: "combination", document, svg: derived.svg,
      engine: { name: "@visioncortex/vtracer", version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm, settings: raster.settings },
      raster: { inputFormat: "png", inputWidth: 48, inputHeight: 40, width: 48, height: 40, originalOrientation: 1, autoOriented: false, inputColorSpace: "srgb", outputColorSpace: "srgb", rgbaContentHash: "e".repeat(64), alphaStrategy: "exact-alpha-layers", alphaLevels: [255] } };
    return { w: selected, job, source, result, original: receipt };
  }
  async function complete(job: ClaimedJob, publicationId: string) {
    return connection.query("select public.complete_logo_job_step($1,$2,'convert-vector','succeeded',0,$3,null)", [job.id, job.leaseToken, { version: 2, kind: "logo_vector", publicationId }]);
  }
  it("commits both inspected members and one review-required revision atomically at completeStep", async () => {
    const f = await setup(), publication = await publishLogoVectorResult(connection, f.source, f.job, f.result);
    expect((await db.query("select count(*)::int count from public.logo_vector_revisions")).rows[0]).toEqual({ count: 0 });
    expect((await db.query("select count(*)::int count from public.asset_versions")).rows[0]).toEqual({ count: 1 });
    await complete(f.job, publication.id);
    const revision = logoVectorRevisionSchema.parse((await db.query<{ record: unknown }>("select record from public.logo_vector_revisions")).rows[0]!.record);
    expect(revision.sourcePreview).toEqual(f.original.reference); expect(revision.svgAsset).toEqual(publication.reference); expect(revision.reviewStatus).toBe("review_required");
    expect(revision.documentHash).toBe((await db.query<{ content_hash: string }>("select content_hash from public.asset_versions where id=$1", [revision.documentAsset.versionId])).rows[0]!.content_hash);
    expect((await read(f.w.projectId)).approvedLogo).toBeNull(); expect((await db.query("select count(*)::int count from public.asset_versions")).rows[0]).toEqual({ count: 3 });
    await complete(f.job, publication.id); expect((await db.query("select count(*)::int count from public.logo_vector_revisions")).rows[0]).toEqual({ count: 1 });
    expect(blobs.size).toBe(3); expect(canonicalLogoDocumentBytes(f.result.document).length).toBeGreaterThan(0);
  });
  it("a damaged group member rolls back every file and revision publication", async () => {
    const f = await setup(), publication = await publishLogoVectorResult(connection, f.source, f.job, f.result);
    await db.query("update public.logo_asset_publications set state='reserved',verification=null where job_id=$1 and mime_type='application/json'", [f.job.id]);
    await expect(complete(f.job, publication.id)).rejects.toBeDefined();
    expect((await db.query("select count(*)::int count from public.asset_versions")).rows[0]).toEqual({ count: 1 });
    expect((await db.query("select count(*)::int count from public.logo_vector_revisions")).rows[0]).toEqual({ count: 0 });
    expect((await read(f.w.projectId)).heads).toEqual(f.w.heads);
  });
  it("stale captured heads retain output without changing the new user selection", async () => {
    const f = await setup(), publication = await publishLogoVectorResult(connection, f.source, f.job, f.result);
    await rpc("apply_logo_workspace_command", [f.w.projectId, { method: "saveLogoBrief", body: { requestKey: randomUUID(), expected: f.w.heads, brief: { name: "Changed", activity: "Studio", audience: "Testers", personality: "Calm", logoTypes: ["combination"] } } }]);
    const current = await read(f.w.projectId); await complete(f.job, publication.id);
    expect((await read(f.w.projectId)).heads).toEqual(current.heads); expect((await db.query("select count(*)::int count from public.logo_vector_revisions")).rows[0]).toEqual({ count: 1 });
    expect((await history(f.w.projectId)).items).toEqual([expect.objectContaining({ selection: "retained", acceptance: "unaccepted", earlierInputs: true, stageRevision: null })]);
  });
  it("a completed result after cancellation is retained without moving a head", async () => {
    const f = await setup(), publication = await publishLogoVectorResult(connection, f.source, f.job, f.result);
    await rpc("request_job_cancel", [f.job.id]); await complete(f.job, publication.id);
    expect((await history(f.w.projectId)).items).toEqual([expect.objectContaining({ selection: "retained", cancellation: "requested", stageRevision: null })]);
    await connection.query("select public.finish_logo_job($1,$2,'cancelled')", [f.job.id, f.job.leaseToken]);
    expect((await history(f.w.projectId)).items[0]!.cancellation).toBe("cancelled");
    expect((await read(f.w.projectId)).heads).toEqual(f.w.heads);
    expect((await db.query("select count(*)::int count from public.logo_vector_revisions")).rows[0]).toEqual({ count: 1 });
  });
  it("expired leases and authenticated metadata cannot publish a candidate", async () => {
    const f = await setup(), publication = await publishLogoVectorResult(connection, f.source, f.job, f.result);
    for (const owner of [OWNER_A, OWNER_B]) await expect(asRole(db, "authenticated", owner, () => db.query("select fluid_private.stage_logo_vector_publication($1,$2,'{}')", [f.job.id, f.job.leaseToken]))).rejects.toMatchObject({ code: "42501" });
    await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [f.job.id]);
    await expect(complete(f.job, publication.id)).rejects.toMatchObject({ code: "40001" });
    expect((await db.query("select count(*)::int count from public.asset_versions")).rows[0]).toEqual({ count: 1 });
    expect((await db.query("select count(*)::int count from public.logo_vector_revisions")).rows[0]).toEqual({ count: 0 });
  });
  it("a cancellation after actual edit staging fences commit and preserves staged bytes and every head", async () => {
    const f = await published(), before = await read(f.w.projectId);
    const command = { method: "saveLogoEdit" as const, body: { requestKey: randomUUID(), expected: before.heads, baseVectorRevisionId: f.revision.id, edit: { kind: "rotation" as const, componentId: "synthetic-symbol", degrees: 5 } } };
    const reads = createLogoWorkspaceService({ assetStore: f.source, verifyVectorRevision: verifyLogoVectorRevision });
    const producers = createLogoVectorMutationProducers({ assetStore: f.source, readVectorDetail: reads.readLogoVectorDetail, getWorkspace: reads.getLogoWorkspace, readCurrentVectorRevisionId: reads.readLogoCurrentVectorRevisionId, readStageRevision: reads.getLogoStageRevision });
    let staged: unknown[] = [], byteSnapshot: [string, Buffer][] = [], producerCalls = 0;
    const service = createLogoTransactionService(owned, { ...producers, async saveLogoEdit(...args) {
      producerCalls++;
      const evidence = await producers.saveLogoEdit!(...args);
      staged = (await db.query("select * from public.logo_asset_publications where job_id is null order by id")).rows;
      byteSnapshot = [...blobs].map(([path, value]) => [path, Buffer.from(value.bytes)]);
      expect(staged).toHaveLength(2);
      expect(await rpc("cancel_logo_vector_edit", [f.w.projectId, command])).toEqual({ status: "cancelled", ownerId: OWNER_A, projectId: f.w.projectId, requestKey: command.body.requestKey, command });
      return evidence;
    } });
    await expect(service.run(auth(), f.w.projectId, command)).rejects.toMatchObject({ code: "conflict" });
    expect((await db.query("select * from public.logo_asset_publications where job_id is null order by id")).rows).toEqual(staged);
    expect([...blobs].map(([path, value]) => [path, Buffer.from(value.bytes)])).toEqual(byteSnapshot);
    expect((await db.query("select count(*)::int n from public.asset_versions")).rows).toEqual([{ n: 3 }]);
    expect((await db.query("select count(*)::int n from public.logo_vector_revisions")).rows).toEqual([{ n: 1 }]);
    expect((await db.query("select count(*)::int n from public.logo_workspace_requests where request_key=$1", [command.body.requestKey])).rows).toEqual([{ n: 0 }]);
    expect(await read(f.w.projectId)).toEqual(before);
    // A subsequent exact retry stops at the trusted preflight, before any I/O.
    await expect(service.run(auth(), f.w.projectId, command)).rejects.toMatchObject({ code: "conflict" });
    expect(producerCalls).toBe(1);
  });
  it("a committed edit wins cancellation without altering its success receipt or latest heads", async () => {
    const f = await published(), command = { method: "saveLogoEdit" as const, body: { requestKey: randomUUID(), expected: (await read(f.w.projectId)).heads, baseVectorRevisionId: f.revision.id, edit: { kind: "rotation" as const, componentId: "synthetic-symbol", degrees: 5 } } };
    const receipt = await f.service.run(auth(), f.w.projectId, command);
    const before = await read(f.w.projectId);
    expect(await rpc("cancel_logo_vector_edit", [f.w.projectId, command])).toEqual({ status: "succeeded", ownerId: OWNER_A, projectId: f.w.projectId, requestKey: command.body.requestKey, command, receipt });
    expect(await read(f.w.projectId)).toEqual(before);
    expect((await db.query("select count(*)::int n from public.logo_vector_edit_cancellations")).rows).toEqual([{ n: 0 }]);
    expect(await f.service.run(auth(), f.w.projectId, command)).toEqual(receipt);
  });
  it("manual edit, explicit acceptance and restoration append immutable history", async () => {
    const f = await published(), current = await read(f.w.projectId);
    const edit = { method: "saveLogoEdit", body: { requestKey: randomUUID(), expected: current.heads, baseVectorRevisionId: f.revision.id, edit: { kind: "color", componentId: "synthetic-symbol", fill: "#11CC88", stroke: null } } };
    const saved = await f.service.run(auth(), f.w.projectId, edit) as LogoMutationReceipt;
    expect(saved.revision.stage).toBe("refinements"); expect(saved.workspace.approvedLogo).toBeNull(); expect(saved.workspace.stages.vector).toEqual(current.stages.vector);
    const candidateId = (saved.revision.payload as { vectorRevisionId: string }).vectorRevisionId;
    const accepted = await f.service.run(auth(), f.w.projectId, { method: "acceptLogoVector", body: { requestKey: randomUUID(), expected: saved.workspace.heads, vectorRevisionId: candidateId, acceptEarlierBasis: false } }) as LogoMutationReceipt;
    expect(accepted.workspace.approvedLogo?.vectorRevisionId).toBe(candidateId);
    expect(await f.service.run(auth(), f.w.projectId, edit)).toEqual(saved);
    const restored = await f.service.run(auth(), f.w.projectId, { method: "restoreLogoStage", body: { requestKey: randomUUID(), expected: accepted.workspace.heads, stage: "vector", revisionId: current.stages.vector!.id, acceptEarlierBasis: false } }) as LogoMutationReceipt;
    expect(restored.revision.id).not.toBe(current.stages.vector!.id); expect(restored.revision.parentRevisionId).toBe(accepted.revision.id);
    expect((await db.query<{ record: unknown }>("select record from public.logo_vector_revisions where id=$1", [f.revision.id])).rows[0]!.record).toEqual(f.revision);
    expect((await db.query("select count(*)::int count from public.logo_vector_revisions")).rows[0]).toEqual({ count: 2 });
    expect((await db.query("select count(*)::int count from public.logo_approvals")).rows[0]).toEqual({ count: 1 });
    const afterRestore = await f.service.run(auth(), f.w.projectId, { method: "saveLogoEdit", body: { requestKey: randomUUID(), expected: restored.workspace.heads, baseVectorRevisionId: f.revision.id, edit: { kind: "rotation", componentId: "synthetic-symbol", degrees: 5 } } }) as LogoMutationReceipt;
    expect(afterRestore.revision.stage).toBe("refinements");
  });
  it("locked edits fail without storing a candidate; unlocking is a separate saved operation", async () => {
    const f = await published(); const expected = (await read(f.w.projectId)).heads;
    const locked = await f.service.run(auth(), f.w.projectId, { method: "saveLogoEdit", body: { requestKey: randomUUID(), expected, baseVectorRevisionId: f.revision.id, edit: { kind: "locks", componentIds: ["synthetic-symbol"] } } }) as LogoMutationReceipt;
    const id = (locked.revision.payload as { vectorRevisionId: string }).vectorRevisionId;
    const before = blobs.size;
    await expect(f.service.run(auth(), f.w.projectId, { method: "saveLogoEdit", body: { requestKey: randomUUID(), expected: locked.workspace.heads, baseVectorRevisionId: id, edit: { kind: "size", componentId: "synthetic-symbol", scale: 1.1 } } })).rejects.toMatchObject({ code: "locked_component_changed" });
    expect(blobs.size).toBe(before);
    const unlocked = await f.service.run(auth(), f.w.projectId, { method: "saveLogoEdit", body: { requestKey: randomUUID(), expected: locked.workspace.heads, baseVectorRevisionId: id, edit: { kind: "locks", componentIds: [] } } }) as LogoMutationReceipt;
    expect(unlocked.revision.id).not.toBe(locked.revision.id); expect((await db.query("select count(*)::int count from public.logo_vector_revisions")).rows[0]).toEqual({ count: 3 });
  });
  it("a raster-only stage keeps the activated locked refinement as the next edit basis", async () => {
    const f = await published();
    const locked = await f.service.run(auth(), f.w.projectId, { method: "saveLogoEdit", body: { requestKey: randomUUID(), expected: (await read(f.w.projectId)).heads, baseVectorRevisionId: f.revision.id, edit: { kind: "locks", componentIds: ["synthetic-symbol"] } } }) as LogoMutationReceipt;
    const lockedId = (locked.revision.payload as { vectorRevisionId: string }).vectorRevisionId;
    await db.query("select fluid_private.logo_append_stage($1,$2,'refinements',$3,$4)", [OWNER_A, f.w.projectId, { rasterRevisionIds: [], vectorRevisionId: null, approvalId: null, sourceRequestKey: randomUUID() }, f.revision.inputRevisions]);
    expect(await createLogoWorkspaceService().readLogoCurrentVectorRevisionId(auth(), f.w.projectId)).toBe(lockedId);
    const next = await f.service.run(auth(), f.w.projectId, { method: "saveLogoEdit", body: { requestKey: randomUUID(), expected: (await read(f.w.projectId)).heads, baseVectorRevisionId: lockedId, edit: { kind: "color", componentId: "synthetic-lettering", fill: "#333333", stroke: null } } }) as LogoMutationReceipt;
    const newId = (next.revision.payload as { vectorRevisionId: string }).vectorRevisionId;
    const record = logoVectorRevisionSchema.parse((await db.query<{ record: unknown }>("select record from public.logo_vector_revisions where id=$1", [newId])).rows[0]!.record);
    expect(record.parentRevisionId).toBe(lockedId); expect(record.locks.map(lock => lock.componentId)).toEqual(["synthetic-symbol"]);
  });
  it("a new conversion cannot replace the active lock basis with a lockless candidate", async () => {
    const f = await published();
    const locked = await f.service.run(auth(), f.w.projectId, { method: "saveLogoEdit", body: { requestKey: randomUUID(), expected: (await read(f.w.projectId)).heads, baseVectorRevisionId: f.revision.id, edit: { kind: "locks", componentIds: ["synthetic-symbol"] } } }) as LogoMutationReceipt;
    const lockedId = (locked.revision.payload as { vectorRevisionId: string }).vectorRevisionId;
    await connection.query("select public.finish_logo_job($1,$2,'succeeded')", [f.job.id, f.job.leaseToken]);
    const q = logoCostQuoteSchema.parse(await rpc("quote_logo_operation", [f.w.projectId, { operation: "vectorize", expected: locked.workspace.heads, source: (f.job.input as { source: unknown }).source, settings: f.result.engine.settings }]));
    await rpc("admit_logo_operation", [f.w.projectId, { requestKey: randomUUID(), quoteId: q.id, acceptedMaxCostMicrousd: 0, expected: locked.workspace.heads }]);
    const job = await claim(); await begin(job, "convert-vector");
    const candidate = await publishLogoVectorResult(connection, f.source, job, f.result); await complete(job, candidate.id);
    expect(await createLogoWorkspaceService().readLogoCurrentVectorRevisionId(auth(), f.w.projectId)).toBe(lockedId);
    expect((await read(f.w.projectId)).heads).toEqual(locked.workspace.heads);
    expect((await db.query("select count(*)::int count from public.logo_vector_revisions")).rows[0]).toEqual({ count: 3 });
    const retained = (await db.query<{ record: unknown }>("select record from public.logo_vector_revisions where record#>>'{svgAsset,versionId}'=$1", [candidate.reference.versionId])).rows[0]!;
    const retainedVector = logoVectorRevisionSchema.parse(retained.record), page = await history(f.w.projectId);
    expect(page.items.find(item => item.vectorRevisionId === retainedVector.id)).toMatchObject({ selection: "retained", acceptance: "unaccepted", lockCount: 0, stageRevision: null });
    expect(page.items.find(item => item.vectorRevisionId === lockedId)).toMatchObject({ selection: "current", lockCount: 1 });
    await expect(f.service.run(auth(), f.w.projectId, { method: "acceptLogoVector", body: { requestKey: randomUUID(), expected: locked.workspace.heads, vectorRevisionId: retainedVector.id, acceptEarlierBasis: false } })).rejects.toMatchObject({ code: "locked_component_changed" });
    expect((await read(f.w.projectId)).heads).toEqual(locked.workspace.heads);
    expect((await db.query<{ record: unknown }>("select record from public.logo_vector_revisions where id=$1", [retainedVector.id])).rows[0]!.record).toEqual(retainedVector);
  });
  it("scrubs hostile default table/function grants including TRUNCATE and grant options", async () => {
    const sql = await readFile(new URL("../../supabase/migrations/20261007011500_logo_vector_publications.sql", import.meta.url), "utf8");
    const signatures = ["fluid_private.logo_vector_proof_valid(jsonb)", "fluid_private.logo_vector_member_valid(public.logo_asset_publications,uuid,uuid,uuid,jsonb,text,text)", "fluid_private.stage_logo_vector_publication(uuid,uuid,jsonb)", "fluid_private.logo_commit_vector_publication(public.jobs,uuid)", "fluid_private.logo_vector_locks_valid(jsonb)", "fluid_private.commit_logo_vector_edit(uuid,uuid,jsonb,jsonb)", "fluid_private.read_leased_logo_vector_revision(uuid,uuid,uuid)"];
    const recreate = async (migration: string) => { await db.exec(`drop function ${signatures.join(",")}; drop table fluid_private.logo_vector_publications;`); await db.exec(migration); };
    await db.exec("create role fixture_vector_hostile nologin; alter default privileges in schema fluid_private grant all on tables to fixture_vector_hostile with grant option; alter default privileges in schema fluid_private grant execute on functions to fixture_vector_hostile with grant option;");
    try {
      // Local regression control: the earlier known-role-only cleanup leaks this
      // unrelated default grantee. The actual candidate must remove it.
      const baseline = sql.slice(0, sql.indexOf("do $$declare grant_row record;signature text;begin")) + "commit;";
      await recreate(baseline);
      const privileges = () => db.query<{ table_write: boolean; call_stage: boolean }>("select has_table_privilege('fixture_vector_hostile','fluid_private.logo_vector_publications','TRUNCATE') table_write,has_function_privilege('fixture_vector_hostile','fluid_private.stage_logo_vector_publication(uuid,uuid,jsonb)','EXECUTE') call_stage");
      expect((await privileges()).rows[0]).toEqual({ table_write: true, call_stage: true });
      await recreate(sql); expect((await privileges()).rows[0]).toEqual({ table_write: false, call_stage: false });
      expect((await db.query("select count(*)::int count from pg_class c cross join lateral aclexplode(c.relacl) a where c.oid='fluid_private.logo_vector_publications'::regclass and a.grantee<>c.relowner")).rows[0]).toEqual({ count: 0 });
    } finally {
      await db.exec("alter default privileges in schema fluid_private revoke all on tables from fixture_vector_hostile; alter default privileges in schema fluid_private revoke all on functions from fixture_vector_hostile; grant execute on function fluid_private.stage_logo_vector_publication(uuid,uuid,jsonb) to fixture_vector_worker;");
    }
  });
});
