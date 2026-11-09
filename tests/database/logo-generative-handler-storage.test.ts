import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createTestDatabase, OWNER_A, resetFixture, type TestDatabase } from "./local-supabase";
import {
  installGenerativeStorageFixture, generativeStorageFixture, workerRole, workerId,
  authUser, sessionId, conceptCapability, refinementCapability,
} from "./logo-generative-storage-fixture";
import type { ClaimedJob, StepOutcome } from "../../src/domain/jobs";
import { logoConceptStepOutputSchema, logoRefinementStepOutputSchema } from "../../src/domain/logo-jobs";
import { identityAssetPublicationSchema } from "../../src/domain/logo-deliverables";
import { CAPPED_LOGO_IMAGE_MODEL } from "../../src/domain/providers";
import { loadLogoConceptInputs, loadLogoRefinementInputs, loadLogoStepAsset, recordLogoProviderResponse } from "../../src/server/data/logo-jobs";
import type { LogoImageProducer } from "../../src/server/logo-creation/openai-logo-provider";
import { IMAGE_INPUT_LIMITS } from "../../src/server/logo-creation/openai-image-transport";
import { createLogoGenerativeStorageAuthorization, type LogoGenerativeStorageAuthorization } from "../../worker/logo-generative-storage-authorization";
import { createLogoGenerativeAssetStore } from "../../worker/logo-generative-asset-store";
import { createLogoOperationComposition } from "../../worker/logo-operation-composition";
import { createLogoJobStore } from "../../worker/logo-job-store";

const origin = "https://fricsfwqibyhemknqgyf.supabase.co";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Hooks = {
  afterRead?(path: string): Promise<void>;
  afterWrite?(path: string): Promise<void>;
};

/** Local proof only: Auth HTTP and image observations are explicitly synthetic.
 * The handlers, metadata services, broker, byte store, SQL, upload evidence,
 * durable completion and every Storage statement's RLS are the actual code.
 * No hosted request, credential, migration, permission or activation occurs. */
