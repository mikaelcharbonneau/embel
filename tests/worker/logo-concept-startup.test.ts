import { inspect } from "node:util";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseLogoConceptConfiguration, readProtectedLogoConceptConfiguration, startLogoConceptWorker,
  type LogoConceptStorageAuthorization, type LogoConceptStartupDependencies } from "../../worker/logo-concept-startup";
import type { OpenAIImageTransport } from "../../src/server/logo-creation/openai-image-transport";
import { CAPPED_LOGO_IMAGE_MODEL } from "../../src/domain/providers";
import { logoFixtureId as id } from "../fixtures/logo-creation";

const secret = "synthetic-secret-never-display";
const input = () => ({
  FLUID_LOGO_WORKER_DATABASE_URL: `postgresql://fluid_logo_worker:${secret}@db.fricsfwqibyhemknqgyf.supabase.co/postgres?sslmode=verify-full`,
  FLUID_LOGO_WORKER_OWNER_ID: id(1), FLUID_LOGO_WORKER_ROLE_NAME: "fluid_logo_worker", FLUID_LOGO_WORKER_ROLE_OID: "12001",
  FLUID_LOGO_WORKER_ID: "synthetic-logo-worker", FLUID_LOGO_OPENAI_API_KEY: secret,
  FLUID_LOGO_STORAGE_AUTH_USER_ID: id(3), FLUID_LOGO_SUPABASE_URL: "https://fricsfwqibyhemknqgyf.supabase.co",
  FLUID_LOGO_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic",
  FLUID_LOGO_CONCEPT_POLICY_IDENTITY: "c".repeat(64), FLUID_LOGO_CONCEPT_MAX_COST_MICROUSD: "2000",
  FLUID_LOGO_IMAGE_MODEL: CAPPED_LOGO_IMAGE_MODEL, FLUID_LOGO_IMAGE_PRICE_VERSION: "2026-10-07.v1", FLUID_LOGO_PAID_CALLS_APPROVED: "true",
});
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function fixture() {
  const events: string[] = [];
  let principal = { role_name: "fluid_logo_worker", active_role: "fluid_logo_worker", role_oid: "12001", owner_id: id(1) };
  const query = vi.fn(async ({ text }: { text: string; values: unknown[] }): Promise<{ rows: unknown[] }> => {
    if (text.includes("session_user")) { events.push("principal"); return { rows: [principal] }; }
    if (text.includes("report_logo_worker_ready")) { events.push("report"); return { rows: [{ value: true }] }; }
    if (text.includes("expire_logo_job_leases")) return { rows: [{ value: 0 }] };
    if (text.includes("claim_logo_job")) { events.push("claim"); return { rows: [] }; }
    throw new Error(secret);
  });
  const release = vi.fn(), listeners = new Map<string, (error: Error) => void>();
  const client = { query, release, on: vi.fn(), removeListener: vi.fn(), end: vi.fn(async () => {}) };
  const pool = { connect: vi.fn(async () => client), on: vi.fn((name, listener) => { listeners.set(name, listener); }),
    removeListener: vi.fn((name: string) => { listeners.delete(name); }), end: vi.fn(async () => { events.push("pool-end"); }) };
  const storage: LogoConceptStorageAuthorization = {
    assertAvailable: vi.fn(async () => { events.push("storage-ready"); }),
    authorize: vi.fn(async () => { throw new Error("Synthetic test must not publish."); }),
  };
  const dependencies: LogoConceptStartupDependencies = { createPool: vi.fn(() => pool),
    readCertificate: () => readFileSync(new URL("../../scripts/certs/supabase-prod-ca-2021.crt", import.meta.url), "utf8") };
  return { events, pool, query, release, listeners, storage, dependencies,
    setPrincipal: (value: typeof principal) => { principal = value; } };
}

