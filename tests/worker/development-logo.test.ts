import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createDevelopmentLogoGenerativeStorageAuthorization, createLogoGenerativeStorageAuthorization } from "../../worker/logo-generative-storage-authorization";
import { createDevelopmentLogoProductionStorageAuthorization, createLogoProductionStorageAuthorization } from "../../worker/logo-production-storage-authorization";
import { createDevelopmentLogoConnection, createLogoProductionConnection } from "../../worker/logo-production-connection";
import { readDevelopmentLogoConfiguration, runDevelopmentLogo, DevelopmentLogoDrainUnconfirmedError } from "../../worker/development/logo";
import { readDevelopmentWorkerConfiguration } from "../../worker/development/config";
import { CAPPED_LOGO_IMAGE_MODEL } from "../../src/domain/providers";
import { SUNBURST_STANDARD_IMAGE_PRICING } from "../../src/server/logo-creation/openai-image-pricing";
import { LOGO_EXPORT_HANDLER_VERSION, LOGO_EXPORT_POLICY_IDENTITY } from "../../worker/handlers/logo-exports";
import { QUALIFIED_VTRACER } from "../../worker/logo-vector/engine";
import { syntheticLogoJob, syntheticResolvedLogoConcept } from "../fixtures/logo-creation";
import { syntheticConversionInput } from "../features/logo-vector/raster-fixtures";
import type { ClaimedJob } from "../../src/domain/jobs";
import type { LogoWorkerCapability } from "../../worker/logo-readiness";
import type { IdentityAssetReservation } from "../../src/server/data/identity-asset-store";
import type { IdentityPoolClientPort } from "../../src/server/runtime/identity-pool";
import type { LogoProductionHostOptions } from "../../worker/logo-production-host";

const origin = "http://127.0.0.1:54321", production = "https://fricsfwqibyhemknqgyf.supabase.co";
const resolved = syntheticResolvedLogoConcept(), owner = resolved.input.ownerId, project = resolved.input.projectId;
const authUser = randomUUID(), sessionId = randomUUID(), role = "embel_development_logo_worker", workerId = "embel-dev-logo-fixture";
const token = (issuer = origin, user = authUser) => `${Buffer.from('{"alg":"ES256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: user, session_id: sessionId,
  role: "authenticated", aud: "authenticated", iss: `${issuer}/auth/v1`, exp: 2_000_000_000, is_anonymous: false })).toString("base64url")}.synthetic_signature`;
const concept: LogoWorkerCapability = { operation: "identity.logo_concept", policyIdentity: resolved.input.policyIdentity,
  handlerVersion: "logo-image-v1", provider: "openai", model: CAPPED_LOGO_IMAGE_MODEL, engine: null, maxCostMicrousd: 100_000 };
const vector: LogoWorkerCapability = { operation: "identity.logo_vectorize", policyIdentity: "a".repeat(64), handlerVersion: "1", provider: null, model: null,
  engine: { id: "vtracer", version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm }, maxCostMicrousd: 0 };
const exports: LogoWorkerCapability = { operation: "identity.logo_export", policyIdentity: LOGO_EXPORT_POLICY_IDENTITY,
  handlerVersion: LOGO_EXPORT_HANDLER_VERSION, provider: null, model: null, engine: null, maxCostMicrousd: 0 };
const environment = () => ({ NODE_ENV: "test", EMBEL_DEVELOPMENT_ENABLED: "true", APP_ORIGIN: "http://127.0.0.1:3105", NEXT_PUBLIC_SUPABASE_URL: origin,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic", EMBEL_DEVELOPMENT_WORKER_OWNER_ID: owner,
  EMBEL_DEVELOPMENT_WORKER_DATABASE_URL: `postgresql://${role}@127.0.0.1:54322/postgres`,
  EMBEL_DEVELOPMENT_WORKER_DEPLOYMENT_ID: "embel-dev-fixture", EMBEL_DEVELOPMENT_DISPATCH_APPROVED: "true",
  EMBEL_DEVELOPMENT_LOGO_WORKER_ID: workerId, EMBEL_DEVELOPMENT_LOGO_STORAGE_USER_ID: authUser,
  EMBEL_DEVELOPMENT_LOGO_STORAGE_ACCESS_TOKEN: token(), EMBEL_DEVELOPMENT_LOGO_OPERATIONS: JSON.stringify({ vector, exports }) });
beforeEach(() => {
  for (const key of Object.keys(process.env)) if (/^VERCEL(?:_|$)/u.test(key)) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(environment())) vi.stubEnv(key, value);
});
afterEach(() => { vi.unstubAllEnvs(); });

