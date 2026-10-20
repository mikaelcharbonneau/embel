import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getApiTextPublicationOrigin, isHostedNamingRuntime, isLocalPrototypeRuntime } from "../../src/server/api-text/config";

const workerOrigin = "https://fluid-api-text-worker-qualified.vercel.app";
const projectId = "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt";
const local: Record<string, string | undefined> = {
  FLUID_LOCAL_API_TEXT_ENABLED: "true",
  NODE_ENV: "development",
  APP_ORIGIN: "http://127.0.0.1:3105",
  VERCEL_PROJECT_ID: projectId,
  FLUID_API_TEXT_WORKER_ORIGIN: workerOrigin,
};

describe("hosted Naming routing boundary", () => {
  const hosted = { FLUID_HOSTED_NAMING_ENABLED: "true", NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_ID: projectId, APP_ORIGIN: "https://www.embel.xyz" };
  it("routes only the explicitly enabled production application to account-scoped SQL", () => {
    expect(isHostedNamingRuntime(hosted)).toBe(true);
    expect(isHostedNamingRuntime({ ...hosted, VERCEL_TARGET_ENV: "production" })).toBe(true);
    expect(isLocalPrototypeRuntime(hosted)).toBe(false);
  });
  it.each([
    ["FLUID_HOSTED_NAMING_ENABLED", undefined], ["FLUID_HOSTED_NAMING_ENABLED", "TRUE"],
    ["NODE_ENV", "development"], ["NODE_ENV", "test"], ["VERCEL", undefined], ["VERCEL", "0"],
    ["VERCEL_ENV", "preview"], ["VERCEL_ENV", undefined], ["VERCEL_TARGET_ENV", "preview"],
    ["VERCEL_PROJECT_ID", "other"], ["VERCEL_PROJECT_ID", undefined],
    ["APP_ORIGIN", "http://127.0.0.1:3106"], ["APP_ORIGIN", "https://www.embel.xyz/"],
    ["APP_ORIGIN", "https://unrelated.vercel.app"], ["FLUID_LOCAL_PROTOTYPE", "true"], ["FLUID_RUNTIME", "local"],
  ])("rejects an unapproved hosted identity %s=%s", (key, value) => {
    expect(isHostedNamingRuntime({ ...hosted, [key!]: value })).toBe(false);
  });
  it.each([
    undefined, "", "https://fluid-platform-preview.vercel.app", "https://embel.xyz",
    "https://unrelated.vercel.app", "https://unrelated.example", "http://www.embel.xyz",
    "https://www.embel.xyz/", "https://www.embel.xyz/path", "https://www.embel.xyz?hosted=true",
    "https://www.embel.xyz#hosted", "https://www.embel.xyz:443", "https://www.embel.xyz:8443",
    "https://user:password@www.embel.xyz", "https://www.embel.xyz@unrelated.example",
    "https://www.embel.xyz.unrelated.example", "https://www.embel.xyz.",
    "https://WWW.EMBEL.XYZ", "https://www.ｅmbel.xyz", " https://www.embel.xyz", "https://www.embel.xyz\n",
  ])("rejects any noncanonical application origin %s", APP_ORIGIN => {
    expect(isHostedNamingRuntime({ ...hosted, APP_ORIGIN })).toBe(false);
  });
});

describe("local prototype runtime boundary", () => {
  const prototype = { FLUID_LOCAL_PROTOTYPE: "true", FLUID_RUNTIME: "local", NODE_ENV: "production", APP_ORIGIN: "http://127.0.0.1:3106" };
  it("accepts only the explicit production loopback prototype", () => {
    expect(isLocalPrototypeRuntime(prototype)).toBe(true);
    expect(isLocalPrototypeRuntime({ ...prototype, VERCEL: undefined })).toBe(true);
    expect(isLocalPrototypeRuntime({ ...prototype, VERCEL_PROJECT_ID: projectId })).toBe(true);
    expect(getApiTextPublicationOrigin(prototype)).toBeNull();
  });
  it.each([
    ["FLUID_LOCAL_PROTOTYPE", undefined], ["FLUID_LOCAL_PROTOTYPE", "TRUE"], ["FLUID_LOCAL_PROTOTYPE", "false"],
    ["FLUID_RUNTIME", undefined], ["FLUID_RUNTIME", "hosted"], ["NODE_ENV", "development"], ["NODE_ENV", "test"],
    ["APP_ORIGIN", "http://localhost:3106"], ["APP_ORIGIN", "http://127.0.0.1:3105"],
    ["APP_ORIGIN", "http://127.0.0.1:3106/"], ["APP_ORIGIN", "https://127.0.0.1:3106"],
    ["VERCEL", ""], ["VERCEL", "0"], ["VERCEL", "1"], ["VERCEL_ENV", "production"],
    ["VERCEL_TARGET_ENV", "preview"], ["VERCEL_DEPLOYMENT_ID", "dpl_fixture"],
    ["VERCEL_OIDC_TOKEN", "synthetic-token"],
  ])("refuses prototype dispatch with %s=%s", (key, value) => {
    expect(isLocalPrototypeRuntime({ ...prototype, [key!]: value })).toBe(false);
  });
});

