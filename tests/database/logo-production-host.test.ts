import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { SYNTHETIC_CONCEPT_READINESS } from "./logo-readiness-fixture";
import { logoCostQuoteSchema, logoDispatchReceiptSchema } from "../../src/domain/logo-jobs";
import { logoWorkspaceV2Schema, type LogoMutationReceipt } from "../../src/domain/logo-workspace";
import { logoVectorRevisionSchema } from "../../src/domain/logo-vector";
import { logoExportManifestSchema, logoVariantSetSchema, type ApprovedLogoIdentitySnapshot } from "../../src/domain/logo-deliverables";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import type { IdentityConnectionFactory } from "../../src/server/data/identity-transaction";
import { createLogoTransactionService } from "../../src/server/data/logo-transaction";
import { createLogoWorkspaceService } from "../../src/server/data/logo-workspace";
import { createLogoVectorMutationProducers } from "../../src/features/logo-vector/server/mutations";
import { verifyLogoVectorRevision } from "../../src/features/logo-vector/server/revisions";
import { createLogoDeliverableProducers } from "../../src/features/identity-deliverables/server/manual";
import { createLogoDeliverablesService } from "../../src/features/identity-deliverables/server/persistence";
import { validateLogoExportAssetBytes, inspectLogoExportArchive } from "../../src/features/identity-deliverables/server/validate-assets";
import { verifyLogoFiles } from "../../src/features/identity-deliverables/server/verify-output";
import { framedLogoDocument, logoPixelDimensions } from "../../src/features/identity-deliverables/server/render-policy";
import { LOGO_EXPORT_HANDLER_VERSION, LOGO_EXPORT_POLICY_IDENTITY } from "../../worker/handlers/logo-exports";
import { deliverableFixture, id } from "../features/identity-deliverables/fixtures";
import type { LogoWorkerConnection } from "../../src/server/data/logo-jobs";
import { createIdentityAssetStore, createPostgresIdentityAssetBackend } from "../../src/server/data/identity-asset-store";
import { validateLogoVectorSvg } from "../../src/features/logo-vector/model/svg";
import { validateLogoVectorDocument } from "../../src/features/logo-vector/model/geometry";
import { createLogoProductionConnection } from "../../worker/logo-production-connection";
import { startLogoProductionHost, type LogoProductionHost } from "../../worker/logo-production-host";
import { createLogoProductionStorageAuthorization } from "../../worker/logo-production-storage-authorization";
import { installProductionStorageFixture, authUser, sessionId } from "./logo-production-storage-fixture";
import type { IdentityPoolPort, IdentityPoolClientPort } from "../../src/server/runtime/identity-pool";
import type { LogoWorkerCapability } from "../../worker/logo-readiness";
import { parseClaimedJob } from "../../worker/postgres-store";
import { QUALIFIED_VTRACER } from "../../worker/logo-vector/engine";
import { syntheticConversionInput } from "../features/logo-vector/raster-fixtures";

/** Local disposable PostgreSQL with a synthetic original raster and in-memory
 * private blobs. Real SQL, runtime, runner, converter and grouped publication.
 * No hosted role, policy, session, provider call or credential is created. */