describe("protected concept-only configuration", () => {
  it("returns names only and keeps every configured value out of serialization and inspection", () => {
    const result = parseLogoConceptConfiguration(input());
    expect(result.status).toBe("configured");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(inspect(result, { showHidden: true, depth: 20 })).not.toContain(secret);
    expect(Object.keys(result).sort()).toEqual(["names", "status"]);
  });
  it("is disabled only when absent and returns fixed field names for invalid values", () => {
    expect(parseLogoConceptConfiguration(undefined)).toEqual({ status: "disabled" });
    for (const [key, value] of Object.entries({ FLUID_LOGO_WORKER_ROLE_NAME: "postgres", FLUID_LOGO_WORKER_ROLE_OID: "0",
      FLUID_LOGO_IMAGE_MODEL: "other-model", FLUID_LOGO_IMAGE_PRICE_VERSION: "future-rates", FLUID_LOGO_PAID_CALLS_APPROVED: "false",
      FLUID_LOGO_WORKER_DATABASE_URL: `postgresql://postgres:${secret}@example.com/postgres?sslmode=disable`, FLUID_LOGO_CONCEPT_MAX_COST_MICROUSD: "-1" })) {
      const result = parseLogoConceptConfiguration({ ...input(), [key]: value });
      expect(result.status).toBe("unavailable"); expect(JSON.stringify(result)).not.toContain(secret); expect(JSON.stringify(result)).not.toContain(value);
    }
    expect(parseLogoConceptConfiguration({ FLUID_LOGO_OPENAI_API_KEY: secret }).status).toBe("unavailable");
    expect(parseLogoConceptConfiguration({ ...input(), OPENAI_API_KEY: secret }).status).toBe("unavailable");
  });
  it("reads only a dedicated owner-only regular configuration file and refuses symlinks or permissive mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "logo-config-test-")); roots.push(root);
    expect(await readProtectedLogoConceptConfiguration(root)).toEqual({ status: "disabled" });
    const dir = join(root, ".local-fluid"), file = join(dir, "logo-concept-worker.json");
    await mkdir(dir, { mode: 0o700 }); await writeFile(file, JSON.stringify(input()), { mode: 0o600 });
    expect((await readProtectedLogoConceptConfiguration(root)).status).toBe("configured");
    await chmod(file, 0o644); expect((await readProtectedLogoConceptConfiguration(root)).status).toBe("unavailable");
    await chmod(file, 0o600); await rm(file); await writeFile(join(root, "synthetic.json"), JSON.stringify(input()), { mode: 0o600 });
    await symlink(join(root, "synthetic.json"), file); expect((await readProtectedLogoConceptConfiguration(root)).status).toBe("unavailable");
  });
});

describe("dedicated concept worker startup", () => {
  it("does not create a pool or claim work without protected configuration and background Storage authorization", async () => {
    const f = fixture();
    for (const configuration of [parseLogoConceptConfiguration(undefined), parseLogoConceptConfiguration(input())]) {
      const started = await startLogoConceptWorker({ configuration, storage: null }, f.dependencies);
      expect(started.status).not.toBe("ready"); await started.close();
    }
    expect(f.dependencies.createPool).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled();
  });
  it("constructs only concepts with a dedicated, TLS-verified pool and no dispatch during startup", async () => {
    const f = fixture();
    const started = await startLogoConceptWorker({ configuration: parseLogoConceptConfiguration(input()), storage: f.storage }, f.dependencies);
    expect(started.status).toBe("ready"); if (started.status !== "ready") throw new Error("Expected constructed runtime");
    expect(started.runtime.manifest.map(cap => cap.operation)).toEqual(["identity.logo_concept"]);
    expect(started.runtime.manifest[0]).toMatchObject({ model: CAPPED_LOGO_IMAGE_MODEL, handlerVersion: "logo-image-v1", maxCostMicrousd: 2000 });
    expect(Object.entries(started.runtime.capabilities).filter(([, value]) => value.status === "available").map(([key]) => key)).toEqual(["identity.logo_concept"]);
    expect(f.events).toEqual(["storage-ready", "principal"]); expect(f.storage.authorize).not.toHaveBeenCalled();
    const config = vi.mocked(f.dependencies.createPool).mock.calls[0]![0];
    expect(config).toMatchObject({ user: "fluid_logo_worker", max: 3, ssl: { rejectUnauthorized: true } });
    expect(JSON.stringify(config)).not.toContain(secret); expect(config).not.toHaveProperty("connectionString");
    expect(await started.runtime.tick()).toBe("idle"); expect(f.events).toContain("claim");
    await started.close(); await started.close(); expect(f.pool.end).toHaveBeenCalledOnce();
    expect(await started.runtime.tick()).toBe("idle"); expect(await started.runtime.refreshReadiness()).toBe(false);
  });
  it.each(["role_name", "active_role", "role_oid", "owner_id"] as const)("refuses a changed %s and destroys the checked-out client", async key => {
    const f = fixture();
    f.setPrincipal({ role_name: "fluid_logo_worker", active_role: "fluid_logo_worker", role_oid: "12001", owner_id: id(1), [key]: key === "owner_id" ? id(2) : "changed" });
    const started = await startLogoConceptWorker({ configuration: parseLogoConceptConfiguration(input()), storage: f.storage }, f.dependencies);
    expect(started.status).toBe("unavailable"); expect(f.release).toHaveBeenCalledWith(true); expect(f.pool.end).toHaveBeenCalledOnce();
    expect(JSON.stringify(started)).not.toContain(secret); expect(f.events).not.toContain("report");
  });
  it("fences the runtime on idle pool errors without exposing driver errors", async () => {
    const f = fixture(); const started = await startLogoConceptWorker({ configuration: parseLogoConceptConfiguration(input()), storage: f.storage }, f.dependencies);
    if (started.status !== "ready") throw new Error("Expected runtime");
    f.listeners.get("error")!(new Error(secret));
    expect(await started.runtime.tick()).toBe("idle"); await started.close(); expect(f.pool.end).toHaveBeenCalledOnce();
  });
});

