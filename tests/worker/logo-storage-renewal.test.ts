import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createLocalLogoStorageSession, readLocalLogoStorageConfiguration, verifyLocalLogoStorageSession, type LocalLogoStorageSessionDependencies } from "../../worker/logo-local-storage-session";
import { createLogoGenerativeStorageAuthorization, type LogoStorageTokenProvider } from "../../worker/logo-generative-storage-authorization";
import { getLogoDedicatedConfiguration, parseLogoDedicatedConfiguration } from "../../worker/logo-dedicated-config";
import { authUserId, claims, configurationInput, identity, syntheticSecret, token } from "./logo-dedicated-fixture";
import { syntheticLogoJob, syntheticResolvedLogoConcept } from "../fixtures/logo-creation";

const storageIdentity = { version: 1, ownerId: identity.ownerId, authUserId, email: "synthetic@example.invalid", password: syntheticSecret };
const config = () => { const raw = configurationInput(); return { ...raw, operations: { concepts: raw.operations.concepts } }; };
function fixture() {
  const state = { now: Date.now(), sessionId: claims().session_id };
  const response = (extra: Record<string, unknown> = {}) => ({ error: null, data: { session: {
    access_token: token({ ...claims(), session_id: state.sessionId, exp: Math.floor(state.now / 1000) + 3600, ...extra }),
    refresh_token: `synthetic-refresh-${state.now}`, user: { id: authUserId, is_anonymous: false },
  } } });
  const client = { signInWithPassword: vi.fn(async () => response()), refreshSession: vi.fn(async () => response()), dispose: vi.fn(async () => {}) };
  const dependencies: LocalLogoStorageSessionDependencies = { createAuthClient: vi.fn(() => client), now: () => state.now, verifySession: vi.fn(async () => {}) };
  return { state, client, dependencies, response };
}
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("explicit local logo Storage renewal", () => {
  it("shares normal session renewal with the exact paired preview-refinement policy", async () => {
    const f = fixture(), input = config();
    Object.assign(input.operations, { refinements: { ...input.operations.concepts, operation: "identity.logo_refine" } });
    const session = await createLocalLogoStorageSession(storageIdentity, input, f.dependencies);
    const first = await session.tokenProvider(); f.state.now += 3500_000;
    expect(await session.tokenProvider()).not.toBe(first);
    expect(f.client.signInWithPassword).toHaveBeenCalledTimes(1); expect(f.client.refreshSession).toHaveBeenCalledTimes(1);
    await session.close();
  });
  it.each(["policyIdentity", "operation", "maxCostMicrousd"])("rejects a mismatched refinement %s before credential use", async field => {
    const f = fixture(), input = config(), refinement = { ...input.operations.concepts, operation: "identity.logo_refine" };
    Object.assign(refinement, { [field]: field === "policyIdentity" ? "e".repeat(64) : field === "operation" ? "identity.logo_concept" : refinement.maxCostMicrousd + 1 });
    Object.assign(input.operations, { refinements: refinement });
    await expect(createLocalLogoStorageSession(storageIdentity, input, f.dependencies)).rejects.toThrow("Local logo Storage session is unavailable.");
    expect(f.dependencies.createAuthClient).not.toHaveBeenCalled();
  });
  it("renews before expiry, rotates only in memory, and coalesces concurrent callers", async () => {
    const f = fixture(), session = await createLocalLogoStorageSession(storageIdentity, config(), f.dependencies);
    const initial = await session.tokenProvider();
    expect(f.client.signInWithPassword).toHaveBeenCalledWith({ email: storageIdentity.email, password: syntheticSecret });
    expect(f.client.refreshSession).not.toHaveBeenCalled();
    f.state.now += 3500_000;
    const tokens = await Promise.all(Array.from({ length: 5 }, () => session.tokenProvider()));
    expect(new Set(tokens).size).toBe(1); expect(tokens[0]).not.toBe(initial);
    expect(f.client.refreshSession).toHaveBeenCalledTimes(1);
    expect(f.client.refreshSession).toHaveBeenCalledWith({ refresh_token: expect.stringMatching(/^synthetic-refresh-/) });
    f.state.now += 3500_000;
    expect(await session.tokenProvider()).not.toBe(tokens[0]);
    expect(f.client.refreshSession).toHaveBeenCalledTimes(2);
    await session.close();
    await expect(session.tokenProvider()).rejects.toThrow("Local logo Storage session is unavailable.");
    expect(f.client.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(["owner", "user", "lane"])("rejects an incompatible %s before credential use", async field => {
    const f = fixture(), input = config();
    if (field === "owner") input.binding.ownerId = authUserId;
    if (field === "user") input.storage.authUserId = identity.ownerId;
    if (field === "lane") Object.assign(input.operations, { exports: configurationInput().operations.exports });
    await expect(createLocalLogoStorageSession(storageIdentity, input, f.dependencies)).rejects.toThrow("Local logo Storage session is unavailable.");
    expect(f.dependencies.createAuthClient).not.toHaveBeenCalled();
  });

  it.each([
    { session_id: "d0000000-0000-4000-8000-000000000099" }, { sub: identity.ownerId }, { role: "service_role" },
    { iss: "https://example.invalid/auth/v1" }, { is_anonymous: true }, { exp: 1 }, { nbf: 9_000_000_000 },
  ])("rejects changed or expired refreshed claims without signing in again: %j", async extra => {
    const f = fixture(), session = await createLocalLogoStorageSession(storageIdentity, config(), f.dependencies);
    f.state.now += 3500_000; f.client.refreshSession.mockImplementation(async () => f.response(extra));
    await expect(session.tokenProvider()).rejects.toThrow("Local logo Storage session is unavailable.");
    expect(f.client.signInWithPassword).toHaveBeenCalledTimes(1); await session.close();
  });

  it("does not expose an Auth failure or revive a closed session when refresh returns late", async () => {
    const f = fixture(), session = await createLocalLogoStorageSession(storageIdentity, config(), f.dependencies);
    f.state.now += 3500_000;
    let finish!: (value: ReturnType<typeof f.response>) => void;
    f.client.refreshSession.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = session.tokenProvider();
    await session.close(); finish(f.response());
    await expect(pending).rejects.toEqual(new Error("Local logo Storage session is unavailable."));
    const g = fixture(); g.client.signInWithPassword.mockRejectedValue(new Error(syntheticSecret));
    await expect(createLocalLogoStorageSession(storageIdentity, config(), g.dependencies)).rejects.toEqual(new Error("Local logo Storage session is unavailable."));
    expect(g.client.dispose).toHaveBeenCalledTimes(1);
  });

  it("starts from an expired protected token snapshot without rewriting either credential file", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "embel-logo-renewal-"))); roots.push(root);
    const dir = join(root, ".local-fluid"), configurationPath = join(dir, "logo-worker.json"), identityPath = join(dir, "logo-storage-identity.json");
    await mkdir(dir, { mode: 0o700 });
    const raw = config(); raw.storage.accessToken = token({ ...claims(), exp: 1 });
    const originalConfig = JSON.stringify(raw), originalIdentity = JSON.stringify(storageIdentity);
    await writeFile(configurationPath, originalConfig, { mode: 0o600 }); await writeFile(identityPath, originalIdentity, { mode: 0o600 });
    const f = fixture(), runtime = await readLocalLogoStorageConfiguration(configurationPath, identityPath, f.dependencies);
    expect(runtime.configuration.status).toBe("configured");
    expect(getLogoDedicatedConfiguration(runtime.configuration)?.storage?.accessToken).not.toBe(raw.storage.accessToken);
    expect(f.dependencies.verifySession).toHaveBeenCalledTimes(1);
    expect(await readFile(configurationPath, "utf8")).toBe(originalConfig); expect(await readFile(identityPath, "utf8")).toBe(originalIdentity);
    expect(JSON.stringify(runtime)).not.toContain(syntheticSecret); await runtime.close();
    await chmod(identityPath, 0o644);
    await expect(readLocalLogoStorageConfiguration(configurationPath, identityPath, f.dependencies)).rejects.toThrow();
    expect(f.client.signInWithPassword).toHaveBeenCalledTimes(1);
  });

  it("verifies exact live Auth and SQL session binding without claiming work", async () => {
    const raw = config(), configuration = parseLogoDedicatedConfiguration(raw);
    const binding = { ownerId: raw.binding.ownerId, authUserId, sessionId: claims().session_id, workerRoleName: raw.binding.roleName,
      workerRoleOid: raw.binding.roleOid, workerId: raw.workerId };
    const transport = vi.fn<typeof fetch>(async input => Response.json(String(input).endsWith("/auth/v1/user") ? { id: authUserId, is_anonymous: false } : binding));
    await verifyLocalLogoStorageSession(configuration, raw.storage.accessToken, transport);
    expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
      "https://fricsfwqibyhemknqgyf.supabase.co/auth/v1/user", "https://fricsfwqibyhemknqgyf.supabase.co/rest/v1/rpc/logo_storage_session",
    ]);
    binding.workerRoleOid++;
    await expect(verifyLocalLogoStorageSession(configuration, raw.storage.accessToken, transport)).rejects.toThrow("Local logo Storage session is unavailable.");
  });
});

