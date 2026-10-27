import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { reportLogoFixtureReady, SYNTHETIC_CONCEPT_READINESS } from "./logo-readiness-fixture";
import { legacyLogoCostQuoteSchema as logoCostQuoteSchema, logoDispatchReceiptSchema } from "../../src/domain/logo-jobs";
import { logoWorkspaceV2Schema } from "../../src/domain/logo-workspace";
import { logoVectorRevisionSchema } from "../../src/domain/logo-vector";
import type { LogoWorkerConnection } from "../../src/server/data/logo-jobs";
import { createIdentityAssetStore, createPostgresIdentityAssetBackend } from "../../src/server/data/identity-asset-store";
import { validateLogoVectorSvg } from "../../src/features/logo-vector/model/svg";
import { validateLogoVectorDocument } from "../../src/features/logo-vector/model/geometry";
import { createLogoVectorRuntimeAdapter } from "../../worker/logo-vector/runtime-adapter";
import { createLogoWorkerRuntime } from "../../worker/logo-runtime";
import { parseClaimedJob } from "../../worker/postgres-store";
import { QUALIFIED_VTRACER } from "../../worker/logo-vector/engine";
import { syntheticConversionInput } from "../features/logo-vector/raster-fixtures";

/** Local disposable PostgreSQL with a synthetic original raster and in-memory
 * private blobs. Real SQL, runtime, runner, converter and grouped publication.
 * No hosted role, policy, session, provider call or credential is created. */
