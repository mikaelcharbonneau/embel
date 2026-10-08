import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const external = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/server/auth/client", () => ({ createRouteAuthClient: external.createClient }));
import type { PoolConfig } from "pg";
import { readLogoWebConfiguration } from "@/server/runtime/logo-web-configuration";
import { startLogoWebServices } from "@/server/runtime/logo-web-bootstrap";
import { resolveLogoRequestServices } from "@/server/runtime/logo-request-services";
import { logoHttpFixture } from "../../fixtures/logo-http-runtime";
import { POST } from "@/app/api/projects/[projectId]/logo/references/uploads/route";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role = "fluid_logo_web_fixture";
const cert = readFileSync(new URL("../../../scripts/certs/supabase-prod-ca-2021.crt", import.meta.url), "utf8");
const env = () => ({ FLUID_LOGO_WEB_DATABASE_URL: `postgresql://${role}:synthetic-password@db.fricsfwqibyhemknqgyf.supabase.co:5432/postgres?sslmode=verify-full`,
  FLUID_LOGO_WEB_OWNER_ID: owner, FLUID_LOGO_WEB_ROLE_NAME: role, FLUID_LOGO_WEB_ROLE_OID: "987",
  NEXT_PUBLIC_SUPABASE_URL: "https://fricsfwqibyhemknqgyf.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic" });
function ports() {
  const pool = Object.assign(new EventEmitter(), { connect: vi.fn(async (): Promise<never> => { throw new Error("No startup connection allowed"); }), end: vi.fn(async () => {}) });
  const createPool = vi.fn((_configuration: PoolConfig) => { void _configuration; return pool; });
  return { pool, dependencies: { createPool, readCertificate: vi.fn(() => cert), fetch: vi.fn<typeof fetch>(), diagnostic: vi.fn() } };
}
function resetInstallation() {
  for (const key of ["fluid.logo.request-services.v1", "fluid.logo.web-bootstrap.v1"]) Reflect.deleteProperty(globalThis, Symbol.for(key));
}
beforeEach(() => { resetInstallation(); vi.clearAllMocks(); vi.stubEnv("APP_ORIGIN", "https://fluid.invalid"); });
afterEach(() => { resetInstallation(); vi.unstubAllEnvs(); });