describe("actual generative handlers through leased metadata and Storage RLS", () => {
  let db: TestDatabase, f: Awaited<ReturnType<typeof generativeStorageFixture>>, output: Uint8Array;
  const authorizations: LogoGenerativeStorageAuthorization[] = [];
  beforeAll(async () => {
    db = await createTestDatabase();
    await installGenerativeStorageFixture(db);
    output = new Uint8Array(await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#666666" } }).png().toBuffer());
  }, 60_000);
  beforeEach(async () => { await resetFixture(db); f = await generativeStorageFixture(db); });
  afterEach(() => { for (const authorization of authorizations.splice(0)) authorization.close(); });
  afterAll(async () => { await db?.close(); });

  async function compose(job: ClaimedJob, hooks: Hooks = {}) {
    const capability = job.operation === "identity.logo_concept" ? conceptCapability : refinementCapability;
    await f.enable(capability);
    const oid = (await db.query<{ oid: number }>("select oid::int oid from pg_roles where rolname=$1", [workerRole])).rows[0]!.oid;
    const claims = { sub: authUser, session_id: sessionId, role: "authenticated", aud: "authenticated",
      iss: `${origin}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 3600, is_anonymous: false };
    const accessToken = `${Buffer.from('{"alg":"ES256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic_signature`;
    const reads: string[] = [], writes: string[] = [], duplicates: string[] = [], grants: { mode: string; reservation: string | null }[] = [];
    const transport: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.origin !== origin || url.search || url.hash) throw new Error("Unexpected fixture HTTP destination");
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${accessToken}`);
      expect(headers.get("apikey")).toBe("sb_publishable_synthetic");
      expect(init.redirect).toBe("error");
      if (url.pathname === "/auth/v1/user") {
        expect(init.method).toBe("GET");
        return Response.json({ id: authUser, is_anonymous: false });
      }
      if (url.pathname === "/rest/v1/rpc/authorize_logo_generative_storage") {
        expect(init.method).toBe("POST");
        const body = JSON.parse(String(init.body));
        expect(Object.keys(body).sort()).toEqual(["p_job", "p_lease", "p_mode", "p_reservation"]);
        grants.push({ mode: body.p_mode, reservation: body.p_reservation });
        const value = await f.auth(async () => (await db.query<{ value: unknown }>(
          "select public.authorize_logo_generative_storage($1,$2,$3,$4) value",
          [body.p_job, body.p_lease, body.p_reservation, body.p_mode],
        )).rows[0]!.value);
        return Response.json(value);
      }
      const prefix = "/storage/v1/object/fluid-assets/";
      if (!url.pathname.startsWith(prefix)) throw new Error("Unexpected fixture Storage route");
      const path = decodeURIComponent(url.pathname.slice(prefix.length));
      if (init.method === "POST") {
        expect(headers.get("x-upsert")).toBe("false");
        expect(headers.get("content-type")).toBe("image/png");
        writes.push(path);
        try {
          await f.object("object.upload", () => db.query(
            "insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [path, authUser],
          ));
        } catch (error) {
          if ((error as { code?: string }).code === "23505") {
            duplicates.push(path);
            return Response.json({ code: "ResourceAlreadyExists" }, { status: 409 });
          }
          throw error;
        }
        f.blobs.set(path, { bytes: Uint8Array.from(init.body as Uint8Array), mimeType: "image/png" });
        await hooks.afterWrite?.(path);
        return Response.json({ Id: randomUUID(), Key: `fluid-assets/${path}` });
      }
      expect(init.method).toBe("GET");
      const visible = await f.object("object.get_authenticated", () => db.query(
        "select name from storage.objects where bucket_id='fluid-assets' and name=$1", [path],
      ));
      if (!visible.rows.length) return new Response(null, { status: 404 });
      reads.push(path);
      const blob = f.blobs.get(path);
      if (!blob) throw new Error("Fixture object bytes are missing");
      await hooks.afterRead?.(path);
      return new Response(Uint8Array.from(blob.bytes), { headers: { "content-type": blob.mimeType } });
    };
    const authorization = createLogoGenerativeStorageAuthorization({ ownerId: OWNER_A, authUserId: authUser,
      workerRoleName: workerRole, workerRoleOid: oid, workerId, publishableKey: "sb_publishable_synthetic", accessToken, capability,
    }, { fetch: transport });
    expect(authorization).not.toBeNull();
    authorizations.push(authorization!);
    const assets = createLogoGenerativeAssetStore({ connection: f.connection, authorization: authorization! });
    expect(assets).not.toBeNull();
    // Deliberately synthetic: all observations are persisted through the real
    // provider-response service and exact job/lease receipt contract.
    const produce = vi.fn<LogoImageProducer["produce"]>(async () => ({ status: "completed", bytes: output,
      mimeType: "image/png", providerRequestId: "synthetic-no-provider-call", responseHash: "e".repeat(64),
      billing: { status: "recorded", confirmedMicrousd: 1 },
    }));
    const common = { model: CAPPED_LOGO_IMAGE_MODEL, producer: { produce }, assets: assets!, assertPolicyReady: authorization!.assertAvailable,
      recordProviderResponse: (bound: ClaimedJob, observation: Parameters<typeof recordLogoProviderResponse>[2]) => recordLogoProviderResponse(f.connection, bound, observation) };
    const composition = createLogoOperationComposition({
      concepts: job.operation === "identity.logo_concept" ? { ...common, resolveInputs: bound => loadLogoConceptInputs(f.connection, bound) } : null,
      refinements: job.operation === "identity.logo_refine" ? { ...common, resolveInputs: bound => loadLogoRefinementInputs(f.connection, bound),
        loadGeneratedRaster: (bound, signal) => loadLogoStepAsset(f.connection, assets!, bound, "generate-refinement", signal), vectorRefinement: null } : null,
      vector: null, directions: null, exports: null, unavailableReasons: {},
    });
    expect(composition.capabilities[job.operation as "identity.logo_concept" | "identity.logo_refine"]).toEqual({ status: "available" });
    const steps = composition.handlers.get(job.operation)!.steps(job);
    expect(steps).toHaveLength(1);
    const step = steps[0]!, store = createLogoJobStore(f.connection);
    await store.registerPlan(job, steps.map(({ key, maximumCostMicrousd }) => ({ key, maximumCostMicrousd })));
    expect(await store.beginStep(job, step.key, step.maximumCostMicrousd)).toBe("started");
    return { authorization: authorization!, assets: assets!, produce, step, store, reads, writes, duplicates, grants };
  }

  const results = (job: ClaimedJob) => db.query("select preview from public.logo_raster_results where job_id=$1", [job.id]);
  const publications = (job: ClaimedJob) => db.query<{ id: string; state: string; lease_token: string; request_key: string; content_hash: string;
    mime_type: string; byte_length: number; source_receipt_id: string; verification: unknown; request: { publication: unknown } }>(
    "select id,state,lease_token,request_key,content_hash,mime_type,byte_length,source_receipt_id,verification,request from public.logo_asset_publications where job_id=$1", [job.id],
  );
  async function assertNoPublication(job: ClaimedJob, heads: unknown) {
    expect((await results(job)).rows).toEqual([]);
    expect((await publications(job)).rows.every(row => row.state !== "committed")).toBe(true);
    expect((await f.workspace(job.projectId)).heads).toEqual(heads);
  }
  async function complete(job: ClaimedJob, bound: Awaited<ReturnType<typeof compose>>, outcome: StepOutcome) {
    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded") throw new Error("Synthetic handler did not succeed");
    await bound.store.completeStep(job, bound.step.key, outcome);
    await bound.store.finish(job, "succeeded");
    expect((await db.query("select state from public.jobs where id=$1", [job.id])).rows).toEqual([{ state: "succeeded" }]);
    expect((await results(job)).rows).toHaveLength(1);
    expect((await publications(job)).rows.map(row => row.state)).toEqual(["committed"]);
  }

  it("keeps four uploaded references in frozen order after newer selections and commits exact PNG/lease/provider receipts", async () => {
    expect(IMAGE_INPUT_LIMITS).toMatchObject({ images: 4, inputBytes: 20_971_520, outputBytes: 8_388_608 });
    const { job } = await f.prepareConcept(4), resolved = await loadLogoConceptInputs(f.connection, job);
    expect(new Set(resolved.referenceSnapshot.references.map(reference => reference.asset.contentHash)).size).toBe(4);
    await f.rpc("apply_logo_workspace_command", [job.projectId, { method: "saveLogoReferences", body: {
      requestKey: randomUUID(), expected: (await f.workspace(job.projectId)).heads,
      selections: [...resolved.referenceSnapshot.references].reverse().map(({ referenceId, aspects }) => ({ referenceId, aspects })),
    } }]);
    const current = await f.workspace(job.projectId), currentHeads = current.heads;
    expect(current.stages.brief_references!.id).not.toBe(resolved.brief.id);
    expect((await loadLogoConceptInputs(f.connection, job)).referenceSnapshot).toEqual(resolved.referenceSnapshot);
    const bound = await compose(job), outcome = await bound.step.execute({ job, signal: new AbortController().signal });
    expect(outcome).toMatchObject({ status: "succeeded", costMicrousd: 1 });
    expect(bound.produce).toHaveBeenCalledTimes(1);
    const images = bound.produce.mock.calls[0]![1];
    expect(images.map(image => image.reference)).toEqual(resolved.input.references);
    expect(images.map(image => hash(image.bytes))).toEqual(resolved.input.references.map(reference => reference.contentHash));
    expect(bound.writes).toHaveLength(1);
    expect(bound.reads).toHaveLength(5); // Four sources, then exact output readback.
    expect(f.blobs.get(bound.writes[0]!)!.bytes).toEqual(output);
    const row = (await publications(job)).rows[0]!;
    expect(row).toMatchObject({ state: "staged", lease_token: job.leaseToken, request_key: resolved.input.attemptId,
      source_receipt_id: resolved.input.attemptId, mime_type: "image/png", content_hash: hash(output) });
    expect(Number(row.byte_length)).toBe(output.length);
    expect(row.verification).toMatchObject({ status: "verified", mimeType: "image/png", contentHash: hash(output), byteLength: output.length });
    expect(row.request.publication).toMatchObject({ inputRevisions: resolved.inputRevisions, source: { kind: "concept", sourceId: resolved.input.attemptId } });
    expect((await results(job)).rows).toEqual([]);
    expect((await f.workspace(job.projectId)).heads).toEqual(currentHeads);
    if (outcome.status !== "succeeded") throw new Error("Missing outcome");
    const result = logoConceptStepOutputSchema.parse(outcome.result);
    expect(result.publicationId).toBe(row.id);
    expect((await db.query("select id,job_id,lease_token,observation from public.logo_provider_responses where job_id=$1", [job.id])).rows).toEqual([
      expect.objectContaining({ id: result.providerResponseReceiptId, job_id: job.id, lease_token: job.leaseToken,
        observation: expect.objectContaining({ providerRequestId: "synthetic-no-provider-call", artifactHash: hash(output), normalizedPixelHash: expect.stringMatching(/^[a-f0-9]{64}$/) }) }),
    ]);
    await expect(bound.store.completeStep({ ...job, leaseToken: randomUUID() }, bound.step.key, outcome)).rejects.toThrow();
    expect((await publications(job)).rows[0]!.state).toBe("staged");
    await complete(job, bound, outcome);
  }, 30_000);

  it("replays the exact staged PNG after a real duplicate-object response and rejects corrupt readback without overwriting or inventing evidence", async () => {
    const { job } = await f.prepareConcept(1), heads = (await f.workspace(job.projectId)).heads;
    const bound = await compose(job), signal = new AbortController().signal;
    const outcome = await bound.step.execute({ job, signal });
    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded") throw new Error("Missing staged handler output");
    const row = (await publications(job)).rows[0]!, path = bound.writes[0]!;
    const publication = identityAssetPublicationSchema.parse(row.request.publication);
    const providerBefore = (await db.query("select id,job_id,lease_token,observation from public.logo_provider_responses where job_id=$1", [job.id])).rows;
    expect(logoConceptStepOutputSchema.parse(outcome.result).publicationId).toBe(row.id);
    expect(row.state).toBe("staged");
    expect(providerBefore).toHaveLength(1);
    // The actual RLS INSERT raises 23505; the fixture HTTP bridge returns 409.
    // The same store still GETs/verifies/observes the original exact reservation.
    const replay = await bound.assets.publishLeasedAsset(job, publication, output, signal);
    expect(replay).toMatchObject({ id: row.id, publicationState: "staged", sourceReceiptId: row.source_receipt_id,
      verification: { status: "verified", contentHash: hash(output), mimeType: "image/png", byteLength: output.length } });
    expect(bound.writes).toEqual([path, path]);
    expect(bound.duplicates).toEqual([path]);
    expect(bound.reads.filter(read => read === path)).toHaveLength(2);
    expect(f.blobs.get(path)!.bytes).toEqual(output);
    expect((await publications(job)).rows.map(item => item.id)).toEqual([row.id]);
    const observedBeforeCorruption = (await publications(job)).rows;
    // Same-size corruption changes only the local byte backing. Neither the
    // supplied original bytes nor metadata, Auth, source, or provider evidence changes.
    const corrupt = Uint8Array.from(output);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    f.blobs.set(path, { bytes: corrupt, mimeType: "image/png" });
    await expect(bound.assets.publishLeasedAsset(job, publication, output, signal)).rejects.toMatchObject({
      name: "IdentityAssetUncertainPublicationError", requestKey: publication.requestKey, reservationId: row.id,
    });
    expect(bound.writes).toEqual([path, path, path]);
    expect(bound.duplicates).toEqual([path, path]);
    expect(bound.reads.filter(read => read === path)).toHaveLength(3);
    expect(f.blobs.get(path)!.bytes).toEqual(corrupt);
    expect(hash(f.blobs.get(path)!.bytes)).not.toBe(publication.contentHash);
    expect((await publications(job)).rows).toEqual(observedBeforeCorruption);
    expect((await db.query("select name from storage.objects where name=$1", [path])).rows).toHaveLength(1);
    expect((await db.query("select id,job_id,lease_token,observation from public.logo_provider_responses where job_id=$1", [job.id])).rows).toEqual(providerBefore);
    expect(bound.produce).toHaveBeenCalledTimes(1);
    await assertNoPublication(job, heads);
  }, 30_000);

  it.each([false, true])("reads the exact %s earlier-refinement base first, then all three frozen reference images", async priorRefinement => {
    const { job } = await f.prepareRefinement({ priorRefinement, referenceCount: 3 });
    const resolved = await loadLogoRefinementInputs(f.connection, job), bound = await compose(job);
    expect(resolved.input.source.kind).toBe("preview");
    if (resolved.input.source.kind !== "preview") throw new Error("Fixture source must be raster");
    expect(resolved.input.source.raster.kind).toBe(priorRefinement ? "refinement" : "concept");
    const outcome = await bound.step.execute({ job, signal: new AbortController().signal });
    expect(bound.produce).toHaveBeenCalledTimes(1);
    const expected = [resolved.basePreview, ...resolved.referenceSnapshot.references.map(reference => reference.asset)];
    expect(bound.produce.mock.calls[0]![1].map(image => image.reference)).toEqual(expected);
    expect(bound.produce.mock.calls[0]![1].map(image => hash(image.bytes))).toEqual(expected.map(reference => reference.contentHash));
    expect(bound.reads.slice(0, 4)).toEqual(expected.map(reference => `${reference.ownerId}/${reference.projectId}/${reference.assetId}/${reference.versionId}`));
    expect(bound.writes).toHaveLength(1);
    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded") throw new Error("Missing refinement outcome");
    expect(logoRefinementStepOutputSchema.parse(outcome.result)).toMatchObject({ rasterRevisionId: resolved.input.rasterRevisionId });
    expect((await publications(job)).rows[0]!).toMatchObject({ state: "staged", request_key: resolved.input.rasterRevisionId,
      source_receipt_id: resolved.input.rasterRevisionId, lease_token: job.leaseToken });
    await complete(job, bound, outcome);
  }, 30_000);

  it("a valid-looking rights ID without actual upload evidence causes zero image dispatches", async () => {
    const { job } = await f.prepareConcept(1), heads = (await f.workspace(job.projectId)).heads;
    const resolved = await loadLogoConceptInputs(f.connection, job), bound = await compose(job);
    // Deliberate local corruption injection, not a product revocation API.
    // The immutable quote and valid-looking rights UUID remain unchanged.
    await db.exec("alter table public.logo_input_rights disable trigger logo_input_rights_immutable");
    try { await db.query("delete from public.logo_input_rights where id=$1", [resolved.referenceSnapshot.references[0]!.rightsEvidenceId]); }
    finally { await db.exec("alter table public.logo_input_rights enable trigger logo_input_rights_immutable"); }
    const outcome = await bound.step.execute({ job, signal: new AbortController().signal });
    expect(outcome).toMatchObject({ status: "failed", code: "not_dispatched", costMicrousd: 0 });
    expect(bound.produce).not.toHaveBeenCalled();
    expect(bound.reads).toEqual([]); expect(bound.writes).toEqual([]);
    expect((await db.query("select id from public.logo_provider_responses where job_id=$1", [job.id])).rows).toEqual([]);
    await bound.store.completeStep(job, bound.step.key, outcome); await bound.store.finish(job, "failed");
    await assertNoPublication(job, heads);
  });

  it.each(["concept", "refinement"] as const)("an over-limit %s image set is rejected without silently omitting references", async operation => {
    const { job } = operation === "concept" ? await f.prepareConcept(5) : await f.prepareRefinement({ referenceCount: 4 });
    const heads = (await f.workspace(job.projectId)).heads, bound = await compose(job);
    const outcome = await bound.step.execute({ job, signal: new AbortController().signal });
    expect(outcome).toMatchObject({ status: "failed", code: "not_dispatched", costMicrousd: 0 });
    expect(bound.produce).not.toHaveBeenCalled(); expect(bound.writes).toEqual([]);
    await assertNoPublication(job, heads);
  }, 30_000);

  it.each(["cancel", "revoke"] as const)("%s after a source SELECT prevents late reference bytes reaching the producer", async action => {
    const { job } = await f.prepareConcept(1), heads = (await f.workspace(job.projectId)).heads;
    const bound = await compose(job, { afterRead: async () => {
      if (action === "cancel") await f.rpc("request_job_cancel", [job.id]);
      else await db.query("update fluid_private.logo_generative_storage_capabilities set enabled=false where auth_user_id=$1 and operation=$2", [authUser, job.operation]);
    } });
    const outcome = await bound.step.execute({ job, signal: new AbortController().signal });
    expect(outcome).toMatchObject({ status: "failed", code: "not_dispatched", costMicrousd: 0 });
    expect(bound.reads).toHaveLength(1); expect(bound.writes).toEqual([]);
    expect(bound.produce).not.toHaveBeenCalled();
    await assertNoPublication(job, heads);
  });

  it.each(["cancel", "revoke"] as const)("%s after an output INSERT retains uncertainty and cannot publish success or advance heads", async action => {
    const { job } = await f.prepareConcept(1), heads = (await f.workspace(job.projectId)).heads;
    const bound = await compose(job, { afterWrite: async () => {
      if (action === "cancel") await f.rpc("request_job_cancel", [job.id]);
      else await db.query("update fluid_private.logo_generative_storage_capabilities set enabled=false where auth_user_id=$1 and operation=$2", [authUser, job.operation]);
    } });
    const outcome = await bound.step.execute({ job, signal: new AbortController().signal });
    expect(outcome).toMatchObject({ status: "needs_reconciliation", code: "publication_unknown", costMicrousd: 1 });
    expect(bound.produce).toHaveBeenCalledTimes(1); expect(bound.writes).toHaveLength(1);
    expect(f.blobs.get(bound.writes[0]!)!.bytes).toEqual(output);
    expect((await db.query("select name from storage.objects where name=$1", [bound.writes[0]])).rows).toHaveLength(1);
    expect((await publications(job)).rows).toHaveLength(1);
    expect((await publications(job)).rows[0]!.state).toBe("reserved");
    expect((await db.query("select id from public.logo_provider_responses where job_id=$1", [job.id])).rows).toHaveLength(1);
    await assertNoPublication(job, heads);
  });
  it.each([false, true])("recovers one lost upload acknowledgement only with exact authorized readback (readback unavailable=%s)", async unavailable => {
    const { job } = await f.prepareConcept(1), heads = (await f.workspace(job.projectId)).heads;
    let outputPath: string | null = null;
    const bound = await compose(job, {
      afterWrite: async path => { outputPath = path; throw new Error("Synthetic upload acknowledgement lost after RLS INSERT"); },
      afterRead: async path => { if (unavailable && path === outputPath) throw new Error("Synthetic output readback unavailable"); },
    });
    const outcome = await bound.step.execute({ job, signal: new AbortController().signal });
    expect(outcome).toMatchObject(unavailable
      ? { status: "needs_reconciliation", code: "publication_unknown", costMicrousd: 1 }
      : { status: "succeeded", costMicrousd: 1 });
    expect(bound.produce).toHaveBeenCalledTimes(1);
    expect(bound.writes).toHaveLength(2);
    expect(bound.writes[0]).toBe(bound.writes[1]);
    expect(bound.duplicates).toEqual([bound.writes[0]]);
    expect(f.blobs.get(bound.writes[0]!)!.bytes).toEqual(output);
    const rows = (await publications(job)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe(unavailable ? "reserved" : "staged");
    expect((await db.query("select id from public.logo_provider_responses where job_id=$1", [job.id])).rows).toHaveLength(1);
    await assertNoPublication(job, heads);
    if (!unavailable) await complete(job, bound, outcome);
  }, 30_000);

});
