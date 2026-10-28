import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { SYNTHETIC_CONCEPT_READINESS } from "./logo-readiness-fixture";
import { legacyLogoCostQuoteSchema as logoCostQuoteSchema, logoDispatchReceiptSchema, logoDirectionsSubscriptionPolicySchema } from "../../src/domain/logo-jobs";
import { logoWorkspaceV2Schema, type LogoMutationReceipt } from "../../src/domain/logo-workspace";
import { logoVectorRevisionSchema } from "../../src/domain/logo-vector";
import { logoExportManifestSchema, logoVariantSetSchema } from "../../src/domain/logo-deliverables";
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
import type { LogoWorkerConnection } from "../../src/server/data/logo-jobs";
import { createIdentityAssetStore, createPostgresIdentityAssetBackend } from "../../src/server/data/identity-asset-store";
import { validateLogoVectorSvg } from "../../src/features/logo-vector/model/svg";
import { validateLogoVectorDocument } from "../../src/features/logo-vector/model/geometry";
import { createLogoProductionConnection } from "../../worker/logo-production-connection";
import { startLogoProductionHost, type LogoProductionHost } from "../../worker/logo-production-host";
import { createLogoProductionStorageAuthorization } from "../../worker/logo-production-storage-authorization";
import { installDirectionsStorageFixture, authUser, sessionId } from "./logo-directions-storage-fixture";
import { sqlSubscriptionPolicy, sqlPolicyIdentity } from "./logo-directions-subscription-fixture";
import { createLogoDirectionsStorageAuthorization } from "../../worker/logo-directions-storage-authorization";
import { createChatGPTTransport } from "../../src/server/ai/chatgpt-transport";
import { prepareDirectionEvidence } from "../../src/features/identity-directions/server/evidence-producer";
import { createLogoGenerativeStorageAuthorization } from "../../worker/logo-generative-storage-authorization";
import { createLogoInputService, validateLogoInputBytes } from "../../src/server/data/logo-inputs";
import { identityAssetReceiptSchema } from "../../src/domain/logo-deliverables";
import { SUNBURST_STANDARD_IMAGE_PRICING } from "../../src/server/logo-creation/openai-image-pricing";
import type { OpenAIImageTransport } from "../../src/server/logo-creation/openai-image-transport";
import type { IdentityPoolPort, IdentityPoolClientPort } from "../../src/server/runtime/identity-pool";
import type { LogoWorkerCapability } from "../../worker/logo-readiness";
import { QUALIFIED_VTRACER } from "../../worker/logo-vector/engine";
import { syntheticConversionInput, syntheticPng } from "../features/logo-vector/raster-fixtures";

/** Local disposable PostgreSQL with a synthetic original raster and in-memory
 * private blobs. Real SQL, both brokers, provider factory, image handlers,
 * runtime, runner, converter and grouped publication. Auth/Storage HTTP and image
 * responses are synthetic; SQL/RLS and all production code execute normally.
 * Direction records, canonical free-font imports, owner selection and approval
 * all execute actual production code; none are seeded or automatically approved.
 * No hosted role, policy, session, provider call or credential is created. */
