import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getApiTextPublicationOrigin } from "../../src/server/api-text/config";

const workerOrigin = "https://fluid-api-text-worker-qualified.vercel.app";
const projectId = "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt";
const local: Record<string, string | undefined> = {
  FLUID_LOCAL_API_TEXT_ENABLED: "true",
  NODE_ENV: "development",
  APP_ORIGIN: "http://127.0.0.1:3105",
  VERCEL_PROJECT_ID: projectId,
  FLUID_API_TEXT_WORKER_ORIGIN: workerOrigin,
};

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
