import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { CLOUD_LOGO_PROJECT_ID, CLOUD_LOGO_RUNTIME, cloudLogoPoolOptions, getCloudLogoConfiguration, readCloudLogoConfiguration, readCloudLogoMode } from "../../worker/cloud-logo-configuration";
import { cloudLogoConfiguration, cloudLogoEnv, cloudLogoInput, cloudLogoRevision, cloudLogoSecret } from "./cloud-logo-fixture";

describe("cloud Logo deployment and credential qualification", () => {
  it("retains only public provenance on its opaque immutable handle", () => {
    const result = cloudLogoConfiguration();
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(cloudLogoSecret);
    expect(inspect(result, { showHidden: true })).not.toContain(cloudLogoSecret);
    expect(getCloudLogoConfiguration(result)?.configuration.operations.refinements.operation).toBe("identity.logo_refine");
    expect(getCloudLogoConfiguration({ ...result })).toBeNull();
    expect(() => cloudLogoPoolOptions({ ...result })).toThrow(/^cloud_logo_configuration_invalid$/u);
  });
  it("does not require dispatch activation for non-dispatch modes", () => {
    const env = cloudLogoEnv(); delete env.EMBEL_LOGO_CLOUD_ACTIVATED;
    expect(cloudLogoConfiguration("preflight", env).activated).toBe(false);
    expect(cloudLogoConfiguration("standby", env).activated).toBe(false);
    expect(() => cloudLogoConfiguration("run", env)).toThrow(/^cloud_logo_activation_required$/u);
  });
  it.each([
    ["NODE_ENV", "development"], ["FLUID_RUNTIME", "local"], ["FLUID_LOCAL_PROTOTYPE", "true"], ["VERCEL", "0"],
    ["VERCEL_ENV", "preview"], ["VERCEL_TARGET_ENV", "preview"], ["VERCEL_REGION", "sfo1"], ["VERCEL_GIT_PROVIDER", "gitlab"],
    ["VERCEL_GIT_REPO_OWNER", "someoneelse"], ["VERCEL_GIT_REPO_SLUG", "other"], ["VERCEL_GIT_COMMIT_REF", "feature"],
    ["VERCEL_GIT_PULL_REQUEST_ID", "1"], ["VERCEL_GIT_COMMIT_SHA", "b".repeat(40)], ["VERCEL_PROJECT_ID", "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt"],
    ["VERCEL_DEPLOYMENT_ID", "bad"], ["NODE_TLS_REJECT_UNAUTHORIZED", "0"], ["PGOPTIONS", "-c role=postgres"],
    ["PGHOST", "example.invalid"], ["RENDER", "true"], ["NODE_PG_FORCE_NATIVE", "0"], ["NODE_OPTIONS", "--import ./injected.js"], ["NODE_PATH", "/tmp"],
  ])("rejects ambient or mismatched %s before reading credentials", (key, value) => {
    const env = cloudLogoEnv(); env[key] = value; env.EMBEL_LOGO_WORKER_CONFIGURATION_JSON = "sensitive malformed JSON";
    expect(() => cloudLogoConfiguration("preflight", env)).toThrow(/^cloud_logo_environment_unqualified$/u);
  });
  it.each(["node", "icu", "unicode", "platform", "arch"])("requires the exact %s runtime fingerprint", part => {
    const options = { mode: "preflight" as const, env: cloudLogoEnv(), sourceRevision: cloudLogoRevision,
      expectedProjectId: CLOUD_LOGO_PROJECT_ID, versions: { ...CLOUD_LOGO_RUNTIME }, platform: "linux", arch: "x64" };
    if (part === "arch" || part === "platform") options[part] = "other";
    else Object.assign(options.versions, { [part]: "other" });
    expect(() => readCloudLogoConfiguration(options)).toThrow(/^cloud_logo_environment_unqualified$/u);
  });
  it.each(["ownerId", "roleName", "roleOid", "workerId", "authUserId", "concepts", "refinements", "model", "price", "policy", "reserve", "extra", "token"])("rejects changed %s compatibility without exposing secrets", part => {
    const input = cloudLogoInput(), env = cloudLogoEnv();
    if (part === "ownerId") Object.assign(input.binding, { ownerId: "d0000000-0000-4000-8000-000000000001" });
    if (part === "roleName") Object.assign(input.binding, { roleName: "postgres" });
    if (part === "roleOid") input.binding.roleOid++;
    if (part === "workerId") input.workerId = "replacement-worker";
    if (part === "authUserId") input.storage.authUserId = input.binding.ownerId;
    if (part === "concepts" || part === "refinements") Reflect.deleteProperty(input.operations, part);
    if (part === "model") Object.assign(input.image, { model: "other" });
    if (part === "price") Object.assign(input.image, { rateVersion: "other" });
    if (part === "policy") input.operations.concepts.policyIdentity = "a".repeat(64);
    if (part === "reserve") input.operations.refinements.maxCostMicrousd++;
    if (part === "extra") Object.assign(input.operations, { exports: {} });
    if (part === "token") Object.assign(input.storage, { accessToken: cloudLogoSecret });
    env.EMBEL_LOGO_WORKER_CONFIGURATION_JSON = JSON.stringify(input);
    expect(() => cloudLogoConfiguration("preflight", env)).toThrow(/^cloud_logo_configuration_invalid$/u);
  });
  it.each(["EMBEL_LOGO_WORKER_CONFIGURATION_JSON", "EMBEL_LOGO_STORAGE_IDENTITY_JSON", "EMBEL_LOGO_DATABASE_CA_PEM"])("rejects missing/malformed %s opaquely", key => {
    const env = cloudLogoEnv(); delete env[key];
    expect(() => cloudLogoConfiguration("preflight", env)).toThrow(/^cloud_logo_configuration_invalid$/u);
    env[key] = cloudLogoSecret;
    expect(() => cloudLogoConfiguration("preflight", env)).toThrow(/^cloud_logo_configuration_invalid$/u);
  });
  it("constructs only fixed TLS pool options without a connection string or local file", () => {
    const pool = cloudLogoPoolOptions(cloudLogoConfiguration());
    expect(pool).toMatchObject({ user: "fluid_logo_worker.fricsfwqibyhemknqgyf", host: "aws-0-us-east-1.pooler.supabase.com", database: "postgres",
      port: 5432, sslnegotiation: "postgres", options: "-c row_security=on", max: 3,
      ssl: { rejectUnauthorized: true, minVersion: "TLSv1.2", servername: "aws-0-us-east-1.pooler.supabase.com" } });
    expect(pool).not.toHaveProperty("connectionString"); expect(pool.password).toBe(cloudLogoSecret);
  });
  it("accepts only dedicated run/preflight/standby arguments", () => {
    expect(readCloudLogoMode([])).toBe("run"); expect(readCloudLogoMode(["--preflight"])).toBe("preflight"); expect(readCloudLogoMode(["--standby"])).toBe("standby");
    for (const args of [["--run"], ["--preflight", "--standby"], ["--config", "/tmp/private"]]) expect(() => readCloudLogoMode(args)).toThrow(/^cloud_logo_arguments_invalid$/u);
  });
});