// Composition regression: rejecting reference-bearing inputs must occur before
// the injected image transport; the initial contract still carries six slots.
describe("reference-free concept composition", () => {
  it("rejects uploaded references before storage reads or image dispatch", async () => {
    const { syntheticLogoJob, syntheticResolvedLogoConcept, syntheticLogoReferences } = await import("../fixtures/logo-creation");
    const f = fixture(), resolved = structuredClone(syntheticResolvedLogoConcept()), reference = syntheticLogoReferences()[0]!;
    resolved.referenceSnapshot.references = [{ asset: reference.asset, referenceId: reference.referenceId, sourceKind: reference.sourceKind, rightsEvidenceId: reference.rightsEvidenceId, aspects: reference.aspects }];
    resolved.input.references = resolved.referenceSnapshot.references.map(item => item.asset);
    const job = syntheticLogoJob(resolved.input), previous = f.query.getMockImplementation()!;
    const row = { id: job.id, owner_id: job.ownerId, project_id: job.projectId, operation: job.operation, input: job.input, input_revision: job.inputRevision,
      lease_token: job.leaseToken, state: job.status, reserved_cost_microusd: job.reservedCostMicrousd, actual_cost_microusd: 0 };
    f.query.mockImplementation(async request => {
      if (request.text.includes("claim_logo_job") || request.text.includes("heartbeat_logo_job")) return { rows: [row] };
      if (request.text.includes("begin_logo_job_step")) return { rows: [{ value: "started" }] };
      if (["register_logo_job_plan", "complete_logo_job_step", "finish_logo_job"].some(part => request.text.includes(part))) return { rows: [] };
      return previous(request);
    });
    const createImage = vi.fn(async () => { throw new Error("Must not dispatch"); });
    const started = await startLogoConceptWorker({ configuration: parseLogoConceptConfiguration(input()), storage: f.storage }, { ...f.dependencies, imageTransport: { createImage } });
    if (started.status !== "ready") throw new Error("Expected runtime");
    expect(await started.runtime.tick()).toBe("failed"); expect(createImage).not.toHaveBeenCalled(); expect(f.storage.authorize).not.toHaveBeenCalled();
    expect(resolved.input.plan.slots).toHaveLength(6); await started.close();
  });
  it("drains a pending readiness query before closing its own pool", async () => {
    const f = fixture(), previous = f.query.getMockImplementation()!;
    let finish!: (value: { rows: { value: boolean }[] }) => void, begin!: () => void;
    const begun = new Promise<void>(resolve => { begin = resolve; });
    f.query.mockImplementation(async request => {
      if (request.text.includes("report_logo_worker_ready")) { begin(); return new Promise(resolve => { finish = resolve; }); }
      return previous(request);
    });
    const started = await startLogoConceptWorker({ configuration: parseLogoConceptConfiguration(input()), storage: f.storage }, f.dependencies);
    if (started.status !== "ready") throw new Error("Expected runtime");
    const refreshing = started.runtime.refreshReadiness(); await begun;
    const closing = started.close(); expect(f.pool.end).not.toHaveBeenCalled();
    finish({ rows: [{ value: true }] }); expect(await refreshing).toBe(false); await closing;
    expect(f.pool.end).toHaveBeenCalledOnce(); expect(await started.runtime.tick()).toBe("idle");
  });
});