describe("dedicated owner-HTTP configuration and startup", () => {
  it("leaves all-absent configuration disabled without reading a certificate or opening a connection", () => {
    const f = ports(); expect(readLogoWebConfiguration({})).toBeNull(); expect(startLogoWebServices({}, f.dependencies)).toBe("disabled");
    expect(f.dependencies.createPool).not.toHaveBeenCalled(); expect(f.dependencies.readCertificate).not.toHaveBeenCalled(); expect(f.dependencies.diagnostic).not.toHaveBeenCalled();
    expect(startLogoWebServices(env(), f.dependencies)).toBe("disabled"); expect(f.dependencies.createPool).not.toHaveBeenCalled();
  });
  it.each([
    { FLUID_LOGO_WEB_DATABASE_URL: undefined }, { FLUID_LOGO_WEB_ROLE_OID: "0" }, { FLUID_LOGO_WEB_ROLE_OID: "4294967296" },
    { FLUID_LOGO_WEB_OWNER_ID: "invalid" }, { FLUID_LOGO_WEB_ROLE_NAME: "fluid_local_worker" }, { FLUID_LOGO_WEB_ROLE_NAME: "service_role" },
    { FLUID_LOGO_WEB_DATABASE_URL: env().FLUID_LOGO_WEB_DATABASE_URL.replace(":5432", ":6543") },
    { FLUID_LOGO_WEB_DATABASE_URL: env().FLUID_LOGO_WEB_DATABASE_URL.replace("verify-full", "require") },
    { FLUID_LOGO_WEB_DATABASE_URL: env().FLUID_LOGO_WEB_DATABASE_URL + "&options=unsafe" },
    { FLUID_LOGO_WEB_DATABASE_URL: env().FLUID_LOGO_WEB_DATABASE_URL.replace("db.fricsfwqibyhemknqgyf.supabase.co", "unapproved.invalid") },
    { NEXT_PUBLIC_SUPABASE_URL: "https://other.supabase.co" }, { NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_unapproved" },
  ])("rejects malformed or broader configuration without disclosing supplied values %#", overrides => {
    const f = ports(), input = { ...env(), ...overrides };
    expect(() => readLogoWebConfiguration(input)).toThrow(expect.objectContaining({ code: "integration_unavailable" }));
    expect(startLogoWebServices(input, f.dependencies)).toBe("unavailable"); expect(f.dependencies.createPool).not.toHaveBeenCalled();
    expect(f.dependencies.diagnostic.mock.calls).toEqual([["Logo HTTP services unavailable: invalid configuration or dependency setup."]]);
    expect(JSON.stringify(f.dependencies.diagnostic.mock.calls)).not.toContain("synthetic-password");
  });
  it("accepts the exact session-pooler username only for the configured web role", () => {
    const pooler = { ...env(), FLUID_LOGO_WEB_DATABASE_URL: `postgresql://${role}.fricsfwqibyhemknqgyf:synthetic-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full` };
    expect(readLogoWebConfiguration(pooler)?.database.user).toBe(`${role}.fricsfwqibyhemknqgyf`);
    expect(() => readLogoWebConfiguration({ ...pooler, FLUID_LOGO_WEB_ROLE_NAME: "fluid_logo_web_other" })).toThrow();
    expect(JSON.stringify(readLogoWebConfiguration(pooler))).not.toContain("synthetic-password");
  });
  it("installs one lazy restricted pool with explicit verified TLS and no worker/PG fallback", async () => {
    const f = ports(); expect(startLogoWebServices({ ...env(), FLUID_WORKER_DATABASE_URL: "ignored", PGPASSWORD: "ignored", PGHOST: "ignored" }, f.dependencies)).toBe("installed");
    const config = f.dependencies.createPool.mock.calls[0]![0];
    expect(config).toMatchObject({ host: "db.fricsfwqibyhemknqgyf.supabase.co", user: role, database: "postgres", port: 5432,
      ssl: { rejectUnauthorized: true, servername: "db.fricsfwqibyhemknqgyf.supabase.co", minVersion: "TLSv1.2", ca: cert }, max: 3, connectionTimeoutMillis: 10_000, query_timeout: 15_000 });
    expect(typeof config.password).toBe("function"); expect(config).not.toHaveProperty("connectionString"); expect(f.pool.connect).not.toHaveBeenCalled();
    expect(startLogoWebServices(env(), f.dependencies)).toBe("installed"); expect(f.dependencies.createPool).toHaveBeenCalledTimes(1);
    expect(() => f.pool.emit("error", new Error("raw synthetic-password"))).not.toThrow(); expect(JSON.stringify(f.dependencies.diagnostic.mock.calls)).not.toContain("synthetic-password");
  });
  it("leaves foreign accounts unavailable without retrieving their session or acquiring the configured pool", async () => {
    const f = ports(), foreign = logoHttpFixture(); startLogoWebServices(env(), f.dependencies);
    expect((await resolveLogoRequestServices(foreign.auth, foreign.projectId)).configured).toBe(false);
    expect(f.pool.connect).not.toHaveBeenCalled(); expect(f.dependencies.fetch).not.toHaveBeenCalled();
  });
  it("fails closed on a missing or changed public CA before constructing the pool", () => {
    const f = ports(); f.dependencies.readCertificate.mockReturnValue("unapproved public certificate");
    expect(startLogoWebServices(env(), f.dependencies)).toBe("unavailable"); expect(f.dependencies.createPool).not.toHaveBeenCalled();
  });
  it("connects the actual upload route through the startup resolver and request-only Auth/Storage ports", async () => {
    const fixture = logoHttpFixture(owner); fixture.controls.principal.role_name = role;
    Object.assign(fixture.client.auth, { getSession: vi.fn(async () => ({ data: { session: { access_token: "synthetic-owner-token" } }, error: null })) });
    external.createClient.mockResolvedValue(fixture.client);
    const pool = Object.assign(new EventEmitter(), { connect: fixture.connect, end: vi.fn(async () => {}) });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => fixture.transport(String(input), { ...init!, headers: Object.fromEntries(new Headers(init?.headers)) }));
    expect(startLogoWebServices(env(), { createPool: () => pool, readCertificate: () => cert, fetch: fetcher, diagnostic: vi.fn() })).toBe("installed");
    expect(fixture.connect).not.toHaveBeenCalled();
    const form = new FormData(); form.set("input", JSON.stringify(fixture.upload)); form.set("file", new File([Uint8Array.from(fixture.raster.bytes)], "synthetic.png", { type: "image/png" }));
    const request = new Request("https://fluid.invalid/api/logo", { method: "POST", headers: { origin: "https://fluid.invalid" }, body: form });
    const response = await POST(request, { params: Promise.resolve({ projectId: fixture.projectId }) });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ asset: { ownerId: owner, projectId: fixture.projectId } });
    expect(fixture.getUser).toHaveBeenCalledWith("synthetic-owner-token"); expect(fixture.storageCalls.map(call => call.method)).toEqual(["POST", "GET"]);
    expect(fixture.sqlCalls.some(call => call.sql.includes("commit_logo_input"))).toBe(true);
    for (const [, init] of fetcher.mock.calls) expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-owner-token");
  });
});