describe("vector adapter through the actual local durable runtime", () => {
  let db: TestDatabase;
  const workerId = "synthetic-vector-adapter", policyIdentity = "b".repeat(64);
  const blobs = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  const engine = { id: "vtracer", version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm };
  const capability = { operation: "identity.logo_vectorize", policyIdentity, handlerVersion: "1", provider: null, model: null, engine, maxCostMicrousd: 0 };
  beforeAll(async () => {
    db = await createTestDatabase(); await resetFixture(db);
    await db.exec(`create role fixture_vector_adapter_worker login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      grant usage on schema public,fluid_private to fixture_vector_adapter_worker;
      grant execute on function public.claim_logo_job(text,integer),public.heartbeat_logo_job(uuid,uuid,integer),
        public.register_logo_job_plan(uuid,uuid,jsonb),public.begin_logo_job_step(uuid,uuid,text,text,bigint),
        public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text),public.finish_logo_job(uuid,uuid,text),
        public.expire_logo_job_leases(),public.record_logo_provider_response(uuid,uuid,jsonb),
        public.read_leased_logo_record(uuid,uuid,text,jsonb),fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid),
        fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid),fluid_private.read_logo_asset_publication(uuid,jsonb,uuid,uuid),
        fluid_private.stage_logo_vector_publication(uuid,uuid,jsonb) to fixture_vector_adapter_worker;`);
    await db.query("insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_vector_adapter_worker'", [OWNER_A]);
    await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled) values($1,'identity.logo_concept',$2,'logo-image-v1','openai','gpt-image-2.5-sunburst-2026-09-08',100,true)", [OWNER_A, "a".repeat(64)]);
    await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,engine,max_cost_microusd,enabled) values($1,'identity.logo_vectorize',$2,'1',$3,0,true)", [OWNER_A, policyIdentity, engine]);
    await reportLogoFixtureReady(db, "fixture_vector_adapter_worker", [workerId], [SYNTHETIC_CONCEPT_READINESS, capability]);
  }, 60_000);
  afterAll(async () => { await db?.close(); });
  const connection: LogoWorkerConnection = { async query<Row>(sql: string, parameters?: unknown[]) {
    await db.exec("set session authorization fixture_vector_adapter_worker");
    try { return await db.query<Row>(sql, parameters); }
    finally { await db.exec("set session authorization postgres"); }
  } };
  const assets = createIdentityAssetStore({ backend: createPostgresIdentityAssetBackend({ owned: null, worker: connection }), storage: {
    async putIfAbsent(path, bytes, mimeType) {
      const prior = blobs.get(path);
      if (prior && (prior.mimeType !== mimeType || !Buffer.from(prior.bytes).equals(Buffer.from(bytes)))) throw Error("Immutable synthetic object");
      if (!prior) blobs.set(path, { bytes: Uint8Array.from(bytes), mimeType });
    },
    async read(path) { const file = blobs.get(path); if (!file) throw Error("Missing synthetic object"); return { ...file, bytes: Uint8Array.from(file.bytes) }; },
  } });
  const rpc = (name: string, args: unknown[], owner = OWNER_A) => asRole(db, "authenticated", owner, async () =>
    (await db.query<{ value: unknown }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`, args)).rows[0]!.value);
  const workspace = async (projectId: string) => logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace", [projectId]));
  it("claims a vector job, traces the frozen raster and commits a review-required revision without accepting it", async () => {
    const initial = logoWorkspaceV2Schema.parse(await rpc("start_logo_project", [{ requestKey: randomUUID(), brief: {
      name: "Synthetic vector adapter", activity: "Local test", audience: "Testers", personality: "Calm", logoTypes: ["mascot"],
    } }]));
    const reference = (await db.query<{ reference_snapshot_id: string }>("select reference_snapshot_id from public.logo_stage_revisions where id=$1", [initial.stages.brief_references!.id])).rows[0]!;
    const quote = logoCostQuoteSchema.parse(await rpc("quote_logo_operation", [initial.projectId, { operation: "concepts", expected: initial.heads,
      briefRevisionId: initial.stages.brief_references!.id, referenceSnapshotId: reference.reference_snapshot_id }]));
    const admission = logoDispatchReceiptSchema.parse(await rpc("admit_logo_operation", [initial.projectId, { requestKey: randomUUID(), quoteId: quote.id, acceptedMaxCostMicrousd: quote.maxCostMicrousd, expected: initial.heads }]));
    const concept = parseClaimedJob((await connection.query("select * from public.claim_logo_job($1,300)", [workerId])).rows[0]);
    const conceptInput = concept.input as { attemptId: string; slotId: string; batchId: string };
    const stepKey = `logo-preview-v1:${conceptInput.slotId}:${conceptInput.attemptId}`;
    await connection.query("select public.begin_logo_job_step($1,$2,$3,$4,100)", [concept.id, concept.leaseToken, stepKey, `${concept.id}:${stepKey}`]);
    const raster = syntheticConversionInput("mascot"), originalBytes = Uint8Array.from(raster.source.bytes);
    const revisions = (await connection.query<{ value: [] }>("select public.read_leased_logo_record($1,$2,'input_revisions',null) value", [concept.id, concept.leaseToken])).rows[0]!.value;
    const original = await assets.publishLeasedAsset(concept, { requestKey: randomUUID(), inputRevisions: revisions,
      mimeType: "image/png", contentHash: raster.source.reference.contentHash, byteLength: originalBytes.length,
      source: { kind: "concept", sourceId: conceptInput.attemptId } }, originalBytes);
    // This synthetic receipt only seeds a local raster source; no generation is performed.
    const provider = (await connection.query<{ value: { id: string } }>("select public.record_logo_provider_response($1,$2,$3) value", [concept.id, concept.leaseToken, {
      provider: "openai", model: "gpt-image-2.5-sunburst-2026-09-08", providerRequestId: "synthetic-not-a-provider-call",
      responseHash: "c".repeat(64), observedAt: "2026-10-07T00:00:00Z", billing: { status: "recorded", confirmedMicrousd: 1 },
      artifactHash: original.reference.contentHash, normalizedPixelHash: "d".repeat(64),
    }])).rows[0]!.value;
    await connection.query("select public.complete_logo_job_step($1,$2,$3,'succeeded',1,$4,'synthetic-not-a-provider-call')", [concept.id, concept.leaseToken, stepKey, {
      version: 2, kind: "logo_concept", batchId: conceptInput.batchId, slotId: conceptInput.slotId, attemptId: conceptInput.attemptId, publicationId: original.id, providerResponseReceiptId: provider.id,
    }]);
    await connection.query("select public.finish_logo_job($1,$2,'succeeded')", [concept.id, concept.leaseToken]);
    for (const jobId of admission.jobIds.filter(id => id !== concept.id)) await rpc("request_job_cancel", [jobId]);
    const source = { kind: "concept", batchId: conceptInput.batchId, slotId: conceptInput.slotId, attemptId: conceptInput.attemptId };
    await rpc("apply_logo_workspace_command", [initial.projectId, { method: "selectLogoRaster", body: { requestKey: randomUUID(), expected: initial.heads, source } }]);
    const selected = await workspace(initial.projectId);
    const vectorQuote = logoCostQuoteSchema.parse(await rpc("quote_logo_operation", [initial.projectId, { operation: "vectorize", expected: selected.heads, source, settings: raster.settings }]));
    const vector = logoDispatchReceiptSchema.parse(await rpc("admit_logo_operation", [initial.projectId, { requestKey: randomUUID(), quoteId: vectorQuote.id, acceptedMaxCostMicrousd: 0, expected: selected.heads }]));
    const adapter = createLogoVectorRuntimeAdapter({ ownerId: OWNER_A, policyIdentity, connection, assets,
      async assertAvailable(job) { if (job.ownerId !== OWNER_A || !blobs.size) throw Error("Synthetic local storage unavailable"); } })!;
    const runtime = createLogoWorkerRuntime({ connection, workerId, manifest: [adapter.capability], composition: {
      concepts: null, refinements: null, vector: adapter.dependencies, directions: null, exports: null, unavailableReasons: {},
    } });
    try { expect(await runtime.tick()).toBe("succeeded"); expect(await runtime.tick()).toBe("idle"); }
    finally { await runtime.close(); }
    const records = await db.query<{ record: unknown }>("select record from public.logo_vector_revisions");
    expect(records.rows).toHaveLength(1);
    const revision = logoVectorRevisionSchema.parse(records.rows[0]!.record);
    expect(revision.sourcePreview).toEqual(original.reference); expect(revision.reviewStatus).toBe("review_required");
    expect(revision.ownerId).toBe(OWNER_A); expect(revision.projectId).toBe(initial.projectId); expect(revision.source).toEqual(source);
    expect((await workspace(initial.projectId)).approvedLogo).toBeNull();
    const bytes = (reference: typeof original.reference) => blobs.get(`${reference.ownerId}/${reference.projectId}/${reference.assetId}/${reference.versionId}`)!.bytes;
    expect(bytes(original.reference)).toEqual(originalBytes);
    expect(createHash("sha256").update(bytes(revision.svgAsset)).digest("hex")).toBe(revision.svgAsset.contentHash);
    expect(createHash("sha256").update(bytes(revision.documentAsset)).digest("hex")).toBe(revision.documentHash);
    const svg = validateLogoVectorSvg(bytes(revision.svgAsset)), document = validateLogoVectorDocument(JSON.parse(new TextDecoder().decode(bytes(revision.documentAsset))));
    expect(svg.components.flatMap(c => c.paths).length).toBeGreaterThan(0); expect(document.components.flatMap(c => c.paths).length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes(revision.svgAsset))).not.toMatch(/<(image|text|use)\b/);
    expect((await db.query("select state,actual_cost_microusd from public.jobs where id=$1", [vector.jobIds[0]])).rows[0]).toEqual({ state: "succeeded", actual_cost_microusd: 0 });
    expect(blobs.size).toBe(3);
    await expect(rpc("read_logo_asset", [revision.svgAsset], OWNER_B)).rejects.toBeDefined();
    expect((await db.query("select has_function_privilege('fixture_subscription_worker_a','public.claim_logo_job(text,integer)','execute') as allowed")).rows[0]).toEqual({ allowed: false });
  }, 30_000);
});
