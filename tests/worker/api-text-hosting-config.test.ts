import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readWorkerIdentity, workerPoolOptions } from "../../worker/hosting/config";
describe("isolated worker production configuration", () => {
  const env = { VERCEL_ENV: "production", VERCEL_PROJECT_ID: "prj_waP1hoGVtBiqJCTqTWKHfRy8iLMk", VERCEL_DEPLOYMENT_ID: "dpl_qualified" };
  it("requires the actual approved worker Production project and immutable deployment ID", () => {
    expect(readWorkerIdentity(env)).toEqual({ deploymentId: "dpl_qualified" });
    for (const change of [{ VERCEL_ENV: "preview" }, { VERCEL_TARGET_ENV: "custom" }, { VERCEL_PROJECT_ID: "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt" }, { VERCEL_DEPLOYMENT_ID: "" }]) expect(() => readWorkerIdentity({ ...env, ...change })).toThrow();
  });
  it("allows only the restricted API text principal at the approved database with verified TLS and short query limits", () => {
    const configuration = workerPoolOptions("postgresql://fluid_api_text_worker:fixture@db.fricsfwqibyhemknqgyf.supabase.co:5432/postgres?sslmode=require");
    expect(configuration).toMatchObject({ ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 3_000, statement_timeout: 3_000, query_timeout: 3_000, max: 3 });
    expect(configuration).toMatchObject({ host: "db.fricsfwqibyhemknqgyf.supabase.co", port: 5432, database: "postgres", user: "fluid_api_text_worker", password: "fixture" });
    expect(configuration).not.toHaveProperty("connectionString");
    for (const url of [undefined, "postgresql://postgres:fixture@db.fricsfwqibyhemknqgyf.supabase.co/postgres", "postgresql://fluid_api_text_worker:fixture@evil.example/postgres", "postgresql://fluid_logo_worker:fixture@db.fricsfwqibyhemknqgyf.supabase.co/postgres"]) expect(() => workerPoolOptions(url)).toThrow();
  });
  it("supports the approved Supabase pooler username without admitting another project", () => {
    expect(workerPoolOptions("postgresql://fluid_api_text_worker.fricsfwqibyhemknqgyf:fixture@aws-0-us-east-1.pooler.supabase.com:6543/postgres")).toMatchObject({ ssl: { rejectUnauthorized: true } });
    expect(() => workerPoolOptions("postgresql://fluid_api_text_worker.otherproject:fixture@aws-0-us-east-1.pooler.supabase.com:6543/postgres")).toThrow();
  });
  it("embeds the reviewed public Supabase CA while retaining hostname verification", () => {
    const config = workerPoolOptions("postgresql://fluid_api_text_worker.fricsfwqibyhemknqgyf:fixture@aws-0-us-east-1.pooler.supabase.com:5432/postgres");
    expect(config.ssl).toHaveProperty("ca");
    if (typeof config.ssl !== "object") throw new Error("Expected TLS configuration");
    expect(createHash("sha256").update(config.ssl.ca as string).digest("hex")).toBe("700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7");
    expect(config.ssl.rejectUnauthorized).toBe(true);
    expect(config.ssl).not.toHaveProperty("checkServerIdentity");
  });
  it("accepts a literal password at the fixed approved session pooler without constructing a URL", () => {
    const password = " synthetic:p@ss/#?%&=+\\\"'\u00e9 ";
    const config = workerPoolOptions(undefined, password);
    expect(config).toMatchObject({ host: "aws-0-us-east-1.pooler.supabase.com", port: 5432, database: "postgres",
      user: "fluid_api_text_worker.fricsfwqibyhemknqgyf", password });
    expect(config).not.toHaveProperty("connectionString");
  });
  it("preserves the same pinned TLS and all connection bounds for password-only setup", () => {
    const config = workerPoolOptions(undefined, "synthetic-password");
    expect(config).toMatchObject({ ssl: { rejectUnauthorized: true }, max: 3,
      connectionTimeoutMillis: 3_000, statement_timeout: 3_000, query_timeout: 3_000,
      idleTimeoutMillis: 10_000, allowExitOnIdle: true, application_name: "fluid-api-text-worker" });
    if (typeof config.ssl !== "object") throw new Error("Expected TLS configuration");
    expect(createHash("sha256").update(config.ssl.ca as string).digest("hex")).toBe("700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7");
    expect(config.ssl).not.toHaveProperty("checkServerIdentity");
  });
  it.each([undefined, ""])("rejects an absent or empty password without a URL (%#)", password => {
    expect(() => workerPoolOptions(undefined, password)).toThrow("Worker database unavailable");
  });
  it.each([
    ["postgresql://fluid_api_text_worker:synthetic-password@db.fricsfwqibyhemknqgyf.supabase.co/postgres", "synthetic-password"],
    ["not-a-url-with-synthetic-password", "synthetic-password"],
    ["", "synthetic-password"],
    ["postgresql://fluid_api_text_worker:synthetic-password@db.fricsfwqibyhemknqgyf.supabase.co/postgres", ""],
  ])("rejects simultaneous configured inputs without disclosing either (%#)", (url, password) => {
    expect(() => workerPoolOptions(url, password)).toThrow(/^Ambiguous worker database configuration$/);
  });
  it("decodes a legacy URL password once and retains its supplied endpoint", () => {
    const password = "synthetic:p@ss/#?%";
    const config = workerPoolOptions(`postgresql://fluid_api_text_worker.fricsfwqibyhemknqgyf:${encodeURIComponent(password)}@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=disable`);
    expect(config).toMatchObject({ host: "aws-0-us-east-1.pooler.supabase.com", port: 6543, database: "postgres",
      user: "fluid_api_text_worker.fricsfwqibyhemknqgyf", password, ssl: { rejectUnauthorized: true } });
    expect(config).not.toHaveProperty("connectionString");
  });
  it.each([
    "synthetic-secret-not-a-url",
    "postgresql://fluid_api_text_worker:synthetic%secret@db.fricsfwqibyhemknqgyf.supabase.co/postgres",
  ])("does not expose malformed legacy input in parser errors (%#)", value => {
    let failure: unknown;
    try { workerPoolOptions(value); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Unapproved worker database");
    expect(failure).not.toHaveProperty("input");
    expect(failure).not.toHaveProperty("cause");
  });
});
