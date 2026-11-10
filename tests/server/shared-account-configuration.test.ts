import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  qualifySharedSupabaseOrigin,
  readSharedAccountHttpConfiguration,
} from "../../src/server/shared-account/configuration";
const roleName = "embel_shared_http_identity_test";
const binding = {
  roleName,
  roleOid: 12345,
  databaseUrl: `postgresql://${roleName}:inert-fixture@db.fricsfwqibyhemknqgyf.supabase.co:5432/postgres?sslmode=verify-full`,
};
const env = () => ({
  NODE_ENV: "production",
  EMBEL_SHARED_ACCOUNT_HTTP_ENABLED: "true",
  NEXT_PUBLIC_SUPABASE_URL: "https://fricsfwqibyhemknqgyf.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_inertfixture",
  EMBEL_SHARED_ACCOUNT_HTTP_CONFIG: JSON.stringify({ identity: binding }),
});
describe("finite shared HTTP service credentials and explicit target boundaries", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("is disabled without the explicit flag and never discovers ambient credentials", () => {
    expect(
      readSharedAccountHttpConfiguration({
        ...env(),
        EMBEL_SHARED_ACCOUNT_HTTP_ENABLED: "false",
        PGPASSWORD: "inert-ambient",
      }),
    ).toBeNull();
    expect(() => readSharedAccountHttpConfiguration({ ...env(), EMBEL_SHARED_ACCOUNT_HTTP_CONFIG: "" })).toThrowError(
      expect.objectContaining({ code: "integration_unavailable" }),
    );
  });
  it("accepts a finite fixed principal and does not serialize its password", () => {
    const result = readSharedAccountHttpConfiguration(env())!;
    expect(result.identity).toMatchObject({ roleName, roleOid: 12345, tls: true, port: 5432 });
    expect(result.identity!.password).toBe("inert-fixture");
    expect(JSON.stringify(result)).not.toContain("inert-fixture");
    expect(result).not.toHaveProperty("owners");
  });
  it.each([
    { ...binding, roleName: "postgres" },
    { ...binding, roleName: "embel_shared_http_home_other" },
    { ...binding, databaseUrl: binding.databaseUrl.replace("verify-full", "disable") },
    { ...binding, databaseUrl: binding.databaseUrl.replace("fricsfwqibyhemknqgyf", "aaaaaaaaaaaaaaaaaaaa") },
    { ...binding, databaseUrl: binding.databaseUrl.replace("5432", "6543") },
    { ...binding, databaseUrl: `${binding.databaseUrl}&options=-c%20role%3Dauthenticated` },
  ])("rejects broad, cross-lane or inconsistent connection authority %#", (value) => {
    expect(() =>
      readSharedAccountHttpConfiguration({
        ...env(),
        EMBEL_SHARED_ACCOUNT_HTTP_CONFIG: JSON.stringify({ identity: value }),
      }),
    ).toThrowError(expect.objectContaining({ code: "integration_unavailable" }));
  });
  it("supports an isolated hosted project only when the selected public target and PG project match", () => {
    const target = "abcdefghijklmnopqrst";
    const scoped = {
      ...env(),
      NEXT_PUBLIC_SUPABASE_URL: `https://${target}.supabase.co`,
      EMBEL_SHARED_ACCOUNT_HTTP_CONFIG: JSON.stringify({
        identity: { ...binding, databaseUrl: binding.databaseUrl.replace("fricsfwqibyhemknqgyf", target) },
      }),
    };
    expect(readSharedAccountHttpConfiguration(scoped)!.origin).toBe(`https://${target}.supabase.co`);
    expect(() => qualifySharedSupabaseOrigin("https://fricsfwqibyhemknqgyf.supabase.co", scoped)).toThrowError(
      expect.objectContaining({ code: "integration_unavailable" }),
    );
  });
  it("supports only the explicit existing loopback development stack with no Vercel metadata", () => {
    const local = {
      ...env(),
      NODE_ENV: "development",
      EMBEL_DEVELOPMENT_ENABLED: "true",
      APP_ORIGIN: "http://127.0.0.1:3105",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      EMBEL_SHARED_ACCOUNT_HTTP_CONFIG: JSON.stringify({
        identity: {
          ...binding,
          databaseUrl: `postgresql://${roleName}:inert-local@127.0.0.1:54322/postgres?sslmode=disable`,
        },
      }),
    };
    expect(readSharedAccountHttpConfiguration(local)!.identity).toMatchObject({
      host: "127.0.0.1",
      port: 54322,
      tls: false,
    });
    for (const override of [
      { VERCEL: "1" },
      { NODE_ENV: "production" },
      { EMBEL_DEVELOPMENT_ENABLED: "false" },
      { NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321" },
      { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:3105" },
    ]) {
      expect(() => readSharedAccountHttpConfiguration({ ...local, ...override })).toThrowError(
        expect.objectContaining({ code: "integration_unavailable" }),
      );
    }
  });
  it("pins each restricted HTTP principal to the selected isolated development database", () => {
    const homeRole = "embel_shared_http_home_test";
    const local = {
      ...env(),
      NODE_ENV: "development",
      EMBEL_DEVELOPMENT_ENABLED: "true",
      APP_ORIGIN: "http://127.0.0.1:3155",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55421",
      EMBEL_DEVELOPMENT_DATABASE_PORT: "55422",
      EMBEL_SHARED_ACCOUNT_HTTP_CONFIG: JSON.stringify({
        identity: {
          ...binding,
          databaseUrl: `postgresql://${roleName}:inert-local@127.0.0.1:55422/postgres?sslmode=disable`,
        },
        homeVerifier: {
          roleName: homeRole,
          roleOid: 12346,
          databaseUrl: `postgresql://${homeRole}:inert-home@127.0.0.1:55422/postgres?sslmode=disable`,
        },
      }),
    };
    const result = readSharedAccountHttpConfiguration(local)!;
    expect(result.origin).toBe(local.NEXT_PUBLIC_SUPABASE_URL);
    expect(result.identity).toMatchObject({ host: "127.0.0.1", port: 55422, tls: false, user: roleName });
    expect(result.homeVerifier).toMatchObject({ port: 55422, user: homeRole });
    expect(JSON.stringify(result)).not.toMatch(/inert-(?:local|home)/u);
    for (const port of [undefined, "54322", "55421", "3155", "0", "1023", "65536", "055422", "55422 ", "55422.0"]) {
      expect(() =>
        readSharedAccountHttpConfiguration({ ...local, EMBEL_DEVELOPMENT_DATABASE_PORT: port }),
      ).toThrowError(expect.objectContaining({ code: "integration_unavailable" }));
    }
    for (const override of [
      { VERCEL_ENV: "development" },
      { NODE_ENV: "production" },
      { EMBEL_DEVELOPMENT_ENABLED: "false" },
      { NEXT_PUBLIC_SUPABASE_URL: "http://192.168.1.2:55421" },
    ]) {
      expect(() => readSharedAccountHttpConfiguration({ ...local, ...override })).toThrowError(
        expect.objectContaining({ code: "integration_unavailable" }),
      );
    }
    expect(() => qualifySharedSupabaseOrigin("http://127.0.0.1:54321", local)).toThrowError(
      expect.objectContaining({ code: "integration_unavailable" }),
    );
  });
  it("development settings cannot relax a hosted database target", () => {
    const configured = {
      ...env(),
      EMBEL_DEVELOPMENT_ENABLED: "true",
      EMBEL_DEVELOPMENT_DATABASE_PORT: "55422",
      APP_ORIGIN: "http://127.0.0.1:3155",
    };
    expect(readSharedAccountHttpConfiguration(configured)!.identity).toMatchObject({ port: 5432, tls: true });
    expect(() =>
      readSharedAccountHttpConfiguration({
        ...configured,
        EMBEL_SHARED_ACCOUNT_HTTP_CONFIG: JSON.stringify({
          identity: {
            ...binding,
            databaseUrl: `postgresql://${roleName}:inert-local@127.0.0.1:55422/postgres?sslmode=disable`,
          },
        }),
      }),
    ).toThrowError(expect.objectContaining({ code: "integration_unavailable" }));
  });
});
