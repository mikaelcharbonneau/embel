import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const canary = "synthetic-QA-logo-secret-must-not-enter-artifact-9c3a12";
const project = "prj_QSWj13AkZzw4t8ZOGVzncFczz2gC";
const owner = "6840f4c2-15a6-45a7-97be-41e7e5e37f42";
const storageUser = "853fa383-9606-4577-924f-966194dc2f67";
const policy = "175c12bb65f63fe8839b58323ba6e5bbe605d06062a9a708bfdd23efbb8515d5";
const model = "gpt-image-2.5-sunburst-2026-09-08";
const hostEnvironment = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_ENV: "test" as const };
const supportedRuntime = process.versions.node === "22.22.2" && process.versions.icu === "78.2" && process.versions.unicode === "17.0";
const stopped = { event: "cloud_logo_worker_stopped", reason: "configuration_or_runtime_failure" };
type Manifest = { sourceRevision: string; sourceClean: boolean; sourceOrigin: string; projectId: string;
  bundleSha256: Record<string, string>; inputs: Record<string, string[]> };
let temporary: string, checkout: string, output: string, runtime: string, tripwire: string, revision: string, manifest: Manifest;

function build(changes: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, ["scripts/build-logo-worker.mjs"], { cwd: checkout,
    env: { ...hostEnvironment, OPENAI_API_KEY: canary, SUPABASE_SERVICE_ROLE_KEY: canary,
      EMBEL_LOGO_WORKER_CONFIGURATION_JSON: canary, EMBEL_LOGO_STORAGE_IDENTITY_JSON: canary, ...changes },
    encoding: "utf8", timeout: 30_000 });
}
function environment(): NodeJS.ProcessEnv {
  const concept = { operation: "identity.logo_concept", policyIdentity: policy, handlerVersion: "logo-image-v1",
    provider: "openai", model, engine: null, maxCostMicrousd: 2_000_000 };
  return { ...hostEnvironment, NODE_ENV: "production", FLUID_RUNTIME: "cloud", FLUID_LOCAL_PROTOTYPE: "false",
    VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production", VERCEL_PROJECT_ID: project,
    VERCEL_DEPLOYMENT_ID: "dpl_independentLogoQa01", VERCEL_REGION: "iad1", VERCEL_GIT_PROVIDER: "github",
    VERCEL_GIT_REPO_OWNER: "mikaelcharbonneau", VERCEL_GIT_REPO_SLUG: "embel", VERCEL_GIT_COMMIT_REF: "main",
    VERCEL_GIT_COMMIT_SHA: revision,
    EMBEL_LOGO_DATABASE_CA_PEM: readFileSync(path.join(root, "scripts/certs/supabase-prod-ca-2021.crt"), "utf8"),
    EMBEL_LOGO_STORAGE_IDENTITY_JSON: JSON.stringify({ version: 1, ownerId: owner, authUserId: storageUser,
      email: "independent-logo-qa@example.invalid", password: canary }),
    EMBEL_LOGO_WORKER_CONFIGURATION_JSON: JSON.stringify({ version: 1, enabled: true,
      binding: { ownerId: owner, roleName: "fluid_logo_worker", roleOid: 25288 }, workerId: "embel-logo-local-20261018",
      database: { host: "aws-0-us-east-1.pooler.supabase.com", port: 5432, database: "postgres", password: canary },
      storage: { authUserId: storageUser, publishableKey: "sb_publishable_synthetic_qa", sessionApproved: true },
      image: { apiKey: canary, model, rateVersion: "2026-10-07.v1", paidCallsApproved: true },
      operations: { concepts: concept, refinements: { ...concept, operation: "identity.logo_refine" } } }),
  };
}
function launch(args: string[], changes: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, ["--import", tripwire, "dist/index.js", ...args], {
    cwd: runtime, env: { ...environment(), ...changes }, encoding: "utf8", timeout: 15_000 });
}

