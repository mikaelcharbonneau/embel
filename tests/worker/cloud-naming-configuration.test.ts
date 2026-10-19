import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { CLOUD_NAMING_RUNTIME, readCloudNamingConfiguration, readCloudNamingMode } from "../../worker/cloud-naming-configuration";

const sourceRevision = "a".repeat(40);
const ca = readFileSync(new URL("../../scripts/certs/supabase-prod-ca-2021.crt", import.meta.url), "utf8");
function environment(): Record<string, string | undefined> {
  return { NODE_ENV: "production", FLUID_RUNTIME: "cloud", FLUID_LOCAL_PROTOTYPE: "false", RENDER: "true", IS_PULL_REQUEST: "false",
    RENDER_SERVICE_TYPE: "worker", RENDER_SERVICE_NAME: "embel-naming-worker-production", RENDER_GIT_REPO_SLUG: "mikaelcharbonneau/embel",
    RENDER_GIT_BRANCH: "main", RENDER_GIT_COMMIT: sourceRevision, RENDER_SERVICE_ID: "srv-syntheticfixture01", RENDER_INSTANCE_ID: "synthetic-instance-1",
    EMBEL_NAMING_CLOUD_ACTIVATED: "true", FLUID_NAMING_BRAIN_ENABLED: "true", FLUID_PAID_CALLS_APPROVED: "true",
    OPENAI_API_KEY: "synthetic-cloud-provider-key", FLUID_NAMING_BRAIN_DATABASE_URL: "postgresql://fluid_naming_brain_worker.fricsfwqibyhemknqgyf:synthetic-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
    FLUID_NAMING_BRAIN_DATABASE_CA_PEM: ca, FLUID_NAMING_BRAIN_DEPLOYMENT_ID: "embel-naming-local-b2ff6ce8bbc2-20261017",
    FLUID_NAMING_BRAIN_MODEL: "gpt-6-luna", FLUID_OPENAI_VERIFIED_MODELS: "gpt-6-luna" };
}
function configuration(env = environment(), mode: "run" | "preflight" = "run") {
  return readCloudNamingConfiguration({ mode, sourceRevision, env, versions: CLOUD_NAMING_RUNTIME });
}

describe("cloud Naming production boundary", () => {
  it("uses the existing Naming policy and a small verified TLS pool without connection-string overrides", () => {
    const result = configuration();
    expect(result.policy.model).toBe("gpt-6-luna"); expect(result.policy.protocol).toBe("openai_agents");
    expect(result.deploymentId).toBe("embel-naming-local-b2ff6ce8bbc2-20261017"); expect(result.paidDispatchEnabled).toBe(true);
    expect(result.poolOptions).toMatchObject({ host: "aws-0-us-east-1.pooler.supabase.com", port: 5432, database: "postgres",
      user: "fluid_naming_brain_worker.fricsfwqibyhemknqgyf", password: "synthetic-password", max: 2, options: "",
      ssl: { ca, rejectUnauthorized: true, servername: "aws-0-us-east-1.pooler.supabase.com", minVersion: "TLSv1.2" }, sslnegotiation: "postgres" });
    expect(result.poolOptions).not.toHaveProperty("connectionString");
    expect(result).not.toHaveProperty("localPrototype"); expect(result).not.toHaveProperty("executionAuthority");
  });
  it.each([
    ["NODE_ENV", "development"], ["FLUID_RUNTIME", "local"], ["FLUID_LOCAL_PROTOTYPE", "true"], ["FLUID_LOCAL_PROTOTYPE", undefined],
    ["RENDER", "false"], ["IS_PULL_REQUEST", "true"], ["IS_PULL_REQUEST", undefined], ["RENDER_SERVICE_TYPE", "web"],
    ["RENDER_SERVICE_NAME", "embel-naming-preview"], ["RENDER_GIT_REPO_SLUG", "another/embel"], ["RENDER_GIT_BRANCH", "feature"],
    ["RENDER_GIT_COMMIT", "b".repeat(40)], ["RENDER_SERVICE_ID", "unqualified"], ["RENDER_INSTANCE_ID", "bad instance"],
    ["NODE_TLS_REJECT_UNAUTHORIZED", "0"], ["VERCEL_ENV", "production"],
    ["PGOPTIONS", "-c role=postgres"], ["PGSSLMODE", "no-verify"], ["PGPASSWORD", "unrelated-private-password"],
  ])("rejects an unqualified %s value before returning any connection", (key, value) => {
    expect(() => configuration({ ...environment(), [key!]: value })).toThrow("cloud_naming_environment_unqualified");
  });
  it.each(["node", "icu", "unicode"] as const)("requires the qualified %s runtime version", key => {
    expect(() => readCloudNamingConfiguration({ mode: "preflight", sourceRevision, env: environment(), versions: { ...CLOUD_NAMING_RUNTIME, [key]: "unqualified" } })).toThrow("cloud_naming_environment_unqualified");
  });
  it("rejects a source launch without a build revision", () => {
    expect(() => readCloudNamingConfiguration({ mode: "preflight", sourceRevision: "", env: environment(), versions: CLOUD_NAMING_RUNTIME })).toThrow("cloud_naming_environment_unqualified");
  });
  it.each(["EMBEL_NAMING_CLOUD_ACTIVATED", "FLUID_NAMING_BRAIN_ENABLED", "FLUID_PAID_CALLS_APPROVED"])("never starts the worker when %s is not true", key => {
    for (const value of [undefined, "false", "TRUE"]) expect(() => configuration({ ...environment(), [key]: value })).toThrow("cloud_naming_activation_required");
  });
  it("permits explicit read-only preflight while every activation gate is false", () => {
    expect(configuration({ ...environment(), EMBEL_NAMING_CLOUD_ACTIVATED: "false", FLUID_NAMING_BRAIN_ENABLED: "false", FLUID_PAID_CALLS_APPROVED: "false" }, "preflight").paidDispatchEnabled).toBe(false);
  });
  it.each([
    ["OPENAI_API_KEY", "short"], ["OPENAI_API_KEY", "synthetic key with whitespace"], ["FLUID_NAMING_BRAIN_DEPLOYMENT_ID", "bad deployment"],
    ["FLUID_NAMING_BRAIN_DEPLOYMENT_ID", "syntactic-but-unapproved-deployment"],
    ["FLUID_NAMING_BRAIN_MODEL", "gpt-6.1-sol"], ["FLUID_OPENAI_VERIFIED_MODELS", "gpt-6-luna,gpt-6.1-sol"],
  ])("requires exact Naming configuration for %s even in preflight", (key, value) => {
    expect(() => configuration({ ...environment(), [key!]: value }, "preflight")).toThrow("cloud_naming_configuration_invalid");
  });
  it("supports only normal Naming execution or explicit preflight", () => {
    expect(readCloudNamingMode([])).toBe("run"); expect(readCloudNamingMode(["--preflight"])).toBe("preflight");
    for (const args of [["--naming-only"], ["--preflight", "extra"], ["--preflight", "--preflight"], ["--all"]]) expect(() => readCloudNamingMode(args)).toThrow("cloud_naming_arguments_invalid");
  });
});