function brokerFixture(generative: boolean) {
  const capability = generative ? concept : vector, bytes = syntheticConversionInput("mascot").source.bytes;
  const reference = { ownerId: owner, projectId: project, assetId: randomUUID(), versionId: randomUUID(), contentHash: createHash("sha256").update(bytes).digest("hex") };
  const job: ClaimedJob = generative ? { ...syntheticLogoJob(), reservedCostMicrousd: 1000, input: { ...resolved.input, references: [reference] } }
    : { ...syntheticLogoJob(), operation: "identity.logo_vectorize", reservedCostMicrousd: 0, actualCostMicrousd: 0, input: {
      version: 2, operation: "identity.logo_vectorize", ownerId: owner, projectId: project, requestKey: randomUUID(), policyIdentity: vector.policyIdentity,
      handlerVersion: vector.handlerVersion, inputHash: "b".repeat(64), quoteId: randomUUID(), source: { kind: "refinement", rasterRevisionId: randomUUID() },
      settings: syntheticConversionInput("mascot").settings, engine: vector.engine } };
  const row: IdentityAssetReservation = { id: randomUUID(), requestKey: randomUUID(), reference,
    storagePath: `${owner}/${project}/${reference.assetId}/${reference.versionId}`, mimeType: "image/png", byteLength: bytes.length,
    purpose: generative ? "reference_media" : "brand_asset", sourceReceiptId: randomUUID(), rightsEvidenceId: generative ? randomUUID() : null, publicationState: "committed" };
  const config = { ownerId: owner, authUserId: authUser, workerRoleName: role, workerRoleOid: 12345, workerId,
    publishableKey: "sb_publishable_synthetic", accessToken: token(), capability };
  const calls: string[] = [], state = { grantMismatch: false };
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: authUser, is_anonymous: false });
    if (url.includes("/rpc/")) {
      const body = JSON.parse(String(init.body));
      return Response.json({ ownerId: owner, authUserId: authUser, sessionId, workerRoleName: role, workerRoleOid: 12345,
        workerId: state.grantMismatch ? "foreign-worker" : workerId, capability, jobId: job.id, leaseToken: job.leaseToken,
        inputRevision: job.inputRevision, jobInput: job.input, mode: body.p_mode,
        ...(generative ? { member: body.p_mode === "probe" ? null : "reference" } : {}), reservation: body.p_mode === "probe" ? null : row, publication: null });
    }
    return new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png" } });
  };
  const create = generative ? createDevelopmentLogoGenerativeStorageAuthorization : createDevelopmentLogoProductionStorageAuthorization;
  return { authorization: create(config, { fetch: fetcher }), config, capability, job, row, bytes, calls, state, create };
}

it.each([false, true])("uses local Auth, exact leased grants and immutable private-byte reads for generative=%s", async generative => {
  const f = brokerFixture(generative); expect(f.authorization).not.toBeNull(); expect(f.calls).toEqual([]);
  await f.authorization!.assertAvailable(f.job);
  const read = await f.authorization!.authorizeRead({ job: f.job, reservation: f.row });
  expect((await read.read()).bytes).toEqual(f.bytes);
  expect(f.calls.every(url => url.startsWith(`${origin}/`))).toBe(true);
  expect(f.calls).toContain(`${origin}/storage/v1/object/fluid-assets/${f.row.storagePath}`);
  expect(f.calls.at(-1)).toContain("/rpc/authorize_logo_");
  f.state.grantMismatch = true;
  await expect(read.read()).rejects.toThrow();
});

it.each([false, true])("keeps production role/issuer pins and rejects cross-runtime identities for generative=%s", generative => {
  const f = brokerFixture(generative), createProduction = generative ? createLogoGenerativeStorageAuthorization : createLogoProductionStorageAuthorization;
  expect(createProduction(f.config)).toBeNull();
  expect(f.create({ ...f.config, workerRoleName: "fluid_logo_worker_existing" })).toBeNull();
  expect(f.create({ ...f.config, accessToken: token(production) })).toBeNull();
  expect(createProduction({ ...f.config, workerRoleName: "fluid_logo_worker_existing", accessToken: token(production) })).not.toBeNull();
  expect(f.calls).toEqual([]);
});

it.each([false, true])("fences an existing local broker after development is disabled or a hosted marker appears for generative=%s", async generative => {
  const f = brokerFixture(generative); vi.stubEnv("VERCEL", "1");
  expect(f.create(f.config)).toBeNull(); await expect(f.authorization!.assertAvailable(f.job)).rejects.toThrow();
  vi.stubEnv("VERCEL", undefined);
  await expect(f.authorization!.assertAvailable(f.job)).rejects.toThrow(); expect(f.calls).toEqual([]);
});

