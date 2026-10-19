import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { CLOUD_NAMING_RUNTIME, readCloudNamingConfiguration, readCloudNamingMode, type CloudNamingMode } from "../../worker/cloud-naming-configuration";

const sourceRevision = "a".repeat(40);
const expectedProjectId = "prj_SyntheticNamingWorker";
const ca = readFileSync(new URL("../../scripts/certs/supabase-prod-ca-2021.crt", import.meta.url), "utf8");
function environment(): Record<string, string | undefined> {
  return { NODE_ENV: "production", FLUID_RUNTIME: "cloud", FLUID_LOCAL_PROTOTYPE: "false", VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
    VERCEL_REGION: "iad1", VERCEL_GIT_PROVIDER: "github", VERCEL_GIT_REPO_OWNER: "mikaelcharbonneau", VERCEL_GIT_REPO_SLUG: "embel",
    VERCEL_GIT_COMMIT_REF: "main", VERCEL_GIT_COMMIT_SHA: sourceRevision, VERCEL_PROJECT_ID: expectedProjectId, VERCEL_DEPLOYMENT_ID: "dpl_SyntheticNamingDeployment",
    EMBEL_NAMING_CLOUD_ACTIVATED: "true", FLUID_NAMING_BRAIN_ENABLED: "true", FLUID_PAID_CALLS_APPROVED: "true",
    OPENAI_API_KEY: "synthetic-cloud-provider-key", FLUID_NAMING_BRAIN_DATABASE_URL: "postgresql://fluid_naming_brain_worker.fricsfwqibyhemknqgyf:synthetic-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
    FLUID_NAMING_BRAIN_DATABASE_CA_PEM: ca, FLUID_NAMING_BRAIN_DEPLOYMENT_ID: "embel-naming-local-b2ff6ce8bbc2-20261017",
    FLUID_NAMING_BRAIN_MODEL: "gpt-6-luna", FLUID_OPENAI_VERIFIED_MODELS: "gpt-6-luna" };
}
function configuration(env = environment(), mode: CloudNamingMode = "run") {
  return readCloudNamingConfiguration({ mode, sourceRevision, expectedProjectId, env, versions: CLOUD_NAMING_RUNTIME });
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
    ["VERCEL", "false"], ["VERCEL_ENV", "preview"], ["VERCEL_TARGET_ENV", "staging"], ["VERCEL_REGION", "sfo1"],
    ["VERCEL_GIT_PROVIDER", "gitlab"], ["VERCEL_GIT_REPO_OWNER", "another"], ["VERCEL_GIT_REPO_SLUG", "another-repository"], ["VERCEL_GIT_COMMIT_REF", "feature"],
    ["VERCEL_GIT_COMMIT_SHA", "b".repeat(40)], ["VERCEL_PROJECT_ID", "prj_AnotherNamingWorker"], ["VERCEL_DEPLOYMENT_ID", "bad deployment"],
    ["VERCEL_GIT_PULL_REQUEST_ID", "123"], ["NODE_TLS_REJECT_UNAUTHORIZED", "0"], ["RENDER", "true"],
    ["PGOPTIONS", "-c role=postgres"], ["PGSSLMODE", "no-verify"], ["PGPASSWORD", "unrelated-private-password"],
  ])("rejects an unqualified %s value before returning any connection", (key, value) => {
    expect(() => configuration({ ...environment(), [key!]: value })).toThrow("cloud_naming_environment_unqualified");
  });
  it.each(["node", "icu", "unicode"] as const)("requires the qualified %s runtime version", key => {
    expect(() => readCloudNamingConfiguration({ mode: "preflight", sourceRevision, expectedProjectId, env: environment(), versions: { ...CLOUD_NAMING_RUNTIME, [key]: "unqualified" } })).toThrow("cloud_naming_environment_unqualified");
  });
  it("rejects a source launch without a build revision", () => {
    expect(() => readCloudNamingConfiguration({ mode: "preflight", sourceRevision: "", expectedProjectId, env: environment(), versions: CLOUD_NAMING_RUNTIME })).toThrow("cloud_naming_environment_unqualified");
  });
  it.each(["", "unqualified", "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt"])("rejects a missing, malformed or web project build pin (%s)", projectId => {
    expect(() => readCloudNamingConfiguration({ mode: "preflight", sourceRevision, expectedProjectId: projectId,
      env: { ...environment(), VERCEL_PROJECT_ID: projectId }, versions: CLOUD_NAMING_RUNTIME })).toThrow("cloud_naming_environment_unqualified");
  });
  it.each(["EMBEL_NAMING_CLOUD_ACTIVATED", "FLUID_NAMING_BRAIN_ENABLED", "FLUID_PAID_CALLS_APPROVED"])("never starts the worker when %s is not true", key => {
    for (const value of [undefined, "false", "TRUE"]) expect(() => configuration({ ...environment(), [key]: value })).toThrow("cloud_naming_activation_required");
  });
  it.each(["preflight", "standby"] as const)("permits explicit read-only %s while every activation gate is false", mode => {
    expect(configuration({ ...environment(), EMBEL_NAMING_CLOUD_ACTIVATED: "false", FLUID_NAMING_BRAIN_ENABLED: "false", FLUID_PAID_CALLS_APPROVED: "false" }, mode).paidDispatchEnabled).toBe(false);
  });
  it("applies the same production, revision and credential boundary to standby", () => {
    for (const changes of [{ VERCEL_ENV: "preview" }, { VERCEL_GIT_COMMIT_SHA: "f".repeat(40) }, { VERCEL_PROJECT_ID: "prj_AnotherNamingWorker" }])
      expect(() => configuration({ ...environment(), ...changes }, "standby")).toThrow("cloud_naming_environment_unqualified");
    expect(() => configuration({ ...environment(), OPENAI_API_KEY: "short" }, "standby")).toThrow("cloud_naming_configuration_invalid");
    expect(() => configuration({ ...environment(), FLUID_NAMING_BRAIN_DATABASE_CA_PEM: undefined }, "standby")).toThrow("cloud_naming_database_configuration_invalid");
  });
  it.each([
    ["OPENAI_API_KEY", "short"], ["OPENAI_API_KEY", "synthetic key with whitespace"], ["FLUID_NAMING_BRAIN_DEPLOYMENT_ID", "bad deployment"],
    ["FLUID_NAMING_BRAIN_DEPLOYMENT_ID", "syntactic-but-unapproved-deployment"],
    ["FLUID_NAMING_BRAIN_MODEL", "gpt-6.1-sol"], ["FLUID_OPENAI_VERIFIED_MODELS", "gpt-6-luna,gpt-6.1-sol"],
  ])("requires exact Naming configuration for %s even in preflight", (key, value) => {
    expect(() => configuration({ ...environment(), [key!]: value }, "preflight")).toThrow("cloud_naming_configuration_invalid");
  });
  it("supports only normal Naming execution or explicit preflight and standby", () => {
    expect(readCloudNamingMode([])).toBe("run"); expect(readCloudNamingMode(["--preflight"])).toBe("preflight");
    expect(readCloudNamingMode(["--standby"])).toBe("standby");
    for (const args of [["--naming-only"], ["--preflight", "extra"], ["--preflight", "--preflight"], ["--all"], ["--standby", "--preflight"], ["--standby", "--standby"]]) expect(() => readCloudNamingMode(args)).toThrow("cloud_naming_arguments_invalid");
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
