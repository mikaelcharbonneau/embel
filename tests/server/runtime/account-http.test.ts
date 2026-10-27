import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolConfig } from "pg";
import type { AuthenticatedContext } from "@/server/auth/context";
import type { IdentityPoolClientPort } from "@/server/runtime/identity-pool";
vi.mock("server-only", () => ({}));
import { readAccountHttpConfiguration } from "@/server/runtime/account-http-configuration";
import { createAccountHttpRuntime, resolveAccountIdentityRuntime, startAccountHttpServices } from "@/server/runtime/account-http-services";
import { createAccountHomeStorageTransport } from "@/server/runtime/account-home-storage";
import { LOGO_SUPABASE_ORIGIN } from "@/server/runtime/logo-web-configuration";
import { getHomeAttachmentCapability, stageHomeAttachment } from "@/server/home-attachments";
import { createIdentityTrustedDatabase } from "../../database/identity-trusted-replacement-database";
import { OWNER_A, OWNER_B, resetFixture, seedProject } from "../../database/local-supabase";
import { seedIdentityRoot } from "../../database/identity-system-database";

const outsider = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const cert = readFileSync(new URL("../../../scripts/certs/supabase-prod-ca-2021.crt", import.meta.url), "utf8");
function capability(roleName: string, roleOid: number) {
  return { roleName, roleOid, databaseUrl: `postgresql://${roleName}:synthetic-password@db.fricsfwqibyhemknqgyf.supabase.co:5432/postgres?sslmode=verify-full` };
}
function bindings() {
  return [
    { ownerId: OWNER_A, identity: capability("embel_identity_web_a", 101), attachments: capability("embel_home_web_a", 102) },
    { ownerId: OWNER_B, identity: capability("embel_identity_web_b", 103), attachments: capability("embel_home_web_b", 104) },
  ];
}
const environment = (owners: unknown = bindings()) => ({ NODE_ENV: "production" as const, EMBEL_ACCOUNT_HTTP_ENABLED: "true",
  EMBEL_ACCOUNT_HTTP_BINDINGS: JSON.stringify(owners), NEXT_PUBLIC_SUPABASE_URL: LOGO_SUPABASE_ORIGIN,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic_account_http" });
function auth(owner = OWNER_A, tokenOwner = owner) {
  const user = { id: tokenOwner, is_anonymous: false, email_confirmed_at: "2026-10-01T00:00:00Z" };
  return { userId: owner, client: { auth: {
    getSession: vi.fn(async () => ({ data: { session: { access_token: `synthetic-${owner}`, user } }, error: null })),
    getUser: vi.fn(async () => ({ data: { user }, error: null })),
  }, rpc: vi.fn() } } as unknown as AuthenticatedContext;
}
function resetRuntime() {
  for (const key of ["embel.account-http.runtime.v1", "embel.account-http.bootstrap.v1"]) Reflect.deleteProperty(globalThis, Symbol.for(key));
}
afterEach(() => { resetRuntime(); vi.unstubAllEnvs(); });

describe("explicit multi-owner production HTTP registry", () => {
  it("leaves omitted or disabled production registry closed without reading certificates or creating pools", () => {
    const dependencies = { createPool: vi.fn(), readCertificate: vi.fn(), fetch: vi.fn() };
    expect(readAccountHttpConfiguration({})).toBeNull();
    expect(createAccountHttpRuntime({ ...environment(), EMBEL_ACCOUNT_HTTP_ENABLED: "false" }, dependencies)).toBeNull();
    expect(startAccountHttpServices({}, dependencies)).toBe("disabled");
    expect(dependencies.createPool).not.toHaveBeenCalled(); expect(dependencies.readCertificate).not.toHaveBeenCalled();
  });
  it("accepts two independent owners and hides parsed credential fields from serialization", () => {
    const config = readAccountHttpConfiguration(environment())!;
    expect(config.owners.map(owner => owner.ownerId)).toEqual([OWNER_A, OWNER_B]);
    expect(config.owners[0]!.identity!.database.password).toBe("synthetic-password");
    expect(JSON.stringify(config)).not.toContain("synthetic-password");
    expect(Object.isFrozen(config.owners)).toBe(true);
  });
  it.each(["duplicate-owner", "duplicate-login", "duplicate-oid", "shared-capability-oid", "empty-owner", "unknown-field", "too-many"])(
    "rejects ambiguous registry membership: %s", mode => {
      const list = bindings();
      if (mode === "duplicate-owner") list[1]!.ownerId = OWNER_A;
      if (mode === "duplicate-login") list[1]!.identity = { ...list[0]!.identity, roleOid: 105 };
      if (mode === "duplicate-oid") list[1]!.identity.roleOid = 101;
      if (mode === "shared-capability-oid") list[0]!.attachments.roleOid = 101;
      const input = mode === "empty-owner" ? [{ ownerId: OWNER_A }] : mode === "unknown-field" ? [{ ...list[0], owner: OWNER_B }]
        : mode === "too-many" ? Array.from({ length: 101 }, (_, index) => ({ ...list[0], ownerId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` })) : list;
      expect(() => readAccountHttpConfiguration(environment(input))).toThrow(expect.objectContaining({ code: "integration_unavailable" }));
    });
  it.each([
    { roleName: "postgres" }, { roleName: "service_role" }, { roleName: "fluid_naming_brain_worker" },
    { roleName: "embel_dev_identity_local" }, { roleOid: 0 }, { roleOid: 4_294_967_296 },
    { databaseUrl: "postgresql://embel_identity_web_a:synthetic-password@other.invalid:5432/postgres?sslmode=verify-full" },
    { databaseUrl: "postgresql://embel_identity_web_a:synthetic-password@127.0.0.1:5432/postgres?sslmode=verify-full" },
    { databaseUrl: "postgresql://embel_identity_web_a:synthetic-password@db.fricsfwqibyhemknqgyf.supabase.co:6543/postgres?sslmode=verify-full" },
    { databaseUrl: bindings()[0]!.identity.databaseUrl.replace("verify-full", "require") },
    { databaseUrl: bindings()[0]!.identity.databaseUrl + "&options=-c%20role=postgres" },
    { databaseUrl: bindings()[0]!.identity.databaseUrl + "#fragment" },
    { databaseUrl: bindings()[0]!.identity.databaseUrl.replace("embel_identity_web_a:", "postgres:") },
  ])("rejects privileged, cross-target or broader credential selectors %#", change => {
    const list = bindings(); list[0]!.identity = { ...list[0]!.identity, ...change };
    let failure: unknown;
    try { readAccountHttpConfiguration(environment(list)); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "integration_unavailable" });
    expect(String(failure)).not.toContain("synthetic-password");
  });
  it("requires the same approved public Supabase project and only a public key", () => {
    for (const override of [{ NEXT_PUBLIC_SUPABASE_URL: "https://other.supabase.co" },
      { NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_forbidden" }, { EMBEL_ACCOUNT_HTTP_BINDINGS: "not JSON synthetic-password" }]) {
      expect(() => readAccountHttpConfiguration({ ...environment(), ...override })).toThrow(expect.objectContaining({ code: "integration_unavailable" }));
    }
  });
  it("accepts only the exact session-pooler login suffix", () => {
    const list = bindings();
    list[0]!.identity.databaseUrl = "postgresql://embel_identity_web_a.fricsfwqibyhemknqgyf:synthetic-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full";
    expect(readAccountHttpConfiguration(environment(list))!.owners[0]!.identity!.database.user).toBe("embel_identity_web_a.fricsfwqibyhemknqgyf");
    list[0]!.identity.databaseUrl = list[0]!.identity.databaseUrl.replace(".fricsfwqibyhemknqgyf:", ".other:");
    expect(() => readAccountHttpConfiguration(environment(list))).toThrow();
  });
  it("checks the public CA before constructing any pool", () => {
    const dependencies = { createPool: vi.fn(), readCertificate: () => "changed certificate", fetch: vi.fn() };
    expect(() => createAccountHttpRuntime(environment(), dependencies)).toThrow(expect.objectContaining({ code: "integration_unavailable" }));
    expect(dependencies.createPool).not.toHaveBeenCalled();
  });
  it("closes already constructed lazy pools when later registry construction fails", async () => {
    const first = Object.assign(new EventEmitter(), { connect: vi.fn(), end: vi.fn(async () => {}) });
    const createPool = vi.fn((_configuration: PoolConfig) => { void _configuration; return first; })
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => { throw new Error("private synthetic-password connection details"); });
    expect(() => createAccountHttpRuntime(environment(), { createPool, readCertificate: () => cert, fetch: vi.fn() }))
      .toThrow(expect.objectContaining({ code: "integration_unavailable" }));
    await Promise.resolve();
    expect(first.end).toHaveBeenCalledTimes(1); expect(first.connect).not.toHaveBeenCalled();
  });
});

describe("request-only verified account Home Storage", () => {
  const path = `${LOGO_SUPABASE_ORIGIN}/storage/v1/object/fluid-assets/${OWNER_A}/home/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222`;
  it("revalidates the selected token and preserves the bounded create-only request", async () => {
    const account = auth(), fetcher = vi.fn<typeof fetch>(async () => new Response("ok"));
    const transport = await createAccountHomeStorageTransport(account, { publishableKey: "sb_publishable_fixture", fetch: fetcher });
    await transport(path, { method: "POST", headers: { "x-upsert": "false" }, body: new Uint8Array([1]) });
    expect(account.client.auth.getUser).toHaveBeenCalledWith(`synthetic-${OWNER_A}`);
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe(path); expect(request).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", credentials: "omit", signal: expect.any(AbortSignal) });
    expect(new Headers(request!.headers).get("authorization")).toBe(`Bearer synthetic-${OWNER_A}`);
  });
  it.each(["token-owner", "expired", "unconfirmed"])("rejects %s sessions before private byte requests", async mode => {
    const account = auth(), fetcher = vi.fn<typeof fetch>();
    const getUser = vi.mocked(account.client.auth.getUser);
    if (mode === "token-owner") getUser.mockResolvedValue({ data: { user: { id: OWNER_B } }, error: null } as never);
    if (mode === "expired") getUser.mockResolvedValue({ data: { user: null }, error: new Error("expired token") } as never);
    if (mode === "unconfirmed") getUser.mockResolvedValue({ data: { user: { id: OWNER_A, is_anonymous: false, email_confirmed_at: null } }, error: null } as never);
    await expect(createAccountHomeStorageTransport(account, { publishableKey: "sb_publishable_fixture", fetch: fetcher })).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["foreign-path", "alternate-host", "redirect-shape", "upsert", "authorization", "delete"])("rejects scope/transport widening: %s", async mode => {
    const fetcher = vi.fn<typeof fetch>(), transport = await createAccountHomeStorageTransport(auth(), { publishableKey: "sb_publishable_fixture", fetch: fetcher });
    const url = mode === "foreign-path" ? path.replace(OWNER_A, OWNER_B) : mode === "alternate-host" ? path.replace(LOGO_SUPABASE_ORIGIN, "https://other.invalid") : mode === "redirect-shape" ? path + "?redirect=other" : path;
    const request: RequestInit = mode === "upsert" ? { method: "POST", headers: { "x-upsert": "true" } }
      : mode === "authorization" ? { method: "GET", headers: { authorization: "Bearer borrowed" } }
      : { method: mode === "delete" ? "DELETE" : "GET" };
    await expect(transport(url, request)).rejects.toMatchObject({ code: "integration_unavailable" }); expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not follow redirects or retry a failed private request", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error("credential-bearing driver failure"); });
    const transport = await createAccountHomeStorageTransport(auth(), { publishableKey: "sb_publishable_fixture", fetch: fetcher });
    await expect(transport(path, { method: "GET" })).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("production registry composition over two actual restricted SQL principals (PGlite fixture)", () => {
  let db: Awaited<ReturnType<typeof createIdentityTrustedDatabase>>;
  let registry: ReturnType<typeof bindings>;
  const connections: string[] = [], sqlCalls: { role: string; text: string }[] = [], releases: boolean[] = [];
  const objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  const pools: (ReturnType<typeof poolFor>)[] = [];
  function poolFor(configuration: PoolConfig) {
    const role = configuration.user!;
    const client = Object.assign(new EventEmitter(), {
      async query(input: Parameters<IdentityPoolClientPort["query"]>[0]) {
        sqlCalls.push({ role, text: input.text });
        return await db.query(input.text, input.values);
      },
      release: (discard?: boolean) => { releases.push(!!discard); }, end: async () => {},
    });
    return Object.assign(new EventEmitter(), { configuration, connect: vi.fn(async () => {
      connections.push(role); await db.exec("set session authorization postgres"); await db.exec(`set session authorization ${role}`); return client;
    }), end: vi.fn(async () => {}) });
  }
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input), key = url.split("/storage/v1/object/")[1]!;
    const pathOwner = key.split("/")[1];
    if (new Headers(init?.headers).get("authorization") !== `Bearer synthetic-${pathOwner}`) return new Response("denied", { status: 403 });
    if (init?.method === "POST") {
      if (objects.has(key)) return Response.json({ code: "ResourceAlreadyExists" }, { status: 409 });
      objects.set(key, { bytes: Uint8Array.from(init.body as Uint8Array), mimeType: new Headers(init.headers).get("content-type")! });
      return Response.json({ Id: randomUUID(), Key: key });
    }
    const object = objects.get(key);
    return object ? new Response(Uint8Array.from(object.bytes), { headers: { "content-type": object.mimeType } }) : new Response("missing", { status: 404 });
  });
  const dependencies = { readCertificate: () => cert, fetch: fetcher, createPool: (config: PoolConfig) => { const pool = poolFor(config); pools.push(pool); return pool; } };
  beforeAll(async () => {
    db = await createIdentityTrustedDatabase();
    await db.exec(`alter role fixture_identity_replacement_a rename to embel_identity_web_a;
      alter role fixture_identity_replacement_b rename to embel_identity_web_b;
      create role embel_home_web_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      create role embel_home_web_b login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      grant usage on schema public,fluid_private to embel_home_web_a,embel_home_web_b;
      grant execute on function fluid_private.home_attachment_owner(),fluid_private.prepare_home_attachment(jsonb,bigint),
       fluid_private.observe_home_attachment(uuid,jsonb),fluid_private.lookup_home_attachment(uuid),fluid_private.resolve_home_attachments(uuid[]) to embel_home_web_a,embel_home_web_b;`);
    registry = bindings();
    for (const entry of registry) for (const lane of ["identity", "attachments"] as const) {
      entry[lane].roleOid = (await db.query<{ oid: number }>("select oid from pg_roles where rolname=$1", [entry[lane].roleName])).rows[0]!.oid;
    }
  }, 60_000);
  afterAll(async () => { await db?.exec("set session authorization postgres"); await db?.close(); });
  beforeEach(async () => {
    resetRuntime(); connections.length = 0; sqlCalls.length = 0; releases.length = 0; pools.length = 0; objects.clear(); fetcher.mockClear();
    await db.exec("set session authorization postgres"); await resetFixture(db);
    // The fixture's default binding names were renamed to the production-only
    // namespace. Install only these synthetic administrative owner mappings.
    await db.exec("truncate fluid_private.identity_web_principals,fluid_private.home_attachment_principals");
    for (const entry of registry) {
      await db.query("insert into fluid_private.identity_web_principals(login_role_oid,login_role_name,owner_id) values($1,$2,$3)", [entry.identity.roleOid, entry.identity.roleName, entry.ownerId]);
      await db.query("insert into fluid_private.home_attachment_principals(role_oid,role_name,owner_id) values($1,$2,$3)", [entry.attachments.roleOid, entry.attachments.roleName, entry.ownerId]);
    }
  });
  it("constructs lazy separate owner/capability pools with verified TLS and no credential fallback", async () => {
    const runtime = createAccountHttpRuntime({ ...environment(registry), PGHOST: "other.invalid", PGPASSWORD: "ignored", PGOPTIONS: "-c role=postgres" }, dependencies)!;
    expect(pools).toHaveLength(4); expect(connections).toEqual([]);
    for (const pool of pools) {
      expect(pool.configuration).toMatchObject({ host: "db.fricsfwqibyhemknqgyf.supabase.co", port: 5432, database: "postgres",
        ssl: { ca: cert, rejectUnauthorized: true, minVersion: "TLSv1.2" }, options: expect.stringContaining("row_security=on"), max: 2 });
      expect((pool.configuration.password as () => string)()).toBe("synthetic-password");
    }
    const foreign = auth(outsider);
    expect(await runtime.resolveHome(foreign)).toBeNull(); expect(await runtime.resolveIdentity(outsider)).toBeNull();
    expect(connections).toEqual([]); expect(foreign.client.auth.getSession).not.toHaveBeenCalled();
  });
  it("qualifies both Identity owners, saves exact selections, and refuses cross-owner source use", async () => {
    const projectA = (await seedProject(db, OWNER_A)).id, rootA = await seedIdentityRoot(db, projectA);
    const projectB = (await seedProject(db, OWNER_B)).id, rootB = await seedIdentityRoot(db, projectB, { ownerId: OWNER_B });
    const request = (root: typeof rootA) => ({ systemVersionId: root.system.id, expectedProjectRevision: root.input.projectRevision,
      expectedReferenceRevision: root.input.referenceSnapshot.referenceRevision, expectedPreferencesRevision: 0, expectedIdentityRevision: 0, acceptEarlierBasis: false });
    const runtime = createAccountHttpRuntime(environment(registry), dependencies)!;
    const a = (await runtime.resolveIdentity(OWNER_A))!, b = (await runtime.resolveIdentity(OWNER_B))!;
    expect(a.saveAvailability.status).toBe("available"); expect(b.saveAvailability.status).toBe("available");
    const savedA = await a.transactions.select({ userId: OWNER_A }, projectA, request(rootA));
    const savedB = await b.transactions.select({ userId: OWNER_B }, projectB, request(rootB));
    expect(savedA.currentSelection.system.ownerId).toBe(OWNER_A); expect(savedB.currentSelection.system.ownerId).toBe(OWNER_B);
    await expect(b.transactions.select({ userId: OWNER_B }, projectA, request(rootA))).rejects.toMatchObject({ code: "not_found" });
    expect(db.isInTransaction()).toBe(false);
  });
  it("routes Home capability/upload/replay for both owners using their own real SQL helpers and JWT byte transports", async () => {
    expect(startAccountHttpServices(environment(registry), dependencies)).toBe("installed");
    expect(connections).toEqual([]); // installed is not an env-only readiness claim
    const a = auth(OWNER_A), b = auth(OWNER_B);
    expect((await getHomeAttachmentCapability(a))!.allowedMimeTypes).not.toContain("application/pdf");
    expect((await getHomeAttachmentCapability(b))!.allowedMimeTypes).toContain("text/plain");
    const bytes = new TextEncoder().encode("Synthetic private brief"), requestKey = randomUUID();
    const input = { requestKey, name: "brief.txt", mimeType: "text/plain" as const, contentHash: createHash("sha256").update(bytes).digest("hex") };
    const first = await stageHomeAttachment(a, input, bytes), second = await stageHomeAttachment(b, input, bytes);
    expect(first.ownerId).toBe(OWNER_A); expect(second.ownerId).toBe(OWNER_B); expect(second.id).not.toBe(first.id);
    expect(await stageHomeAttachment(a, input, bytes)).toEqual(first);
    expect(objects.size).toBe(2);
    expect(sqlCalls.some(query => query.role === "embel_home_web_a" && query.text.includes("observe_home_attachment"))).toBe(true);
    expect(sqlCalls.some(query => query.role === "embel_home_web_b" && query.text.includes("observe_home_attachment"))).toBe(true);
    expect(db.isInTransaction()).toBe(false);
  });
  it("does not advertise Home capability when the token, actual owner binding or helper contract is wrong", async () => {
    const runtime = createAccountHttpRuntime(environment(registry), dependencies)!;
    expect(await runtime.resolveHome(auth(OWNER_A, OWNER_B))).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
    await db.exec("set session authorization postgres");
    await db.query("update fluid_private.home_attachment_principals set owner_id=$1 where role_name='embel_home_web_a'", [OWNER_B]);
    expect(await runtime.resolveHome(auth(OWNER_A))).toBeNull(); expect(db.isInTransaction()).toBe(false);
    await db.exec("set session authorization postgres");
    await db.exec("revoke execute on function fluid_private.observe_home_attachment(uuid,jsonb) from embel_home_web_a");
    expect(await runtime.resolveHome(auth(OWNER_A))).toBeNull(); expect(db.isInTransaction()).toBe(false);
    await db.exec("set session authorization postgres");
    await db.exec("grant execute on function fluid_private.observe_home_attachment(uuid,jsonb) to embel_home_web_a");
  });
  it("qualifies Identity on every request and never borrows another owner's mapping", async () => {
    expect(startAccountHttpServices(environment(registry), dependencies)).toBe("installed");
    expect(await resolveAccountIdentityRuntime(OWNER_A)).not.toBeNull();
    await db.exec("set session authorization postgres");
    await db.query("delete from fluid_private.identity_web_principals where owner_id=$1", [OWNER_B]);
    await db.query("update fluid_private.identity_web_principals set owner_id=$1 where login_role_name='embel_identity_web_a'", [OWNER_B]);
    expect(await resolveAccountIdentityRuntime(OWNER_A)).toBeNull(); expect(db.isInTransaction()).toBe(false);
    expect(releases.length).toBeGreaterThanOrEqual(2);
  });
  it("does no checkout or token retrieval for an already canceled request", async () => {
    const runtime = createAccountHttpRuntime(environment(registry), dependencies)!, account = auth();
    expect(await runtime.resolveHome(account, AbortSignal.abort())).toBeNull();
    expect(await runtime.resolveIdentity(OWNER_A, AbortSignal.abort())).toBeNull();
    expect(connections).toEqual([]); expect(account.client.auth.getSession).not.toHaveBeenCalled();
  });
});