it("accepts only an explicitly selected supported operation union and never substitutes the agent provider credential", () => {
  expect(readDevelopmentLogoConfiguration(environment())?.image).toBeNull();
  expect(Object.keys(readDevelopmentLogoConfiguration(environment())!.operations)).toEqual(["vector", "exports"]);
  expect(readDevelopmentLogoConfiguration({ ...environment(), EMBEL_DEVELOPMENT_LOGO_OPERATIONS: "{}" })).toBeNull();
  expect(readDevelopmentLogoConfiguration({ ...environment(), EMBEL_DEVELOPMENT_LOGO_OPERATIONS: JSON.stringify({ directions: {} }) })).toBeNull();
  const paid = { ...environment(), EMBEL_DEVELOPMENT_LOGO_OPERATIONS: JSON.stringify({ concepts: concept }), FLUID_PAID_CALLS_APPROVED: "true",
    EMBEL_DEVELOPMENT_MODEL: CAPPED_LOGO_IMAGE_MODEL, EMBEL_DEVELOPMENT_VERIFIED_MODELS: CAPPED_LOGO_IMAGE_MODEL,
    EMBEL_DEVELOPMENT_IMAGE_RATE_VERSION: SUNBURST_STANDARD_IMAGE_PRICING.binding.rateVersion, OPENAI_API_KEY: "platform-agent-key-not-for-application" };
  expect(readDevelopmentLogoConfiguration(paid)).toBeNull();
  expect(readDevelopmentLogoConfiguration({ ...paid, EMBEL_DEVELOPMENT_PROVIDER_API_KEY: "explicit-development-image-test-key" })?.image?.model).toBe(CAPPED_LOGO_IMAGE_MODEL);
});

it("composes only the selected local operation brokers, runs and drains the real-host port without provider I/O", async () => {
  const config = readDevelopmentWorkerConfiguration("logo", environment())!, logo = readDevelopmentLogoConfiguration(environment())!;
  const run = vi.fn(async () => {}), close = vi.fn(async () => {});
  const startHost = vi.fn(async (options: LogoProductionHostOptions) => {
    expect(options.enabled).toBe(true);
    return { status: "qualified" as const, manifest: [], run, close };
  });
  await runDevelopmentLogo({ configuration: config, logo, roleOid: 12345, pool: { connect: vi.fn() }, signal: new AbortController().signal }, { startHost });
  expect(startHost).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  const options = startHost.mock.calls[0]![0] as unknown as Record<string, unknown>;
  expect(options).toMatchObject({ development: true, binding: { ownerId: owner, roleName: role, roleOid: 12345 } });
  expect(options.concepts).toBeUndefined(); expect(options.refinements).toBeUndefined(); expect(options.vector).toBeDefined(); expect(options.exports).toBeDefined();
});

it("classifies an unconfirmed host construction/drain without disposing live broker capabilities", async () => {
  const config = readDevelopmentWorkerConfiguration("logo", environment())!, logo = readDevelopmentLogoConfiguration(environment())!;
  const close = vi.fn(async () => { throw Error("private detail"); });
  await expect(runDevelopmentLogo({ configuration: config, logo, roleOid: 12345, pool: { connect: vi.fn() }, signal: new AbortController().signal },
    { startHost: async () => ({ status: "qualified", manifest: [], run: async () => {}, close }) })).rejects.toBeInstanceOf(DevelopmentLogoDrainUnconfirmedError);
});

it("selects the local SQL connection only under the development gate and rechecks the actual role/OID/owner for every operation", async () => {
  const client = Object.assign(new EventEmitter(), { query: vi.fn(async (query: { text: string }) => ({ rows: query.text.includes("session_user")
    ? [{ role_name: role, active_role: role, role_oid: "12345", owner_id: owner }] : [{ value: true }] })), release: vi.fn(), end: vi.fn(async () => {}) }) satisfies IdentityPoolClientPort;
  const pool = { connect: vi.fn(async () => client) }, binding = { ownerId: owner, roleName: role, roleOid: 12345, pool };
  expect(createLogoProductionConnection(binding)).toBeNull();
  const connection = createDevelopmentLogoConnection(binding)!;
  expect(connection).not.toBeNull(); expect(pool.connect).not.toHaveBeenCalled();
  await expect(connection.query("select fixture_operation() value")).resolves.toEqual({ rows: [{ value: true }] });
  expect(client.query.mock.calls.map(([query]) => query.text)).toEqual([expect.stringContaining("session_user"), "select fixture_operation() value"]);
  expect(client.query.mock.calls[0]![0].text).toContain("public.check_development_worker_binding('logo',$1,$2)");
  expect(client.query.mock.calls[0]![0].text).not.toContain("fluid_private.logo_worker_owner()");
  vi.stubEnv("NODE_ENV", "production"); expect(createDevelopmentLogoConnection(binding)).toBeNull();
  await expect(connection.query("select fixture_operation() value")).rejects.toThrow(); expect(pool.connect).toHaveBeenCalledOnce();
  await connection.close();
});