describe("production host with actual checked pool, qualifier, Storage authorization and durable runtime", () => {
  let db: TestDatabase;
  const workerId = "synthetic-production-host", policyIdentity = "b".repeat(64);
  const leasedChecks: string[] = [];
  let roleOid: number;
  const authorizations: NonNullable<ReturnType<typeof createLogoProductionStorageAuthorization>>[] = [];
  let serial = Promise.resolve();
  async function lock() { const before = serial; let unlock!: () => void; serial = new Promise<void>(resolve => { unlock = resolve; }); await before; return unlock; }
  async function exclusive<T>(run: () => Promise<T>) { const unlock = await lock(); try { return await run(); } finally { unlock(); } }
  let stopHost: (() => void) | undefined, stoppingAt: "finish" | "idle" = "finish";
  // PGlite has one synthetic session. This FIFO fixture pool holds it for the
  // whole acquired client, including both the principal and operation query.
  const pool: IdentityPoolPort = { async connect() {
    const unlock = await lock();
    try { await db.exec("set session authorization fluid_logo_worker_host_fixture"); } catch (error) { unlock(); throw error; }
    let release: Promise<void> | undefined;
    const reset = () => release ??= db.exec("set session authorization postgres").then(() => {}).finally(unlock);
    return Object.assign(new EventEmitter(), {
      async query(q: { text: string; values: unknown[] }) {
        const result = await db.query(q.text, q.values);
        if (stoppingAt === "finish" && q.text.includes("finish_logo_job") || stoppingAt === "idle" && q.text.includes("claim_logo_job") && !result.rows.length) stopHost?.();
        return result;
      },
      release() { void reset(); }, end: reset,
    }) satisfies IdentityPoolClientPort;
  } };
  const blobs = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  const engine = { id: "vtracer", version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm };
  const capability: LogoWorkerCapability = { operation: "identity.logo_vectorize", policyIdentity, handlerVersion: "1", provider: null, model: null, engine, maxCostMicrousd: 0 };
  const exportCapability: LogoWorkerCapability = { operation: "identity.logo_export", policyIdentity: LOGO_EXPORT_POLICY_IDENTITY,
    handlerVersion: LOGO_EXPORT_HANDLER_VERSION, provider: null, model: null, engine: null, maxCostMicrousd: 0 };
  beforeAll(async () => {
    db = await createTestDatabase(); await installProductionStorageFixture(db); await resetFixture(db);
    await db.exec(`create role fluid_logo_worker_host_fixture login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      grant usage on schema public,fluid_private to fluid_logo_worker_host_fixture;
      grant execute on function fluid_private.logo_worker_owner(),public.claim_logo_job(text,integer),public.heartbeat_logo_job(uuid,uuid,integer),
        public.register_logo_job_plan(uuid,uuid,jsonb),public.begin_logo_job_step(uuid,uuid,text,text,bigint),
        public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text),public.finish_logo_job(uuid,uuid,text),
        public.expire_logo_job_leases(),public.record_logo_provider_response(uuid,uuid,jsonb),
        public.read_leased_logo_record(uuid,uuid,text,jsonb),fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid),
        fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid),fluid_private.read_logo_asset_publication(uuid,jsonb,uuid,uuid),
        fluid_private.stage_logo_vector_publication(uuid,uuid,jsonb),public.load_logo_export_inputs(uuid,uuid),public.stage_logo_exports(uuid,uuid,jsonb) to fluid_logo_worker_host_fixture;
      create role fixture_production_web login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      grant usage on schema public,fluid_private to fixture_production_web;
      grant execute on function fluid_private.read_logo_trusted_request(uuid,jsonb),fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb),
        fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid),fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid) to fixture_production_web;`);
    await db.query("insert into fluid_private.logo_asset_web_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_production_web'", [OWNER_A]);
    await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,max_cost_microusd,enabled) values($1,'identity.logo_export',$2,$3,0,true)", [OWNER_A, LOGO_EXPORT_POLICY_IDENTITY, LOGO_EXPORT_HANDLER_VERSION]);
    await db.query("insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fluid_logo_worker_host_fixture'", [OWNER_A]);
    await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled) values($1,'identity.logo_concept',$2,'logo-image-v1','openai','gpt-image-2.5-sunburst-2026-09-08',100,true)", [OWNER_A, "a".repeat(64)]);
    await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,engine,max_cost_microusd,enabled) values($1,'identity.logo_vectorize',$2,'1',$3,0,true)", [OWNER_A, policyIdentity, engine]);
    await db.exec("grant execute on function public.report_logo_worker_ready(text,jsonb,integer) to fluid_logo_worker_host_fixture");
    expect((await connection.query<{ value: boolean }>("select public.report_logo_worker_ready($1,$2,90) value", [workerId, [SYNTHETIC_CONCEPT_READINESS, capability]])).rows[0]!.value).toBe(true);
    await db.query("insert into auth.users(id) values($1)", [authUser]);
    await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [sessionId, authUser]);
    roleOid = (await db.query<{ oid: number }>("select oid::int oid from pg_roles where rolname='fluid_logo_worker_host_fixture'")).rows[0]!.oid;
    await db.query("insert into fluid_private.logo_storage_principals(auth_user_id,owner_id,role_name,role_oid,worker_id,enabled) values($1,$2,'fluid_logo_worker_host_fixture',$3,$4,true)", [authUser, OWNER_A, roleOid, workerId]);
    for (const selected of [capability, exportCapability]) await db.query("insert into fluid_private.logo_production_storage_capabilities(auth_user_id,operation,policy_identity,enabled) values($1,$2,$3,true)", [authUser, selected.operation, selected.policyIdentity]);
  }, 60_000);
  afterAll(async () => { authorizations.forEach(authorization => authorization.close()); await serial; await db?.close(); });
  const connection: LogoWorkerConnection = { async query<Row>(sql: string, parameters?: unknown[]) {
    await db.exec("set session authorization fluid_logo_worker_host_fixture");
    try { return await db.query<Row>(sql, parameters); }
    finally { await db.exec("set session authorization postgres"); }
  } };
  const owned: IdentityConnectionFactory = { async acquire(ownerId) {
    if (ownerId !== OWNER_A) throw Error("Foreign synthetic web owner");
    const role = (await db.query<{ oid: number }>("select oid from pg_roles where rolname='fixture_production_web'")).rows[0]!;
    await db.exec("set session authorization fixture_production_web");
    return { binding: { ownerId, roleName: "fixture_production_web", roleOid: role.oid }, connection: {
      query: (sql, args) => db.query(sql, args ? [...args] : undefined),
      release: async () => { await db.exec("set session authorization postgres"); }, discard: async () => { await db.exec("set session authorization postgres"); },
    } };
  } };
  const assets = createIdentityAssetStore({ backend: createPostgresIdentityAssetBackend({ owned, worker: connection }),
    validateBytes: async (write, bytes, signal) => {
      const mime = write.kind === "stage" ? write.publication.mimeType : write.intent.mimeType;
      if (["application/pdf", "application/zip"].includes(mime)) await validateLogoExportAssetBytes(write, bytes, signal);
    }, storage: {
    async putIfAbsent(path, bytes, mimeType) {
      const prior = blobs.get(path);
      if (prior && (prior.mimeType !== mimeType || !Buffer.from(prior.bytes).equals(Buffer.from(bytes)))) throw Error("Immutable synthetic object");
      if (!prior) {
        blobs.set(path, { bytes: Uint8Array.from(bytes), mimeType });
        // Synthetic owner-upload transport for original/manual source material.
        // Production outputs below use the actual restricted Storage RPC/RLS.
        await db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2) on conflict do nothing", [path, OWNER_A]);
      }
    },
    async read(path) { const file = blobs.get(path); if (!file) throw Error("Missing synthetic object"); return { ...file, bytes: Uint8Array.from(file.bytes) }; },
  } });
  const rpc = (name: string, args: unknown[], owner = OWNER_A) => asRole(db, "authenticated", owner, async () =>
    (await db.query<{ value: unknown }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`, args)).rows[0]!.value);
  const workspace = async (projectId: string) => logoWorkspaceV2Schema.parse(await rpc("get_logo_workspace", [projectId]));
  function auth(): AuthenticatedContext {
    return { userId: OWNER_A, client: { rpc(name: string, args: Record<string, unknown>) {
      if (!/^[a-z_]+$/.test(name) || Object.keys(args).some(key => !/^p_[a-z_]+$/.test(key))) throw Error("Invalid local fixture RPC");
      const result = asRole(db, "authenticated", OWNER_A, async () => (await db.query<{ value: unknown }>(
        `select public.${name}(${Object.keys(args).map((key, i) => `${key} => $${i + 1}`).join(",")}) value`, Object.values(args))).rows[0]!.value)
        .then(data => ({ data, error: null })).catch(error => ({ data: null, error }));
      return Object.assign(result, { abortSignal: () => result });
    } } } as unknown as AuthenticatedContext;
  }
  const claims = { sub: authUser, session_id: sessionId, role: "authenticated", aud: "authenticated", iss: "https://fricsfwqibyhemknqgyf.supabase.co/auth/v1", exp: 2_000_000_000, is_anonymous: false };
  const token = `${Buffer.from('{"alg":"ES256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic_signature`;
  async function storageAuth<T>(run: () => Promise<T>, operation?: string): Promise<T> {
    return exclusive(async () => {
      await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claims)]);
      await db.query("select set_config('storage.operation',$1,false)", [operation ?? ""]);
      try { return await asRole(db, "authenticated", authUser, run); }
      finally { await db.query("select set_config('request.jwt.claims','',false),set_config('storage.operation','',false)"); }
    });
  }
  const transport: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: authUser, is_anonymous: false });
    if (url.endsWith("/rpc/authorize_logo_production_storage")) {
      const b = JSON.parse(String(init.body));
      const value = await storageAuth(async () => (await db.query<{ value: unknown }>("select public.authorize_logo_production_storage($1,$2,$3,$4) value", [b.p_job,b.p_lease,b.p_reservation,b.p_mode])).rows[0]!.value);
      return Response.json(value);
    }
    const path = url.split("/storage/v1/object/fluid-assets/")[1]; if (!path) throw Error("Unexpected synthetic HTTP target");
    if (init.method === "POST") {
      try { await storageAuth(() => db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [path, authUser]), "object.upload"); }
      catch (error) { if ((error as { code?: string }).code === "23505") return Response.json({ code: "ResourceAlreadyExists" }, { status: 409 }); throw error; }
      blobs.set(path, { bytes: new Uint8Array(init.body as Uint8Array), mimeType: new Headers(init.headers).get("content-type")! });
      return Response.json({ Id: randomUUID(), Key: `fluid-assets/${path}` });
    }
    if (init.method !== "GET") throw Error("Unexpected synthetic storage method");
    const visible = await storageAuth(() => db.query("select name from storage.objects where name=$1", [path]), "object.get_authenticated");
    const file = blobs.get(path); if (!visible.rows.length || !file) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(file.bytes), { headers: { "content-type": file.mimeType } });
  };
  async function start() {
    const operation = (selected: LogoWorkerCapability) => {
      const authorization = createLogoProductionStorageAuthorization({ ownerId: OWNER_A, authUserId: authUser, workerRoleName: "fluid_logo_worker_host_fixture",
        workerRoleOid: roleOid, workerId, publishableKey: "sb_publishable_synthetic", accessToken: token, capability: selected }, { fetch: transport })!;
      authorizations.push(authorization);
      return { capability: selected, authorization: { ...authorization, async assertAvailable(job: Parameters<typeof authorization.assertAvailable>[0]) {
        await authorization.assertAvailable(job); leasedChecks.push(job.operation);
      } } };
    };
    const host = await startLogoProductionHost({ enabled: true, binding: { ownerId: OWNER_A, roleName: "fluid_logo_worker_host_fixture", roleOid }, pool, workerId,
      vector: operation(capability), exports: operation(exportCapability) });
    expect(host.status).toBe("qualified"); if (host.status !== "qualified") throw Error(`Local host unavailable: ${JSON.stringify(host)}`); return host;
  }
  async function runUntil(host: Extract<LogoProductionHost, { status: "qualified" }>, mode: "finish" | "idle") {
    const controller = new AbortController(); stoppingAt = mode; stopHost = () => controller.abort();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try { await host.run(controller.signal); } finally { clearTimeout(timer); await host.close(); await serial; stopHost = undefined; }
  }
  it("converts to review_required, then exports the exact separately approved and reviewed version with real files", async () => {
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
    const started = await start();
    try { await runUntil(started, "finish"); }
    finally { await started.close(); }
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
    expect(blobs.size).toBe(3); expect(new Set(leasedChecks)).toEqual(new Set(["identity.logo_vectorize"]));
    await expect(rpc("read_logo_asset", [revision.svgAsset], OWNER_B)).rejects.toBeDefined();
    expect((await db.query("select has_function_privilege('fixture_subscription_worker_a','public.claim_logo_job(text,integer)','execute') as allowed")).rows[0]).toEqual({ allowed: false });

    // Explicit synthetic owner actions begin only after the no-autoapproval
    // assertions above. These do not represent real user/provider approvals.
    const reads = createLogoWorkspaceService({ assetStore: assets, verifyVectorRevision: verifyLogoVectorRevision });
    const deliverables = createLogoDeliverablesService({ assets });
    const transactions = createLogoTransactionService(owned, {
      ...createLogoVectorMutationProducers({ assetStore: assets, readVectorDetail: reads.readLogoVectorDetail,
        getWorkspace: reads.getLogoWorkspace, readCurrentVectorRevisionId: reads.readLogoCurrentVectorRevisionId, readStageRevision: reads.getLogoStageRevision }),
      ...createLogoDeliverableProducers({ assets, service: deliverables }),
    });
    const accepted = await transactions.run(auth(), initial.projectId, { method: "acceptLogoVector", body: {
      requestKey: randomUUID(), expected: (await workspace(initial.projectId)).heads, vectorRevisionId: revision.id, acceptEarlierBasis: false,
    } }) as LogoMutationReceipt;
    expect(accepted.workspace.approvedLogo!.vectorRevisionId).toBe(revision.id);
    // Only downstream direction/font metadata is seeded. Logo geometry/approval,
    // variant previews/reviews and exported bytes all use their real boundaries.
    const approval = accepted.workspace.approvedLogo!;
    const direction = JSON.parse(JSON.stringify(deliverableFixture("mascot"))
      .replaceAll(id(1), OWNER_A).replaceAll(id(2), initial.projectId).replaceAll(id(7), approval.id)) as ApprovedLogoIdentitySnapshot;
    for (const [kind, record] of [["palette", direction.palette], ["typography", direction.typography], ["graphics", direction.graphics],
      ["selection", direction.directionSelection], ["approval", direction.directionApproval]] as const) {
      await db.query("insert into public.logo_direction_records(id,owner_id,project_id,kind,approved_logo_id,record) values($1,$2,$3,$4,$5,$6)",
        [record.id, OWNER_A, initial.projectId, kind, approval.id, record]);
    }
    for (const font of direction.fonts) await db.query("insert into public.logo_font_records(record_id,version_id,owner_id,project_id,record) values($1,$2,$3,$4,$5)",
      [font.id, font.asset.versionId, OWNER_A, initial.projectId, font]);
    await db.query("select fluid_private.logo_append_stage($1,$2,'directions',$3,$4)", [OWNER_A, initial.projectId,
      { directionIds: [id(501), id(502), id(503)], selectionId: direction.directionSelection.id, approvalId: direction.directionApproval.id },
      [{ stage: "brief_references", id: initial.stages.brief_references!.id, revision: 1 },
        { stage: "vector", id: accepted.workspace.stages.vector!.id, revision: accepted.workspace.stages.vector!.revision }]]);
    const set = logoVariantSetSchema.parse(await transactions.run(auth(), initial.projectId, { method: "prepareLogoVariants", body: {
      requestKey: randomUUID(), expected: (await workspace(initial.projectId)).heads, approvedLogoId: approval.id, directionApprovalId: direction.directionApproval.id,
    } }));
    await transactions.run(auth(), initial.projectId, { method: "reviewLogoVariants", body: { requestKey: randomUUID(),
      expected: (await workspace(initial.projectId)).heads, approvedLogoId: approval.id, directionApprovalId: direction.directionApproval.id,
      variantSetId: set.id, acceptedVariantIds: set.items.filter(item => item.applicability.status === "applicable").map(item => item.id),
    } });
    const beforeExport = await workspace(initial.projectId);
    await runUntil(await start(), "idle");
    const exporting = await start();
    try {
      const request = { requestKey: randomUUID(), expected: beforeExport.heads, approvedLogoId: approval.id,
        directionApprovalId: direction.directionApproval.id, variantSetId: set.id, pngLongEdge: 512, socialSelections: [] };
      const receipt = logoDispatchReceiptSchema.parse(await rpc("request_logo_export", [initial.projectId, request]));
      await runUntil(exporting, "finish");
      expect(new Set(leasedChecks)).toEqual(new Set(["identity.logo_vectorize", "identity.logo_export"]));
      expect(await rpc("request_logo_export", [initial.projectId, request])).toEqual(receipt);
      const exports = await db.query<{ record: unknown }>("select record from public.logo_export_manifests");
      expect(exports.rows).toHaveLength(1);
      const manifest = logoExportManifestSchema.parse(exports.rows[0]!.record);
      expect(manifest.approvedLogoId).toBe(approval.id); expect(manifest.variantSetId).toBe(set.id);
      expect((await workspace(initial.projectId)).approvedLogo).toEqual(approval);
      expect((await db.query<{ record: unknown }>("select record from public.logo_vector_revisions where id=$1", [revision.id])).rows[0]!.record).toEqual(revision);
      expect(bytes(original.reference)).toEqual(originalBytes);
      expect((await db.query("select state,actual_cost_microusd from public.jobs where id=$1", [receipt.jobIds[0]])).rows[0]).toEqual({ state: "succeeded", actual_cost_microusd: 0 });
      for (const file of manifest.files) expect(createHash("sha256").update(bytes(file.asset.reference)).digest("hex")).toBe(file.asset.reference.contentHash);
      const resolved = await deliverables.resolveLogoVariantSet(auth(), initial.projectId, set.id);
      const color = resolved.items.find(item => item.variant.role === "primary" && item.variant.colorway === "color")!;
      const review = (await db.query<{ record: unknown }>("select record from public.logo_variant_reviews where variant_set_id=$1", [set.id])).rows[0]!.record;
      const { logoVariantReviewSchema } = await import("../../src/domain/logo-deliverables");
      const source = { variant: color.variant, document: color.document!, review: logoVariantReviewSchema.parse(review) };
      const member = (mime: string) => bytes(manifest.files.find(file => file.variantId === color.variant.id && file.asset.verification.mimeType === mime)!.asset.reference);
      const verification = await verifyLogoFiles({ svg: member("image/svg+xml"), pdf: member("application/pdf"), png: member("image/png"),
        ...logoPixelDimensions(framedLogoDocument(color.document!, color.variant.clearSpace), 512), variantHash: color.variant.renderHash! }, source, { pngLongEdge: 512 });
      expect(verification.svg.pathCount).toBeGreaterThan(0); expect(verification.pdf.pathPaintCount).toBeGreaterThan(0);
      expect(verification.pdf.rasterPaintCount).toBe(0); expect(verification.png.hasTransparentPixels).toBe(true);
      const pack = bytes(manifest.files.find(file => file.role === "pack")!.asset.reference);
      expect(Object.keys(inspectLogoExportArchive(pack))).toHaveLength(11);
      await expect(rpc("get_logo_export", [initial.projectId, manifest.id], OWNER_B)).rejects.toBeDefined();
      const directory = ".tmp/logo-production-host"; await mkdir(directory, { recursive: true });
      await Promise.all([writeFile(`${directory}/synthetic-original.png`, originalBytes), writeFile(`${directory}/synthetic-converted.svg`, bytes(revision.svgAsset)),
        writeFile(`${directory}/synthetic-primary-color.svg`, member("image/svg+xml")), writeFile(`${directory}/synthetic-primary-color.pdf`, member("application/pdf")),
        writeFile(`${directory}/synthetic-primary-color.png`, member("image/png")), writeFile(`${directory}/synthetic-logo-pack.zip`, pack),
        writeFile(`${directory}/synthetic-evidence.json`, JSON.stringify({ fixture: "Disposable local database and in-memory private blobs; no hosted/provider activity",
          originalHash: original.reference.contentHash, vectorRevision: revision, manifest, colorVerification: verification }, null, 2) + "\n")]);
    } finally { await exporting.close(); }
  }, 120_000);
  it("rejects actual SQL owner, role and OID mismatches on the same restricted acquired session", async () => {
    for (const binding of [
      { ownerId: OWNER_B, roleName: "fluid_logo_worker_host_fixture", roleOid },
      { ownerId: OWNER_A, roleName: "fluid_logo_worker_other_fixture", roleOid },
      { ownerId: OWNER_A, roleName: "fluid_logo_worker_host_fixture", roleOid: roleOid + 1 },
    ]) {
      const checked = createLogoProductionConnection({ ...binding, pool })!;
      await expect(checked.query("select 'must not dispatch' as value")).rejects.toThrow("Logo production connection is unavailable.");
      await checked.close(); await serial;
    }
    await db.exec("alter role fluid_logo_worker_host_fixture bypassrls");
    const checked = createLogoProductionConnection({ ownerId: OWNER_A, roleName: "fluid_logo_worker_host_fixture", roleOid, pool })!;
    try { await expect(checked.query("select 'must not dispatch' as value")).rejects.toThrow("Logo production connection is unavailable."); }
    finally { await checked.close(); await serial; await db.exec("alter role fluid_logo_worker_host_fixture nobypassrls"); }
  });

});