describe("actual concept adapter composition with synthetic transports", () => {
  it("uses the frozen Sunburst request/pricer and leased immutable upload plus byte read-back", async () => {
    const sharp = (await import("sharp")).default;
    const { createHash } = await import("node:crypto");
    const { syntheticLogoJob, syntheticResolvedLogoConcept } = await import("../fixtures/logo-creation");
    const resolved = syntheticResolvedLogoConcept(), job = syntheticLogoJob(), f = fixture(), previous = f.query.getMockImplementation()!;
    const png = new Uint8Array(await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#222222" } }).png().toBuffer());
    const hash = createHash("sha256").update(png).digest("hex");
    const reference = { ownerId: job.ownerId, projectId: job.projectId, assetId: id(901), versionId: id(902), contentHash: hash };
    const reservation = { id: id(903), requestKey: resolved.input.attemptId, reference,
      storagePath: `${job.ownerId}/${job.projectId}/${reference.assetId}/${reference.versionId}`, mimeType: "image/png", byteLength: png.length,
      purpose: "brand_asset", sourceReceiptId: resolved.input.attemptId, rightsEvidenceId: null, publicationState: "staged" };
    const row = { id: job.id, owner_id: job.ownerId, project_id: job.projectId, operation: job.operation, input: job.input, input_revision: job.inputRevision,
      lease_token: job.leaseToken, state: job.status, reserved_cost_microusd: job.reservedCostMicrousd, actual_cost_microusd: 0 };
    let observedBilling: unknown, completion: unknown[], uploaded: Uint8Array | undefined;
    const createImage = vi.fn<OpenAIImageTransport["createImage"]>(async () => ({ bytes: png, mimeType: "image/png" as const, providerRequestId: "synthetic-image-response", responseHash: "a".repeat(64),
      usage: { input_tokens: 2, output_tokens: 3, input_tokens_details: { text_tokens: 2, image_tokens: 0 } } }));
    const storage: LogoConceptStorageAuthorization = { ...f.storage, authorize: vi.fn(async () => ({
      async putIfAbsent(bytes: Uint8Array, mimeType: string) { expect(mimeType).toBe("image/png"); expect(uploaded).toBeUndefined(); uploaded = Uint8Array.from(bytes); f.events.push("upload"); },
      async read() { f.events.push("read-back"); if (!uploaded) throw new Error("No object"); return { bytes: uploaded, mimeType: "image/png" }; },
    })) };
    f.query.mockImplementation(async request => {
      const sql = request.text, parameters = request.values;
      if (sql.includes("claim_logo_job") || sql.includes("heartbeat_logo_job")) return { rows: [row] };
      if (sql.includes("runtime_readiness")) return { rows: [{ value: true }] };
      if (sql.includes("read_leased_logo_record")) return { rows: [{ value: resolved }] };
      if (sql.includes("begin_logo_job_step")) return { rows: [{ value: "started" }] };
      if (sql.includes("record_logo_provider_response")) {
        const observation = JSON.parse(parameters[2] as string); observedBilling = observation.billing;
        return { rows: [{ value: { ...observation, id: id(900), ownerId: job.ownerId, projectId: job.projectId, jobId: job.id, leaseToken: job.leaseToken } }] };
      }
      if (sql.includes("prepare_logo_asset")) return { rows: [{ value: reservation }] };
      if (sql.includes("observe_logo_asset")) { f.events.push("observe"); return { rows: [{ value: { id: reservation.id, reference, verification: JSON.parse(parameters[1] as string),
        purpose: "brand_asset", sourceReceiptId: resolved.input.attemptId, rightsEvidenceId: null, publicationState: "staged" } }] }; }
      if (sql.includes("complete_logo_job_step")) { completion = parameters; return { rows: [] }; }
      if (["register_logo_job_plan", "finish_logo_job"].some(part => sql.includes(part))) return { rows: [] };
      return previous(request);
    });
    const started = await startLogoConceptWorker({ configuration: parseLogoConceptConfiguration(input()), storage }, { ...f.dependencies, imageTransport: { createImage } });
    if (started.status !== "ready") throw new Error("Expected runtime");
    expect(await started.runtime.tick()).toBe("succeeded");
    expect(createImage).toHaveBeenCalledOnce(); expect(createImage.mock.calls[0]![0]).toMatchObject({ model: CAPPED_LOGO_IMAGE_MODEL, size: "1024x1024", quality: "medium", images: [] });
    expect(observedBilling).toEqual({ status: "recorded", confirmedMicrousd: 100 });
    expect(storage.authorize).toHaveBeenCalledWith(expect.objectContaining({ ownerId: job.ownerId, projectId: job.projectId, jobId: job.id, leaseToken: job.leaseToken,
      reservation: expect.objectContaining({ id: reservation.id, storagePath: reservation.storagePath }) }), expect.any(AbortSignal));
    expect(f.events.filter(event => ["upload", "read-back", "observe"].includes(event))).toEqual(["upload", "read-back", "observe"]);
    expect(completion![3]).toBe("succeeded"); expect(completion![4]).toBe(100);
    const output = JSON.parse(completion![5] as string); expect(output).toMatchObject({ publicationId: reservation.id, providerResponseReceiptId: id(900) });
    expect(f.query.mock.calls.filter(([request]) => request.text.includes("session_user"))).toHaveLength(f.query.mock.calls.filter(([request]) => !request.text.includes("session_user")).length + 1);
    await started.close();
  });
});

it("preserves the validated plan-conflict sentinel needed to settle a changed durable plan", async () => {
  const { syntheticLogoJob } = await import("../fixtures/logo-creation");
  const job = syntheticLogoJob(), f = fixture(), previous = f.query.getMockImplementation()!;
  const row = { id: job.id, owner_id: job.ownerId, project_id: job.projectId, operation: job.operation, input: job.input, input_revision: job.inputRevision,
    lease_token: job.leaseToken, state: job.status, reserved_cost_microusd: job.reservedCostMicrousd, actual_cost_microusd: 0 };
  const states: unknown[] = [];
  f.query.mockImplementation(async request => {
    if (request.text.includes("claim_logo_job")) return { rows: [row] };
    if (request.text.includes("register_logo_job_plan")) throw new Error("plan_conflict");
    if (request.text.includes("has_results")) return { rows: [{ value: false }] };
    if (request.text.includes("finish_logo_job")) { states.push(request.values[2]); return { rows: [] }; }
    return previous(request);
  });
  const started = await startLogoConceptWorker({ configuration: parseLogoConceptConfiguration(input()), storage: f.storage }, f.dependencies);
  if (started.status !== "ready") throw new Error("Expected runtime");
  expect(await started.runtime.tick()).toBe("failed"); expect(states).toEqual(["failed"]); await started.close();
});


const syntheticStorageToken = () => `${Buffer.from('{"alg":"ES256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({
  sub: id(3), session_id: id(4), role: "authenticated", aud: "authenticated", iss: "https://fricsfwqibyhemknqgyf.supabase.co/auth/v1",
  exp: 2_000_000_000, is_anonymous: false,
})).toString("base64url")}.synthetic_signature`;
const sessionInput = () => ({ ...input(), FLUID_LOGO_STORAGE_ACCESS_TOKEN: syntheticStorageToken(), FLUID_LOGO_STORAGE_SESSION_APPROVED: "true" });
function storageRequests() {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/auth/v1/user")) return Response.json({ id: id(3), is_anonymous: false });
    if (String(url).endsWith("/rpc/logo_storage_session")) return Response.json({ ownerId: id(1), authUserId: id(3), sessionId: id(4),
      workerRoleName: "fluid_logo_worker", workerRoleOid: 12001, workerId: "synthetic-logo-worker" });
    throw new Error("Unexpected synthetic transport request");
  });
  return { requests, fetcher, dependencies: { fetch: fetcher, now: () => 1_900_000_000_000 } };
}
describe("protected CLI Storage composition", () => {
  it("preserves disabled legacy startup when the dedicated configuration is absent", async () => {
    const f = fixture(), network = storageRequests();
    const result = await startLogoConceptWorker({ configuration: parseLogoConceptConfiguration(undefined) }, { ...f.dependencies, storageTransport: network.dependencies });
    expect(result).toMatchObject({ status: "disabled", reason: "configuration" });
    expect(f.dependencies.createPool).not.toHaveBeenCalled(); expect(network.fetcher).not.toHaveBeenCalled(); await result.close();
  });
  it("requires expected dedicated identity and fixed project metadata, but permits absent short-lived session", () => {
    expect(parseLogoConceptConfiguration(input()).status).toBe("configured");
    for (const [key, value] of Object.entries({ FLUID_LOGO_STORAGE_AUTH_USER_ID: id(1), FLUID_LOGO_SUPABASE_URL: "https://other.supabase.co",
      FLUID_LOGO_SUPABASE_PUBLISHABLE_KEY: "sb_secret_wrong", FLUID_LOGO_STORAGE_ACCESS_TOKEN: "malformed", FLUID_LOGO_STORAGE_SESSION_APPROVED: "maybe" })) {
      expect(parseLogoConceptConfiguration({ ...input(), [key]: value }).status).toBe("unavailable");
    }
    for (const key of ["FLUID_LOGO_STORAGE_AUTH_USER_ID", "FLUID_LOGO_SUPABASE_URL", "FLUID_LOGO_SUPABASE_PUBLISHABLE_KEY"]) {
      const missing: Record<string, string> = input(); delete missing[key];
      expect(parseLogoConceptConfiguration(missing).status).toBe("unavailable");
    }
    const result = parseLogoConceptConfiguration(sessionInput());
    expect(result.status).toBe("configured");
    expect(JSON.stringify(result)).not.toContain(syntheticStorageToken());
    expect(inspect(result, { showHidden: true, depth: 20 })).not.toContain(syntheticStorageToken());
  });
  it("does not construct usable authority or make requests without a session and explicit approval", async () => {
    for (const raw of [input(), { ...input(), FLUID_LOGO_STORAGE_ACCESS_TOKEN: syntheticStorageToken() },
      { ...sessionInput(), FLUID_LOGO_STORAGE_SESSION_APPROVED: "false" }]) {
      const f = fixture(), network = storageRequests();
      const result = await startLogoConceptWorker({ configuration: parseLogoConceptConfiguration(raw) }, { ...f.dependencies, storageTransport: network.dependencies });
      expect(result).toMatchObject({ status: "unavailable", reason: "background_storage" });
      expect(f.dependencies.createPool).not.toHaveBeenCalled(); expect(network.fetcher).not.toHaveBeenCalled(); await result.close();
    }
  });
  it("builds the real transport from private configuration and closes it after draining runtime work", async () => {
    const f = fixture(), network = storageRequests();
    const started = await startLogoConceptWorker({ configuration: parseLogoConceptConfiguration(sessionInput()) }, { ...f.dependencies, storageTransport: network.dependencies });
    expect(started.status).toBe("ready"); if (started.status !== "ready") throw new Error("Expected configured runtime");
    expect(network.requests.map(request => request.url)).toEqual(["https://fricsfwqibyhemknqgyf.supabase.co/auth/v1/user", "https://fricsfwqibyhemknqgyf.supabase.co/rest/v1/rpc/logo_storage_session"]);
    expect(new Headers(network.requests[0]!.init.headers).get("authorization")).toBe(`Bearer ${syntheticStorageToken()}`);
    expect(JSON.stringify(started)).not.toContain(syntheticStorageToken());
    const prior = f.query.getMockImplementation()!;
    let finish!: (result: { rows: unknown[] }) => void, begin!: () => void;
    const begun = new Promise<void>(resolve => { begin = resolve; });
    f.query.mockImplementation(async request => request.text.includes("report_logo_worker_ready") ? (begin(), new Promise(resolve => { finish = resolve; })) : prior(request));
    const refresh = started.runtime.refreshReadiness(); await begun;
    const closing = started.close();
    expect(network.requests.every(request => !request.init.signal?.aborted)).toBe(true); expect(f.pool.end).not.toHaveBeenCalled();
    finish({ rows: [{ value: true }] }); await refresh; await closing; await started.close();
    expect(network.requests.every(request => request.init.signal?.aborted)).toBe(true); expect(f.pool.end).toHaveBeenCalledOnce();
  });
  it("closes its constructed transport when dedicated database validation fails", async () => {
    const f = fixture(), network = storageRequests();
    f.setPrincipal({ role_name: "fluid_logo_worker", active_role: "fluid_logo_worker", role_oid: "12002", owner_id: id(1) });
    const result = await startLogoConceptWorker({ configuration: parseLogoConceptConfiguration(sessionInput()) }, { ...f.dependencies, storageTransport: network.dependencies });
    expect(result).toMatchObject({ status: "unavailable", reason: "dependency_validation" });
    expect(network.requests).toHaveLength(2); expect(network.requests.every(request => request.init.signal?.aborted)).toBe(true);
    expect(f.pool.end).toHaveBeenCalledOnce();
  });
  it("fails closed before creating a pool when Auth rejects the supplied session, without login or refresh", async () => {
    const f = fixture(), network = storageRequests(); network.fetcher.mockResolvedValueOnce(Response.json({}, { status: 401 }));
    const result = await startLogoConceptWorker({ configuration: parseLogoConceptConfiguration(sessionInput()) }, { ...f.dependencies, storageTransport: network.dependencies });
    expect(result.status).toBe("unavailable"); expect(network.fetcher).toHaveBeenCalledOnce(); expect(f.dependencies.createPool).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(syntheticStorageToken());
  });
});

