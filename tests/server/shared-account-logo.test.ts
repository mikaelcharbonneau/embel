import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readSharedLogoHttpConfiguration } from "../../src/server/shared-account/logo-configuration";
import { issueSharedLogoRequest } from "../../src/server/shared-account/logo-request";
import { createLogoOwnerStorageTransport } from "../../src/server/runtime/logo-owner-storage";
import type { AuthenticatedContext } from "../../src/server/auth/context";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", origin = "https://fricsfwqibyhemknqgyf.supabase.co", role = "embel_shared_http_logo_test";
const principal = { roleName: role, roleOid: 12345, databaseUrl: `postgresql://${role}:inert-secret@db.fricsfwqibyhemknqgyf.supabase.co:5432/postgres?sslmode=verify-full` };
const env = () => ({ EMBEL_SHARED_WORKERS_ENABLED: "true", NODE_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: origin, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_inertfixture", EMBEL_SHARED_LOGO_HTTP_CONFIG: JSON.stringify(principal) });
describe("separate finite Logo verifier and purpose-bound customer delegation", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("does not borrow legacy/worker credentials and conceals configured password from serialization", () => {
    expect(readSharedLogoHttpConfiguration({ ...env(), EMBEL_SHARED_WORKERS_ENABLED: "false" })).toBeNull();
    expect(readSharedLogoHttpConfiguration({ ...env(), EMBEL_SHARED_LOGO_HTTP_CONFIG: undefined, FLUID_LOGO_WEB_DATABASE_URL: principal.databaseUrl })).toBeNull();
    const config = readSharedLogoHttpConfiguration(env())!;
    expect(config.principal.roleName).toBe(role); expect(config.principal.password).toBe("inert-secret"); expect(JSON.stringify(config)).not.toContain("inert-secret");
  });
  it.each([{ ...principal, roleName: "postgres" }, { ...principal, roleName: "embel_shared_http_identity_test" }, { ...principal, databaseUrl: principal.databaseUrl.replace("verify-full", "disable") }, { ...principal, databaseUrl: principal.databaseUrl.replace("5432", "6543") }])("rejects broad/cross-purpose or weakened target configuration %#", value => {
    expect(() => readSharedLogoHttpConfiguration({ ...env(), EMBEL_SHARED_LOGO_HTTP_CONFIG: JSON.stringify(value) })).toThrowError(expect.objectContaining({ code: "integration_unavailable" }));
  });
  it("allows only the existing explicitly gated loopback development target", () => {
    const local = { ...env(), NODE_ENV: "development", EMBEL_DEVELOPMENT_ENABLED: "true", APP_ORIGIN: "http://127.0.0.1:3105", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", EMBEL_SHARED_LOGO_HTTP_CONFIG: JSON.stringify({ ...principal, databaseUrl: `postgresql://${role}:inert-local@127.0.0.1:54322/postgres?sslmode=disable` }) };
    expect(readSharedLogoHttpConfiguration(local)!.principal).toMatchObject({ tls: false, port: 54322 });
    expect(() => readSharedLogoHttpConfiguration({ ...local, VERCEL: "1" })).toThrow();
    expect(() => readSharedLogoHttpConfiguration({ ...local, NODE_ENV: "production" })).toThrow();
  });
  it("uses the configured development ports without permitting another database or hosted fallback", () => {
    const local = { ...env(), NODE_ENV: "development", EMBEL_DEVELOPMENT_ENABLED: "true", APP_ORIGIN: "http://127.0.0.1:3155", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55421", EMBEL_DEVELOPMENT_DATABASE_PORT: "55422",
      EMBEL_SHARED_LOGO_HTTP_CONFIG: JSON.stringify({ ...principal, databaseUrl: `postgresql://${role}:inert-local@127.0.0.1:55422/postgres?sslmode=disable` }) };
    expect(readSharedLogoHttpConfiguration(local)).toMatchObject({ origin: local.NEXT_PUBLIC_SUPABASE_URL, principal: { tls: false, port: 55422, host: "127.0.0.1" } });
    for (const override of [{ EMBEL_DEVELOPMENT_DATABASE_PORT: undefined }, { EMBEL_DEVELOPMENT_DATABASE_PORT: "55421" }, { VERCEL_URL: "localhost" }, { NEXT_PUBLIC_SUPABASE_URL: "http://localhost:55421" }, { NEXT_PUBLIC_SUPABASE_URL: origin }, { EMBEL_SHARED_LOGO_HTTP_CONFIG: JSON.stringify(principal) }]) {
      expect(() => readSharedLogoHttpConfiguration({ ...local, ...override })).toThrowError(expect.objectContaining({ code: "integration_unavailable" }));
    }
  });
  it("issuer receives only owned public intent, and stale/foreign proof cannot reach verifier", async () => {
    const rpc = vi.fn((name: string, args: Record<string, unknown>) => { void name; void args; return Promise.resolve({ data: { version: 1, token: "a".repeat(64), ownerId: owner, expiresAt: new Date(Date.now() + 20_000).toISOString() }, error: null }); });
    const auth = { userId: owner, client: { rpc } } as unknown as AuthenticatedContext;
    const intent = { method: "acceptLogoVector", body: { requestKey: owner } };
    expect(await issueSharedLogoRequest(auth, "command_apply", project, intent)).toHaveLength(64);
    expect(rpc).toHaveBeenCalledWith("issue_shared_logo_request", { p_action: "command_apply", p_arguments: [project, intent] });
    expect(rpc.mock.calls[0]![1]).not.toHaveProperty("ownerId"); expect(rpc.mock.calls[0]![1]).not.toHaveProperty("evidence");
    rpc.mockResolvedValueOnce({ data: { version: 1, token: "a".repeat(64), ownerId: project, expiresAt: new Date(Date.now() + 20_000).toISOString() }, error: null });
    await expect(issueSharedLogoRequest(auth, "command_apply", project, intent)).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it("Logo Storage uses exact selected project and verified confirmed customer JWT", async () => {
    const staging = "https://abcdefghijklmnopqrst.supabase.co", key = "sb_publishable_inertfixture", user = { id: owner, is_anonymous: false, email_confirmed_at: "2026-10-01T00:00:00Z" };
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", staging); vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", key);
    const auth = { userId: owner, client: { auth: { getSession: async () => ({ data: { session: { access_token: "inert.customer.token" } }, error: null }), getUser: async () => ({ data: { user }, error: null }) } } } as unknown as AuthenticatedContext;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("brief"));
    const transport = await createLogoOwnerStorageTransport(auth, project, { publishableKey: key, fetch, sharedSupabaseOrigin: staging });
    const path = `${staging}/storage/v1/object/fluid-assets/${owner}/${project}/cccccccc-cccc-4ccc-8ccc-cccccccccccc/dddddddd-dddd-4ddd-8ddd-dddddddddddd`;
    await transport(path, { method: "GET" }); expect(new Headers(fetch.mock.calls[0]![1]!.headers).get("authorization")).toBe("Bearer inert.customer.token");
    await expect(transport(path.replace(project, owner), { method: "GET" })).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
