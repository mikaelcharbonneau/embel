import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getApplicationOrigin } from "../../src/server/config";
import { getVercelPreviewOrigin, getVercelProductionOrigin } from "../../src/server/preview-origin.mjs";

const site = "https://fluid-platform-preview.vercel.app";
const previewHost = "fluid-platform-preview-gi3qeu6d7-embel.vercel.app";
const production = { VERCEL: "1", VERCEL_ENV: "production", APP_ORIGIN: site, VERCEL_URL: previewHost };
const preview = { ...production, VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: site.slice(8) };

describe("deployment origins", () => {
  it("uses the explicit production origin and keeps previews bound to their immutable URL", () => {
    expect(getVercelProductionOrigin(production)).toBe(site);
    expect(getApplicationOrigin(production)).toBe(site);
    expect(getVercelPreviewOrigin(preview)).toBe(`https://${previewHost}`);
    expect(getApplicationOrigin(preview)).toBe(`https://${previewHost}`);
    expect(getVercelProductionOrigin({ ...production, APP_ORIGIN: "https://fluid.example" })).toBe(
      "https://fluid.example",
    );
  });

  it.each([
    undefined,
    "",
    "null",
    "http://fluid.example",
    "https://fluid.example/",
    "https://fluid.example/path",
    "https://fluid.example?x=1",
    "https://fluid.example#x",
    "https://user:secret@fluid.example",
    "https://fluid.example:443",
    "https://fluid.example:8443",
    " https://fluid.example",
    "https://FLUID.example",
    "https://fluid.example.",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "https://bad_host.example",
  ])("rejects noncanonical production origin %s", (APP_ORIGIN) => {
    expect(() => getVercelProductionOrigin({ ...production, APP_ORIGIN })).toThrow(
      "Invalid production application origin.",
    );
    expect(() => getApplicationOrigin({ ...production, APP_ORIGIN })).toThrowError(
      expect.objectContaining({ code: "integration_unavailable" }),
    );
  });

  it.each([{ VERCEL: undefined }, { VERCEL: "0" }, { VERCEL_ENV: "preview" }, { VERCEL_ENV: "development" }])(
    "requires production platform context %j",
    (patch) => {
      expect(() => getVercelProductionOrigin({ ...production, ...patch })).toThrow(
        "Invalid production platform context.",
      );
    },
  );

  it.each([
    "fluid-platform-preview.vercel.app",
    "fluid-platform-preview-embel.vercel.app",
    "fluid-platform-preview-git-main-embel.vercel.app",
    "https://fluid-preview.vercel.app",
    "user:secret@fluid-preview.vercel.app",
    "fluid-preview.vercel.app:443",
    "fluid-preview.vercel.app/path",
  ])("still rejects aliases and malformed preview hostnames %s", (VERCEL_URL) => {
    expect(() => getVercelPreviewOrigin({ ...preview, VERCEL_URL })).toThrow("Invalid immutable preview hostname.");
  });
});

describe("deployment preflight", () => {
  const config = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
  function preflight(env: Record<string, string | undefined>) {
    return spawnSync(process.execPath, ["scripts/preview-preflight.mjs"], {
      cwd: new URL("../../", import.meta.url),
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        NEXT_PUBLIC_SUPABASE_URL: config.env.NEXT_PUBLIC_SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: config.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        ...env,
      },
    });
  }
  it.each([production, preview])("accepts a configured $VERCEL_ENV build", (env) => {
    const result = preflight(env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Embel deployment preflight passed.");
  });
  it.each([
    { ...production, APP_ORIGIN: undefined },
    { ...production, APP_ORIGIN: "https://user:do-not-log@fluid.example" },
    { ...production, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "do-not-log" },
    { ...production, VERCEL: undefined },
    { ...production, VERCEL_ENV: "development" },
    { ...preview, VERCEL_URL: "fluid-platform-preview-embel.vercel.app" },
  ])("stops invalid builds without echoing supplied values", (env) => {
    const result = preflight(env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Embel deployment preflight failed:");
    expect(result.stderr).not.toContain("do-not-log");
  });
});