it("preserves the reference-free caller's stopped guard before frozen-input SQL after a late claim", async () => {
  const { syntheticLogoJob } = await import("../fixtures/logo-creation");
  const job = syntheticLogoJob(), f = fixture(), previous = f.query.getMockImplementation()!;
  const row = { id: job.id, owner_id: job.ownerId, project_id: job.projectId, operation: job.operation, input: job.input,
    input_revision: job.inputRevision, lease_token: job.leaseToken, state: job.status, reserved_cost_microusd: job.reservedCostMicrousd, actual_cost_microusd: 0 };
  const createImage = vi.fn<OpenAIImageTransport["createImage"]>(async (): Promise<never> => { throw Error("Stopped runtime must not dispatch"); });
  f.query.mockImplementation(async request => {
    if (request.text.includes("claim_logo_job")) { f.listeners.get("error")!(new Error("Synthetic idle pool stop")); return { rows: [row] }; }
    if (request.text.includes("heartbeat_logo_job")) return { rows: [row] };
    if (request.text.includes("begin_logo_job_step")) return { rows: [{ value: "started" }] };
    if (["register_logo_job_plan", "complete_logo_job_step", "finish_logo_job"].some(sql => request.text.includes(sql))) return { rows: [] };
    return previous(request);
  });
  const started = await startLogoConceptWorker({ configuration: parseLogoConceptConfiguration(input()), storage: f.storage }, { ...f.dependencies, imageTransport: { createImage } });
  if (started.status !== "ready") throw Error("Expected constructed runtime");
  expect(await started.runtime.tick()).toBe("failed");
  expect(f.query.mock.calls.some(([q]) => q.text.includes("read_leased_logo_record"))).toBe(false);
  expect(createImage).not.toHaveBeenCalled(); await started.close();
});