describe("generative broker renewed session fences", () => {
  function brokerFixture(tokenProvider: LogoStorageTokenProvider) {
    const resolved = syntheticResolvedLogoConcept(), raw = configurationInput();
    const capability = { ...raw.operations.concepts, policyIdentity: resolved.input.policyIdentity };
    const job = { ...syntheticLogoJob(), input: resolved.input, operation: "identity.logo_concept" as const, reservedCostMicrousd: 1000, actualCostMicrousd: 0 };
    const now = Date.now() + 7200_000;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (String(_url).endsWith("/auth/v1/user")) return Response.json({ id: authUserId, is_anonymous: false });
      const body = JSON.parse(String(init?.body));
      return Response.json({ ownerId: job.ownerId, authUserId, sessionId: claims().session_id, workerRoleName: raw.binding.roleName,
        workerRoleOid: raw.binding.roleOid, workerId: raw.workerId, capability, jobId: job.id, leaseToken: job.leaseToken,
        inputRevision: job.inputRevision, jobInput: job.input, mode: body.p_mode, member: null, reservation: null, publication: null });
    });
    const authorization = createLogoGenerativeStorageAuthorization({ ownerId: job.ownerId, authUserId, workerRoleName: raw.binding.roleName,
      workerRoleOid: raw.binding.roleOid, workerId: raw.workerId, publishableKey: raw.storage.publishableKey,
      accessToken: raw.storage.accessToken, capability }, { fetch: fetcher, now: () => now, tokenProvider });
    return { authorization: authorization!, fetcher, job, now };
  }
  it("uses renewed tokens after the initial snapshot expires and retains Auth and SQL checks", async () => {
    const renewed = token({ ...claims(), exp: Math.floor(Date.now() / 1000) + 10_800 });
    const f = brokerFixture(async () => renewed);
    await f.authorization.assertAvailable(f.job);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of f.fetcher.mock.calls) expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${renewed}`);
    f.authorization.close();
    await expect(f.authorization.assertAvailable(f.job)).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([{ session_id: "d0000000-0000-4000-8000-000000000099" }, { sub: identity.ownerId }, { role: "service_role" }, { exp: 1 }])(
    "denies incompatible provider output before Auth or Storage transport: %j", async extra => {
      const f = brokerFixture(async () => token({ ...claims(), exp: Math.floor(Date.now() / 1000) + 10_800, ...extra }));
      await expect(f.authorization.assertAvailable(f.job)).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
    });
});