describe("cloud Naming credential and trust configuration", () => {
  it("accepts the approved direct endpoint with its exact restricted username", () => {
    const env = environment(); env.FLUID_NAMING_BRAIN_DATABASE_URL = "postgresql://fluid_naming_brain_worker:synthetic-password@db.fricsfwqibyhemknqgyf.supabase.co/postgres?sslmode=verify-full";
    expect(configuration(env).poolOptions).toMatchObject({ host: "db.fricsfwqibyhemknqgyf.supabase.co", user: "fluid_naming_brain_worker", port: 5432 });
  });
  it("does not read a retained Mac sslrootcert path or forward it to pg", () => {
    const env = environment(); env.FLUID_NAMING_BRAIN_DATABASE_URL += "&sslrootcert=/does/not/exist/private-ca.pem";
    const options = configuration(env).poolOptions;
    expect(options).not.toHaveProperty("sslrootcert"); expect(options.ssl).toMatchObject({ ca, rejectUnauthorized: true });
  });
  it.each([
    ["fluid_naming_brain_worker.fricsfwqibyhemknqgyf", "postgres.fricsfwqibyhemknqgyf"],
    ["aws-0-us-east-1.pooler.supabase.com", "unapproved.example.invalid"], [":5432", ":6543"], ["/postgres?", "/another?"],
    ["sslmode=verify-full", "sslmode=disable"], ["sslmode=verify-full", "sslmode=verify-full&sslmode=require"],
    ["sslmode=verify-full", "sslmode=verify-full&ssl=false"], ["sslmode=verify-full", "sslmode=verify-full&sslcert=/tmp/client.crt"],
    ["sslmode=verify-full", "sslmode=verify-full&options=-c%20role%3Dpostgres"], ["synthetic-password", "%0Aprivate-value"],
    ["synthetic-password", "%ZZprivate-value"], ["synthetic-password", ""],
  ])("rejects an unapproved database URL change (%s)", (before, after) => {
    const env = environment(); env.FLUID_NAMING_BRAIN_DATABASE_URL = env.FLUID_NAMING_BRAIN_DATABASE_URL!.replace(before, after);
    expect(() => configuration(env)).toThrow("cloud_naming_database_configuration_invalid");
  });
  it.each([undefined, "untrusted-private-CA", `${ca}\n`])("requires the reviewed CA bytes without exposing rejected input", value => {
    expect(() => configuration({ ...environment(), FLUID_NAMING_BRAIN_DATABASE_CA_PEM: value })).toThrow("cloud_naming_database_configuration_invalid");
  });
  it("sanitizes a malformed credential URL without attaching its parser cause", () => {
    try { configuration({ ...environment(), FLUID_NAMING_BRAIN_DATABASE_URL: "postgresql://fluid_naming_brain_worker:%ZZprivate-value@db.fricsfwqibyhemknqgyf.supabase.co/postgres?sslmode=verify-full" }); }
    catch (error) {
      expect(String(error)).toBe("Error: cloud_naming_database_configuration_invalid");
      expect(error).not.toHaveProperty("cause"); return;
    }
    throw new Error("Invalid credentials were accepted");
  });
});