beforeAll(() => {
  temporary = mkdtempSync(path.join(tmpdir(), "embel-cloud-logo-independent-qa-"));
  checkout = path.join(temporary, "source"); runtime = path.join(temporary, "runtime");
  const allowlist = JSON.parse(readFileSync(path.join(root, "services/logo-worker/source-inputs.json"), "utf8")) as Record<string, string[]>;
  const inputs = new Set([...Object.values(allowlist).flat(), "scripts/build-logo-worker.mjs", "scripts/esbuild-project.mjs", "services/logo-worker/source-inputs.json",
    "services/logo-worker/runtime-packages.json", "services/logo-worker/package-runtime.mjs", "services/logo-worker/Containerfile",
    "services/logo-worker/.dockerignore", "services/logo-worker/vercel.json", "scripts/package-logo-worker.mjs", "package.json", "package-lock.json", "tsconfig.json"]);
  for (const input of inputs) {
    mkdirSync(path.dirname(path.join(checkout, input)), { recursive: true }); cpSync(path.join(root, input), path.join(checkout, input));
  }
  writeFileSync(path.join(checkout, ".gitignore"), "/node_modules\n/services/logo-worker/dist/\n/.tmp/\n/.env.local\n/.local-fluid/\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: checkout, env: { ...hostEnvironment, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8",
  }).trim();
  // This commit belongs only to a disposable inert test fixture, never the app checkout.
  git("init", "--quiet", "--initial-branch=main", "--template="); git("add", ".");
  git("-c", "user.name=Synthetic QA", "-c", "user.email=qa@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Synthetic Logo build fixture");
  revision = git("rev-parse", "HEAD");
  symlinkSync(path.join(root, "node_modules"), path.join(checkout, "node_modules"));
  writeFileSync(path.join(checkout, ".env.local"), canary); mkdirSync(path.join(checkout, ".local-fluid"));
  writeFileSync(path.join(checkout, ".local-fluid", "synthetic.json"), JSON.stringify({ secret: canary }));
  output = path.join(checkout, "services/logo-worker/dist"); mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, "outdated-qa.js"), canary);
  const built = build();
  expect(built.error).toBeUndefined(); expect(built.status, built.stderr).toBe(0);
  expect(built.stdout + built.stderr).not.toContain(canary);
  manifest = JSON.parse(readFileSync(path.join(output, "build-manifest.json"), "utf8")) as Manifest;
  mkdirSync(runtime); cpSync(output, path.join(runtime, "dist"), { recursive: true });
  // Local protocol qualification intentionally uses this Mac's installed Sharp.
  // It is not evidence that the separately packaged Linux native addon executes.
  symlinkSync(path.join(root, "node_modules"), path.join(runtime, "node_modules"));
  tripwire = path.join(temporary, "network-tripwire.mjs");
  writeFileSync(tripwire, `
    import net from "node:net";
    import tls from "node:tls";
    import http from "node:http";
    import https from "node:https";
    import dns from "node:dns";
    import { syncBuiltinESMExports } from "node:module";
    if (process.env.EMBEL_QA_SIMULATE_LINUX === "true") {
      Object.defineProperty(process, "platform", { value: "linux" });
      Object.defineProperty(process, "arch", { value: "x64" });
    }
    const blocked = () => { console.error("QA_NETWORK_BLOCKED"); throw new Error("synthetic_transport_denied"); };
    net.Socket.prototype.connect = function () {
      console.error("QA_NETWORK_BLOCKED");
      queueMicrotask(() => this.destroy(new Error("synthetic_transport_denied")));
      return this;
    };
    tls.connect = http.request = http.get = https.request = https.get = blocked;
    dns.lookup = dns.resolve = blocked;
    globalThis.fetch = blocked;
    syncBuiltinESMExports();
  `);
}, 40_000);

afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

describe("independent cloud Logo release bytes", () => {
  it("binds every compiled executable to clean source without embedding secret build inputs", () => {
    expect(manifest).toMatchObject({ sourceRevision: revision, sourceClean: true, sourceOrigin: "git_checkout", projectId: project });
    expect(readdirSync(output).sort()).toEqual(["build-manifest.json", "index.js", "package.json", "raster-check.js", "raster.js"]);
    expect(Object.keys(manifest.bundleSha256).sort()).toEqual(["index.js", "raster-check.js", "raster.js"]);
    for (const file of readdirSync(output)) {
      const bytes = readFileSync(path.join(output, file)); expect(bytes.includes(Buffer.from(canary))).toBe(false);
      if (file in manifest.bundleSha256) expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest.bundleSha256[file]);
    }
    for (const graph of Object.values(manifest.inputs)) for (const input of graph) {
      expect(input).not.toMatch(/(?:^|\/)(?:\.local-fluid|\.env[^/]*|\.credentials|\.secrets|\.vercel)(?:\/|$)/u);
      expect(input).not.toMatch(/^(?:src\/app\/|scripts\/|services\/(?:naming|api-text)-worker\/|worker\/index\.ts)/u);
    }
  });
  it.each([{ EMBEL_LOGO_VERCEL_PROJECT_ID: "prj_independentWrongProject" }, { VERCEL_GIT_COMMIT_SHA: "f".repeat(40) }, { VERCEL: "1" }])(
    "rejects unsafe provenance before replacing the last verified output: %j", changes => {
      const before = readFileSync(path.join(output, "build-manifest.json"), "utf8"), result = build(changes);
      expect(result.status).toBe(1); expect(result.stdout + result.stderr).not.toContain(canary);
      expect(readFileSync(path.join(output, "build-manifest.json"), "utf8")).toBe(before);
    });
  it("processes actual PNG bytes through the packaged inspector and grayscale child from a source-free cwd", () => {
    const result = spawnSync(process.execPath, ["--import", tripwire, "dist/raster-check.js"], { cwd: runtime,
      env: { ...hostEnvironment, OPENAI_API_KEY: canary, EMBEL_LOGO_STORAGE_IDENTITY_JSON: canary }, encoding: "utf8", timeout: 15_000 });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(JSON.stringify({ event: "cloud_logo_raster_verified" })); expect(result.stderr).toBe("");
  });
  it("fails the offline sentinel when its isolated executable is absent", () => {
    const child = path.join(runtime, "dist/raster.js"), bytes = readFileSync(child); rmSync(child);
    try {
      const result = spawnSync(process.execPath, ["dist/raster-check.js"], { cwd: runtime, env: hostEnvironment, encoding: "utf8", timeout: 15_000 });
      expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe(JSON.stringify({ event: "cloud_logo_raster_unqualified" }));
    } finally { writeFileSync(child, bytes); }
  });
});