describe("five-operation host with actual direction production, owner approval and verified export", () => {
  let db: TestDatabase;
  const workerId = "synthetic-five-operation-host", policyIdentity = "b".repeat(64);
  const leasedChecks: string[] = [];
  let roleOid: number;
  const authorizations: { close(): void }[] = [];
  const reports: unknown[] = [];
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
        if (q.text.includes("report_logo_worker_ready")) reports.push(JSON.parse(q.values[1] as string));
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
  const refinementCapability: LogoWorkerCapability = { ...SYNTHETIC_CONCEPT_READINESS, operation: "identity.logo_refine", policyIdentity: "e".repeat(64) };
  const policy = logoDirectionsSubscriptionPolicySchema.parse(sqlSubscriptionPolicy());
  let directionsCapability: LogoWorkerCapability;
  const union = () => [SYNTHETIC_CONCEPT_READINESS, refinementCapability, capability, directionsCapability, exportCapability];
  beforeAll(async () => {
    db = await createTestDatabase(); await installDirectionsStorageFixture(db); await resetFixture(db);
    await db.exec(`create role fluid_logo_worker_host_fixture login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      grant usage on schema public,fluid_private to fluid_logo_worker_host_fixture;
      grant execute on function fluid_private.logo_worker_owner(),public.claim_logo_job(text,integer),public.heartbeat_logo_job(uuid,uuid,integer),
        public.register_logo_job_plan(uuid,uuid,jsonb),public.begin_logo_job_step(uuid,uuid,text,text,bigint),
        public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text),public.finish_logo_job(uuid,uuid,text),
        public.expire_logo_job_leases(),public.record_logo_provider_response(uuid,uuid,jsonb),
        public.load_logo_direction_inputs(uuid,uuid),public.stage_logo_directions(uuid,uuid,jsonb,uuid,jsonb),
        public.read_leased_logo_record(uuid,uuid,text,jsonb),fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid),
        fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid),fluid_private.read_logo_asset_publication(uuid,jsonb,uuid,uuid),
        fluid_private.stage_logo_vector_publication(uuid,uuid,jsonb),public.load_logo_export_inputs(uuid,uuid),public.stage_logo_exports(uuid,uuid,jsonb) to fluid_logo_worker_host_fixture;
      create role fixture_production_web login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      grant usage on schema public,fluid_private to fixture_production_web;
      grant execute on function fluid_private.read_logo_trusted_request(uuid,jsonb),fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb),
        fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid),fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid),
        fluid_private.prepare_logo_input(uuid,jsonb),fluid_private.commit_logo_input(uuid,jsonb,jsonb,jsonb) to fixture_production_web;`);
    await db.query("insert into fluid_private.logo_asset_web_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_production_web'", [OWNER_A]);
    await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,max_cost_microusd,enabled) values($1,'identity.logo_export',$2,$3,0,true)", [OWNER_A, LOGO_EXPORT_POLICY_IDENTITY, LOGO_EXPORT_HANDLER_VERSION]);
    await db.query("insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fluid_logo_worker_host_fixture'", [OWNER_A]);
    await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled) values($1,'identity.logo_concept',$2,'logo-image-v1','openai','gpt-image-2.5-sunburst-2026-09-08',100,true)", [OWNER_A, "a".repeat(64)]);
    await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,engine,max_cost_microusd,enabled) values($1,'identity.logo_vectorize',$2,'1',$3,0,true)", [OWNER_A, policyIdentity, engine]);
    await db.exec("grant execute on function public.report_logo_worker_ready(text,jsonb,integer) to fluid_logo_worker_host_fixture");
    await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled) values($1,'identity.logo_refine',$2,'logo-image-v1','openai','gpt-image-2.5-sunburst-2026-09-08',100,true)", [OWNER_A, "e".repeat(64)]);
    await db.query("insert into auth.users(id) values($1)", [authUser]);
    await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [sessionId, authUser]);
    roleOid = (await db.query<{ oid: number }>("select oid::int oid from pg_roles where rolname='fluid_logo_worker_host_fixture'")).rows[0]!.oid;
    await db.query("insert into fluid_private.logo_storage_principals(auth_user_id,owner_id,role_name,role_oid,worker_id,enabled) values($1,$2,'fluid_logo_worker_host_fixture',$3,$4,true)", [authUser, OWNER_A, roleOid, workerId]);
    const directionsPolicyIdentity = await sqlPolicyIdentity(db, policy);
    directionsCapability = { operation: "identity.logo_directions", policyIdentity: directionsPolicyIdentity, handlerVersion: policy.handlerVersion,
      provider: "openai", model: policy.model, engine: null, maxCostMicrousd: 0, billingMode: "chatgpt_subscription", policy };
    await db.query("insert into fluid_private.subscription_registrations(registration_id,owner_id,connected,plan_usage_enabled) values($1,$2,true,true)", [policy.registrationId, OWNER_A]);
    await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled,subscription_policy) values($1,'identity.logo_directions',$2,$3,'openai',$4,0,true,$5)", [OWNER_A, directionsPolicyIdentity, policy.handlerVersion, policy.model, policy]);
    await db.query("insert into fluid_private.logo_directions_storage_capabilities(auth_user_id,policy_identity,enabled) values($1,$2,true)", [authUser, directionsPolicyIdentity]);
    for (const selected of [SYNTHETIC_CONCEPT_READINESS, refinementCapability]) await db.query("insert into fluid_private.logo_generative_storage_capabilities(auth_user_id,operation,policy_identity,enabled) values($1,$2,$3,true)", [authUser, selected.operation, selected.policyIdentity]);
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
      if (write.kind === "upload") await validateLogoInputBytes(write, bytes, signal);
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
    if (url.endsWith("/rpc/authorize_logo_production_storage") || url.endsWith("/rpc/authorize_logo_generative_storage") || url.endsWith("/rpc/authorize_logo_directions_storage")) {
      const b = JSON.parse(String(init.body));
      const sql = url.endsWith("/rpc/authorize_logo_directions_storage") ? "select public.authorize_logo_directions_storage($1,$2,$3,$4) value" : url.endsWith("/rpc/authorize_logo_generative_storage") ? "select public.authorize_logo_generative_storage($1,$2,$3,$4) value" : "select public.authorize_logo_production_storage($1,$2,$3,$4) value";
      const value = await storageAuth(async () => (await db.query<{ value: unknown }>(sql, [b.p_job,b.p_lease,b.p_reservation,b.p_mode])).rows[0]!.value);
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
  let imageOrdinal = 0;
  const createImage = vi.fn<OpenAIImageTransport["createImage"]>(async (input, requestId) => {
    const count = ++imageOrdinal;
    const output = syntheticPng(1024, 1024, (x, y) => (x - 512) ** 2 + (y - 512) ** 2 < (180 + count * 14) ** 2
      && !(x > 480 && x < 544 && y < 480) ? [0, 0, 0, 255] : [255, 255, 255, 255]);
    return { bytes: output, mimeType: "image/png", providerRequestId: `synthetic-${requestId}`,
      responseHash: createHash("sha256").update(`synthetic-${count}`).digest("hex"),
      usage: { input_tokens: 1 + input.images.length, output_tokens: 1, input_tokens_details: { text_tokens: 1, image_tokens: input.images.length } } };
  });
  let directionsCandidate: unknown;
  let sessionReads = 0, finalAccountCheck: (() => Promise<void>) | undefined;
  const subscriptionFetch = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === "https://api.openai.com/v1/models") return Response.json({ models: [{ slug: policy.model, display_name: "Synthetic approved subscription model", visibility: "list" }] });
    expect(String(url)).toBe("https://api.openai.com/v1/responses"); expect(init?.method).toBe("POST");
    expect(directionsCandidate).toBeDefined();
    const response = { id: "resp_synthetic_five_lane", status: "completed", model: policy.model,
      output: [{ id: "msg_synthetic_five_lane", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(directionsCandidate) }] }],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } };
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream", "x-request-id": "req_synthetic_five_lane" } });
  });
  const subscriptionTransport = createChatGPTTransport({ fetch: subscriptionFetch, async getSession() {
    if (++sessionReads === 2) await finalAccountCheck?.();
    return { accountId: policy.registrationId, accessToken: "oauth.synthetic.five-lane-subscription", expiresAt: 2_000_000_000_000, scopes: ["chatgpt.tokens.use.direct"] };
  } });
  async function start() {
    const operation = (selected: LogoWorkerCapability) => {
      const authorization = createLogoProductionStorageAuthorization({ ownerId: OWNER_A, authUserId: authUser, workerRoleName: "fluid_logo_worker_host_fixture",
        workerRoleOid: roleOid, workerId, publishableKey: "sb_publishable_synthetic", accessToken: token, capability: selected }, { fetch: transport })!;
      authorizations.push(authorization);
      return { capability: selected, authorization: { ...authorization, async assertAvailable(job: Parameters<typeof authorization.assertAvailable>[0]) {
        await authorization.assertAvailable(job); leasedChecks.push(job.operation);
      } } };
    };
    const imageOperation = (selected: LogoWorkerCapability) => {
      const authorization = createLogoGenerativeStorageAuthorization({ ownerId: OWNER_A, authUserId: authUser, workerRoleName: "fluid_logo_worker_host_fixture",
        workerRoleOid: roleOid, workerId, publishableKey: "sb_publishable_synthetic", accessToken: token, capability: selected }, { fetch: transport })!;
      expect(authorization).not.toBeNull(); authorizations.push(authorization);
      return { capability: selected, authorization: { ...authorization, async assertAvailable(job: Parameters<typeof authorization.assertAvailable>[0]) {
        await authorization.assertAvailable(job); leasedChecks.push(job.operation);
      } }, image: { apiKey: "synthetic-no-api-key", model: selected.model!, rateVersion: SUNBURST_STANDARD_IMAGE_PRICING.binding.rateVersion, paidCallsApproved: true }, transport: { createImage } };
    };
    const directionsAuthorization = createLogoDirectionsStorageAuthorization({ ownerId: OWNER_A, authUserId: authUser, workerRoleName: "fluid_logo_worker_host_fixture",
      workerRoleOid: roleOid, workerId, publishableKey: "sb_publishable_synthetic", accessToken: token, capability: directionsCapability }, { fetch: transport })!;
    expect(directionsAuthorization).not.toBeNull(); authorizations.push(directionsAuthorization);
    const host = await startLogoProductionHost({ enabled: true, binding: { ownerId: OWNER_A, roleName: "fluid_logo_worker_host_fixture", roleOid }, pool, workerId,
      concepts: imageOperation(SYNTHETIC_CONCEPT_READINESS), refinements: imageOperation(refinementCapability),
      vector: operation(capability), exports: operation(exportCapability),
      directions: { capability: directionsCapability, expectedAccountId: policy.registrationId, transport: subscriptionTransport, authorization: { ...directionsAuthorization, async assertAvailable(job) { await directionsAuthorization.assertAvailable(job); leasedChecks.push(job.operation); } } }, pollMs: 10 });
    expect(host.status).toBe("qualified"); if (host.status !== "qualified") throw Error(`Local host unavailable: ${JSON.stringify(host)}`); return host;
  }
  async function runUntil(host: Extract<LogoProductionHost, { status: "qualified" }>, mode: "finish" | "idle") {
    const controller = new AbortController(); stoppingAt = mode; stopHost = () => controller.abort();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try { await host.run(controller.signal); } finally { clearTimeout(timer); await host.close(); await serial; stopHost = undefined; }
  }
  it("runs all five real operation handlers and owner approvals, with only synthetic provider HTTP", async () => {
    await runUntil(await start(), "idle");
    let initial = logoWorkspaceV2Schema.parse(await rpc("start_logo_project", [{ requestKey: randomUUID(), brief: {
      name: "Synthetic vector adapter", activity: "Local test", audience: "Testers", personality: "Calm", logoTypes: ["mascot"],
    } }]));
    const referenceBytes = syntheticPng(32, 32, (x, y) => x < y ? [0, 0, 0, 255] : [255, 255, 255, 255]);
    const uploaded = await createLogoInputService({ assets, connections: owned }).uploadLogoReference(auth(), initial.projectId,
      { requestKey: randomUUID(), expected: initial.heads, aspects: ["shape"], rightsDeclaration: "I own this synthetic image and permit display and processing for my logo." }, referenceBytes, "image/png");
    await rpc("apply_logo_workspace_command", [initial.projectId, { method: "saveLogoReferences", body: {
      requestKey: randomUUID(), expected: initial.heads, selections: [{ referenceId: uploaded.referenceId, aspects: ["shape"] }],
    } }]);
    initial = await workspace(initial.projectId);
    const reference = (await db.query<{ reference_snapshot_id: string }>("select reference_snapshot_id from public.logo_stage_revisions where id=$1", [initial.stages.brief_references!.id])).rows[0]!;
    const quote = logoCostQuoteSchema.parse(await rpc("quote_logo_operation", [initial.projectId, { operation: "concepts", expected: initial.heads,
      briefRevisionId: initial.stages.brief_references!.id, referenceSnapshotId: reference.reference_snapshot_id }]));
    const intent = { requestKey: randomUUID(), quoteId: quote.id, acceptedMaxCostMicrousd: quote.maxCostMicrousd, expected: initial.heads };
    expect(await rpc("admit_logo_operation", [initial.projectId, { ...intent, requestKey: randomUUID(), acceptedMaxCostMicrousd: quote.maxCostMicrousd - 1 }])).toMatchObject({ kind: "logo_admission_rejected", errorCode: "conflict" });
    expect(createImage).not.toHaveBeenCalled();
    const admission = logoDispatchReceiptSchema.parse(await rpc("admit_logo_operation", [initial.projectId, intent]));
    await runUntil(await start(), "idle");
    expect(createImage).toHaveBeenCalledTimes(6);
    expect(await rpc("admit_logo_operation", [initial.projectId, intent])).toEqual(admission);
    const completed = await db.query<{ state: string; actual_cost_microusd: number; id: string; input: { attemptId: string; slotId: string; batchId: string } }>("select id,state,actual_cost_microusd,input from public.jobs where id=any($1)", [admission.jobIds]);
    expect(completed.rows).toHaveLength(6); expect(completed.rows.every(row => row.state === "succeeded" && row.actual_cost_microusd === 43)).toBe(true);
    for (const [input] of createImage.mock.calls) { expect(input.images).toHaveLength(1); expect(input.images[0]!.reference).toEqual(uploaded.asset); }
    const conceptInput = completed.rows[0]!.input;
    const conceptSource = { kind: "concept", batchId: conceptInput.batchId, slotId: conceptInput.slotId, attemptId: conceptInput.attemptId };
    const conceptResult = identityAssetReceiptSchema.parse((await db.query<{ preview: unknown }>("select preview from public.logo_raster_results where job_id=$1", [completed.rows[0]!.id])).rows[0]!.preview);
    const beforeRefine = await workspace(initial.projectId);
    const refineQuote = logoCostQuoteSchema.parse(await rpc("quote_logo_operation", [initial.projectId, { operation: "refine_preview", expected: beforeRefine.heads,
      source: conceptSource, instruction: "Simplify this synthetic silhouette" }]));
    const refineIntent = { requestKey: randomUUID(), quoteId: refineQuote.id, acceptedMaxCostMicrousd: refineQuote.maxCostMicrousd, expected: beforeRefine.heads };
    const refined = logoDispatchReceiptSchema.parse(await rpc("admit_logo_operation", [initial.projectId, refineIntent]));
    await runUntil(await start(), "idle");
    expect(createImage).toHaveBeenCalledTimes(7);
    expect(createImage.mock.calls[6]![0].images.map(image => image.reference)).toEqual([conceptResult.reference, uploaded.asset]);
    expect(await rpc("admit_logo_operation", [initial.projectId, refineIntent])).toEqual(refined);
    const refinement = (await db.query<{ input: { rasterRevisionId: string }; state: string; actual_cost_microusd: number }>("select input,state,actual_cost_microusd from public.jobs where id=$1", [refined.jobIds[0]])).rows[0]!;
    expect(refinement).toMatchObject({ state: "succeeded", actual_cost_microusd: 51 });
    const original = identityAssetReceiptSchema.parse((await db.query<{ preview: unknown }>("select preview from public.logo_raster_results where job_id=$1", [refined.jobIds[0]])).rows[0]!.preview);
    const originalBytes = Uint8Array.from(blobs.get(`${original.reference.ownerId}/${original.reference.projectId}/${original.reference.assetId}/${original.reference.versionId}`)!.bytes);
    const raster = syntheticConversionInput("mascot");
    const source = { kind: "refinement", rasterRevisionId: refinement.input.rasterRevisionId };
    await rpc("apply_logo_workspace_command", [initial.projectId, { method: "selectLogoRaster", body: { requestKey: randomUUID(), expected: (await workspace(initial.projectId)).heads, source } }]);
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
    expect(blobs.size).toBe(10); expect(new Set(leasedChecks)).toEqual(new Set(["identity.logo_concept", "identity.logo_refine", "identity.logo_vectorize"]));
    expect(createImage).toHaveBeenCalledTimes(7);
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
      selectIdentityDirectionComponents: (auth, projectId, command, signal) => {
        if (command.method !== "selectIdentityDirectionComponents") throw new Error("Unexpected direction selection command");
        return prepareDirectionEvidence(auth, projectId, command, signal);
      },
      approveIdentityDirection: (auth, projectId, command, signal) => {
        if (command.method !== "approveIdentityDirection") throw new Error("Unexpected direction approval command");
        return prepareDirectionEvidence(auth, projectId, command, signal);
      },
    });
    const accepted = await transactions.run(auth(), initial.projectId, { method: "acceptLogoVector", body: {
      requestKey: randomUUID(), expected: (await workspace(initial.projectId)).heads, vectorRevisionId: revision.id, acceptEarlierBasis: false,
    } }) as LogoMutationReceipt;
    expect(accepted.workspace.approvedLogo!.vectorRevisionId).toBe(revision.id);
    // Canonical catalog import and all direction/approval records use actual
    // service, byte, license, SQL, broker and owner-transaction boundaries.
    const approval = accepted.workspace.approvedLogo!;
    const font = await createLogoInputService({ assets, connections: owned }).importCatalogLogoFont(auth(), initial.projectId,
      { requestKey: randomUUID(), expected: accepted.workspace.heads, catalogFontId: "geist-sans-variable" });
    directionsCandidate = { directions: [0, 1, 2].map(n => ({ name: `Synthetic direction ${n + 1}`,
      palette: { swatches: [{ key: "ink", name: "Ink", hex: ["#191919", "#242424", "#333333"][n] }, { key: "paper", name: "Paper", hex: "#FFFFFF" }], pairings: [{ role: "body", foregroundKey: "ink", backgroundKey: "paper" }] },
      typography: { styles: [{ key: "body", role: "body", sampleText: "Synthetic vector adapter", fontVersionId: font.id, weight: 400, style: "normal", sizePx: 16, lineHeight: 1.5 }] }, graphics: { elements: [] } })) };
    await runUntil(await start(), "idle");
    const directionsBefore = await workspace(initial.projectId);
    const directionQuote = logoCostQuoteSchema.parse(await rpc("quote_logo_operation", [initial.projectId, { operation: "directions", expected: directionsBefore.heads, approvedLogoId: approval.id }]));
    expect(directionQuote).toMatchObject({ billingMode: "chatgpt_subscription", maxCostMicrousd: 0, externalProviderCostMicrousd: 0, model: policy.model });
    const directionsIntent = { requestKey: randomUUID(), expected: directionsBefore.heads, quoteId: directionQuote.id, acceptedMaxCostMicrousd: 0 };
    const directionsAdmission = logoDispatchReceiptSchema.parse(await rpc("admit_logo_operation", [initial.projectId, directionsIntent]));
    await runUntil(await start(), "idle");
    expect((await db.query("select state,billing_mode,actual_cost_microusd from public.jobs where id=$1", [directionsAdmission.jobIds[0]])).rows).toEqual([{ state: "succeeded", billing_mode: "chatgpt_subscription", actual_cost_microusd: 0 }]);
    expect(subscriptionFetch.mock.calls.filter(([url]) => String(url).endsWith("/responses"))).toHaveLength(1);
    expect(createImage).toHaveBeenCalledTimes(7); expect(await rpc("admit_logo_operation", [initial.projectId, directionsIntent])).toEqual(directionsAdmission);
    expect((await db.query("select id from public.logo_direction_records where project_id=$1", [initial.projectId])).rows).toHaveLength(12);
    const proposed = await reads.getIdentityDirections(auth(), initial.projectId);
    expect(proposed.directions).toHaveLength(3); expect(proposed.approval).toBeNull(); expect(proposed.selection).toBeNull();
    expect(proposed.fonts[0]!.rights).toEqual(font.rights);
    await transactions.run(auth(), initial.projectId, { method: "selectIdentityDirectionComponents", body: { requestKey: randomUUID(), expected: (await workspace(initial.projectId)).heads,
      approvedLogoId: approval.id, paletteVersionId: proposed.palettes[0]!.id, typographyVersionId: proposed.typography[1]!.id, graphicsVersionId: proposed.graphics[2]!.id } });
    const selectedDirection = await reads.getIdentityDirections(auth(), initial.projectId);
    expect(selectedDirection.approval).toBeNull();
    await transactions.run(auth(), initial.projectId, { method: "approveIdentityDirection", body: { requestKey: randomUUID(), expected: (await workspace(initial.projectId)).heads,
      directionSelectionId: selectedDirection.selection!.id, consistencyHash: selectedDirection.selection!.consistency.hash } });
    const directionApprovalId = (await reads.getIdentityDirections(auth(), initial.projectId)).approval!.id;
    const set = logoVariantSetSchema.parse(await transactions.run(auth(), initial.projectId, { method: "prepareLogoVariants", body: {
      requestKey: randomUUID(), expected: (await workspace(initial.projectId)).heads, approvedLogoId: approval.id, directionApprovalId: directionApprovalId,
    } }));
    await transactions.run(auth(), initial.projectId, { method: "reviewLogoVariants", body: { requestKey: randomUUID(),
      expected: (await workspace(initial.projectId)).heads, approvedLogoId: approval.id, directionApprovalId: directionApprovalId,
      variantSetId: set.id, acceptedVariantIds: set.items.filter(item => item.applicability.status === "applicable").map(item => item.id),
    } });
    const beforeExport = await workspace(initial.projectId);
    await runUntil(await start(), "idle");
    const exporting = await start();
    try {
      const request = { requestKey: randomUUID(), expected: beforeExport.heads, approvedLogoId: approval.id,
        directionApprovalId: directionApprovalId, variantSetId: set.id, pngLongEdge: 512, socialSelections: [] };
      const receipt = logoDispatchReceiptSchema.parse(await rpc("request_logo_export", [initial.projectId, request]));
      await runUntil(exporting, "finish");
      expect(new Set(leasedChecks)).toEqual(new Set(["identity.logo_concept", "identity.logo_refine", "identity.logo_vectorize", "identity.logo_directions", "identity.logo_export"]));
      expect(createImage).toHaveBeenCalledTimes(7);
      expect(reports.length).toBeGreaterThan(4); for (const manifest of reports) expect(manifest).toEqual(union());
      const readiness = await db.query<{ descriptor: unknown }>("select descriptor from fluid_private.logo_worker_readiness where role_oid=$1 and worker_id=$2", [roleOid, workerId]);
      expect(readiness.rows).toHaveLength(5); expect(readiness.rows.map(row => row.descriptor)).toEqual(expect.arrayContaining(union()));
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
      // A second explicit directions admission is stopped during the final
      // account recheck. The actual shared transport must make no Responses call.
      await runUntil(await start(), "idle");
      const stoppingBasis = await workspace(initial.projectId);
      const stoppingQuote = logoCostQuoteSchema.parse(await rpc("quote_logo_operation", [initial.projectId, { operation: "directions", expected: stoppingBasis.heads, approvedLogoId: approval.id }]));
      const stoppingAdmission = logoDispatchReceiptSchema.parse(await rpc("admit_logo_operation", [initial.projectId, { requestKey: randomUUID(), expected: stoppingBasis.heads, quoteId: stoppingQuote.id, acceptedMaxCostMicrousd: 0 }]));
      const stoppingHost = await start(), stopped = new AbortController(); sessionReads = 0;
      finalAccountCheck = async () => { await Promise.resolve(); stopped.abort(); };
      try { await stoppingHost.run(stopped.signal); }
      finally { await stoppingHost.close(); finalAccountCheck = undefined; await serial; }
      expect(subscriptionFetch.mock.calls.filter(([url]) => String(url).endsWith("/responses"))).toHaveLength(1);
      expect((await db.query("select state,actual_cost_microusd from public.jobs where id=$1", [stoppingAdmission.jobIds[0]])).rows).toEqual([{ state: "failed", actual_cost_microusd: 0 }]);
      expect((await db.query("select id from public.logo_provider_responses where job_id=$1", [stoppingAdmission.jobIds[0]])).rows).toEqual([]);
      expect((await workspace(initial.projectId)).approvedLogo).toEqual(approval); expect(createImage).toHaveBeenCalledTimes(7);
      const directory = ".tmp/logo-five-operation-host"; await mkdir(directory, { recursive: true });
      await Promise.all([writeFile(`${directory}/synthetic-original.png`, originalBytes), writeFile(`${directory}/synthetic-converted.svg`, bytes(revision.svgAsset)),
        writeFile(`${directory}/synthetic-primary-color.svg`, member("image/svg+xml")), writeFile(`${directory}/synthetic-primary-color.pdf`, member("application/pdf")),
        writeFile(`${directory}/synthetic-primary-color.png`, member("image/png")), writeFile(`${directory}/synthetic-logo-pack.zip`, pack),
        writeFile(`${directory}/synthetic-evidence.json`, JSON.stringify({ fixture: "Disposable local database and in-memory private blobs; no hosted/provider activity",
          originalHash: original.reference.contentHash, vectorRevision: revision, manifest, colorVerification: verification }, null, 2) + "\n")]);
    } finally { await exporting.close(); }
  }, 240_000);
  it("fences new work on stop while retaining a dispatched image response, publication and cost", async () => {
    await runUntil(await start(), "idle");
    const w = logoWorkspaceV2Schema.parse(await rpc("start_logo_project", [{ requestKey: randomUUID(), brief: {
      name: "Synthetic stop and drain", activity: "Local test", audience: "Testers", personality: "Calm", logoTypes: ["abstract"],
    } }]));
    const snapshot = (await db.query<{ id: string }>("select reference_snapshot_id id from public.logo_stage_revisions where id=$1", [w.stages.brief_references!.id])).rows[0]!.id;
    const quote = logoCostQuoteSchema.parse(await rpc("quote_logo_operation", [w.projectId, { operation: "concepts", expected: w.heads,
      briefRevisionId: w.stages.brief_references!.id, referenceSnapshotId: snapshot }]));
    const receipt = logoDispatchReceiptSchema.parse(await rpc("admit_logo_operation", [w.projectId, { requestKey: randomUUID(), quoteId: quote.id, acceptedMaxCostMicrousd: quote.maxCostMicrousd, expected: w.heads }]));
    for (const jobId of receipt.jobIds.slice(1)) await rpc("request_job_cancel", [jobId]);
    let dispatched!: () => void, release!: () => void;
    const begun = new Promise<void>(resolve => { dispatched = resolve; }), respond = new Promise<void>(resolve => { release = resolve; });
    const producer = createImage.getMockImplementation()!, previousCalls = createImage.mock.calls.length;
    createImage.mockImplementationOnce(async (...args) => { dispatched(); await respond; return producer(...args); });
    const host = await start(), controller = new AbortController(), running = host.run(controller.signal);
    await begun; controller.abort(); let drained = false; const closing = host.close().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    release(); await Promise.all([running, closing]); await serial;
    expect(drained).toBe(true); expect(createImage).toHaveBeenCalledTimes(previousCalls + 1);
    const result = (await db.query<{ state: string; actual_cost_microusd: number }>("select state,actual_cost_microusd from public.jobs where id=$1", [receipt.jobIds[0]])).rows[0]!;
    expect(result).toEqual({ state: "succeeded", actual_cost_microusd: 35 });
    expect((await db.query("select job_id from public.logo_raster_results where job_id=$1", [receipt.jobIds[0]])).rows).toHaveLength(1);
    const callsAfterDrain = createImage.mock.calls.length; await host.run(new AbortController().signal); expect(createImage).toHaveBeenCalledTimes(callsAfterDrain);
  }, 60_000);

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