describe("API text publication configuration", () => {
  it("permits the explicitly enabled loopback development web app without a hosted deployment identity", () => {
    expect(getApiTextPublicationOrigin(local)).toBe(workerOrigin);
  });

  it.each([
    ["FLUID_LOCAL_API_TEXT_ENABLED", undefined], ["FLUID_LOCAL_API_TEXT_ENABLED", "false"],
    ["FLUID_LOCAL_API_TEXT_ENABLED", "TRUE"], ["FLUID_LOCAL_API_TEXT_ENABLED", "1"],
    ["NODE_ENV", undefined], ["NODE_ENV", "production"], ["NODE_ENV", "test"],
    ["VERCEL", "1"], ["VERCEL", "0"], ["VERCEL", ""],
    ["VERCEL_ENV", "development"], ["VERCEL_ENV", "preview"], ["VERCEL_ENV", "production"],
    ["VERCEL_TARGET_ENV", "development"], ["VERCEL_TARGET_ENV", "preview"],
    ["VERCEL_DEPLOYMENT_ID", "dpl_qualified"],
    ["VERCEL_PROJECT_ID", undefined], ["VERCEL_PROJECT_ID", "other-project"],
    ["APP_ORIGIN", undefined],
  ])("refuses local publication with %s=%s", (key, value) => {
    expect(getApiTextPublicationOrigin({ ...local, [key!]: value })).toBeNull();
  });

  it.each([
    "http://localhost:3105", "http://127.0.0.1:3106", "http://127.0.0.2:3105",
    "http://[::1]:3105", "http://0.0.0.0:3105", "http://2130706433:3105", "http://127.1:3105",
    "http://127.0.0.1.evil.example:3105", "http://127.0.0.1:3105@evil.example",
    "http://user@127.0.0.1:3105", "http://127.0.0.1:3105/", "http://127.0.0.1:3105/path",
    "http://127.0.0.1:3105?local=true", "http://127.0.0.1:3105#local", "https://127.0.0.1:3105",
  ])("refuses an unapproved application origin %s", APP_ORIGIN => {
    expect(getApiTextPublicationOrigin({ ...local, APP_ORIGIN })).toBeNull();
  });

  it.each([
    "", "http://worker.vercel.app", "https://evil.example", "https://worker.vercel.app.evil.example",
    "https://worker.vercel.app:444", "https://worker.vercel.app/path", "https://worker.vercel.app/",
    "https://worker.vercel.app?token=synthetic", "https://worker.vercel.app#fragment", "https://user:pass@worker.vercel.app",
  ])("retains strict HTTPS worker origin validation for local development: %s", FLUID_API_TEXT_WORKER_ORIGIN => {
    expect(getApiTextPublicationOrigin({ ...local, FLUID_API_TEXT_WORKER_ORIGIN })).toBeNull();
  });

  it.each(["preview", "production"])("preserves the approved hosted %s configuration", VERCEL_ENV => {
    const hosted = { VERCEL: "1", VERCEL_ENV, VERCEL_PROJECT_ID: projectId, FLUID_API_TEXT_WORKER_ORIGIN: workerOrigin };
    expect(getApiTextPublicationOrigin(hosted)).toBe(workerOrigin);
    expect(getApiTextPublicationOrigin({ ...hosted, VERCEL_TARGET_ENV: VERCEL_ENV })).toBe(workerOrigin);
    expect(getApiTextPublicationOrigin({ ...hosted, VERCEL_TARGET_ENV: "other" })).toBeNull();
    expect(getApiTextPublicationOrigin({ ...hosted, VERCEL_PROJECT_ID: "other-project" })).toBeNull();
  });

  it.each(["preview", "production"])("refuses the local opt-in on a hosted %s process", VERCEL_ENV => {
    expect(getApiTextPublicationOrigin({ ...local, VERCEL: "1", VERCEL_ENV })).toBeNull();
  });
});