describe("independent packaged cloud Logo startup", () => {
  it.each([
    [[], {}], [["--preflight"], { VERCEL_ENV: "preview" }], [["--strategy"], {}],
    [["--preflight"], { VERCEL_GIT_COMMIT_SHA: "f".repeat(40) }],
    [["--preflight"], { VERCEL_PROJECT_ID: "prj_independentWrongProject" }],
  ] as const)("rejects an unqualified launch before network activity and without accidental raster stdin mode", (args, changes) => {
    const result = launch([...args], changes);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(JSON.stringify(stopped));
  });
  it.runIf(!supportedRuntime)("rejects unsupported Node/ICU versions before any database or provider access", () => {
    const result = launch(["--preflight"], { EMBEL_QA_SIMULATE_LINUX: "true" });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(JSON.stringify(stopped));
    expect(result.stderr).not.toContain("QA_NETWORK_BLOCKED");
    expect(result.stdout + result.stderr).not.toContain(canary);
  });
  // The production version gate must not be mocked away to claim native qualification.
  it.runIf(supportedRuntime)("reaches the blocked database boundary after real child processing under synthetic Linux identity metadata", () => {
    // The parent platform fields alone are synthetic. Raster child processes
    // retain the actual host platform. This checks the packaged import graph,
    // working directory and entrypoint separation, not Linux native execution.
    const result = launch(["--preflight"], { EMBEL_QA_SIMULATE_LINUX: "true" });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toEqual([
      "QA_NETWORK_BLOCKED",
      JSON.stringify({ event: "cloud_logo_runtime_failure", projectId: project,
        vercelDeploymentId: "dpl_independentLogoQa01", daemon: "logo-worker", sourceRevision: revision,
        phase: "database_qualification", reason: "database_qualification_failed",
        runtime: { node: "22.22.2", icu: "78.2", unicode: "17.0", platform: "linux", arch: "x64" } }),
      JSON.stringify(stopped),
    ]);
    expect(result.stdout + result.stderr).not.toContain(canary);
  });
});

describe("independent Logo packaging rejection before dependency download", () => {
  function pack(target = project) {
    return spawnSync(process.execPath, ["--import", tripwire, "scripts/package-logo-worker.mjs", "--project", target, "--mode", "stopped"], {
      cwd: checkout, env: hostEnvironment, encoding: "utf8", timeout: 10_000,
    });
  }
  function rejected() {
    const result = pack(); expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
    expect(result.stdout).toBe(""); expect(result.stderr).not.toContain("QA_NETWORK_BLOCKED"); expect(result.stderr).not.toContain(canary);
  }
  it("rejects a different deployment project", () => {
    const result = pack("prj_independentWrongProject");
    expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).not.toContain("QA_NETWORK_BLOCKED");
  });
  it("rejects dirty source before inspecting or copying the build", () => {
    const file = path.join(checkout, "unreviewed-source.txt"); writeFileSync(file, "synthetic unreviewed change");
    try { rejected(); } finally { rmSync(file); }
  });
  it("rejects an extra ignored payload in the executable directory", () => {
    const file = path.join(output, "ignored-secret.txt"); writeFileSync(file, canary);
    try { rejected(); } finally { rmSync(file); }
  });
  it.each(["index.js", "raster.js", "raster-check.js"])("rejects tampered executable bytes in %s", file => {
    const filename = path.join(output, file), bytes = readFileSync(filename); writeFileSync(filename, Buffer.concat([bytes, Buffer.from(canary)]));
    try { rejected(); } finally { writeFileSync(filename, bytes); }
  });
  it("rejects a symlink to a private file even when the path is allowlisted", () => {
    const filename = path.join(output, "raster-check.js"), bytes = readFileSync(filename); rmSync(filename);
    symlinkSync(path.join(checkout, ".env.local"), filename);
    try { rejected(); } finally { rmSync(filename); writeFileSync(filename, bytes); }
  });
  it.each([{ sourceRevision: "f".repeat(40) }, { sourceClean: false }, { sourceOrigin: "vercel_git_metadata" }, { projectId: "prj_independentWrongProject" }])(
    "rejects false build provenance: %j", changes => {
      const filename = path.join(output, "build-manifest.json"), bytes = readFileSync(filename);
      writeFileSync(filename, JSON.stringify({ ...manifest, ...changes }));
      try { rejected(); } finally { writeFileSync(filename, bytes); }
    });
});
