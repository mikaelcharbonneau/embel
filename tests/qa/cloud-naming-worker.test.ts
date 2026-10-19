import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.join(root, "services/naming-worker/dist");
const canary = "synthetic-QA-secret-must-never-enter-artifacts-728ba61d";
const publicCa = readFileSync(path.join(root, "scripts/certs/supabase-prod-ca-2021.crt"), "utf8");
const hostEnvironment = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_ENV: "test" as const };
const stopped = { event: "cloud_naming_worker_stopped", reason: "configuration_or_database_failure" };
type Manifest = { sourceRevision: string; sourceClean: boolean; bundleSha256: string; inputs: string[] };
type Environment = Record<string, string | undefined>;
let temporary: string, tripwire: string, manifest: Manifest, bundle: string;

function environment(): NodeJS.ProcessEnv {
  return { ...hostEnvironment,
    NODE_ENV: "production", FLUID_RUNTIME: "cloud", FLUID_LOCAL_PROTOTYPE: "false", RENDER: "true", IS_PULL_REQUEST: "false",
    RENDER_SERVICE_TYPE: "worker", RENDER_SERVICE_NAME: "embel-naming-worker-production", RENDER_GIT_REPO_SLUG: "mikaelcharbonneau/embel",
    RENDER_GIT_BRANCH: "main", RENDER_GIT_COMMIT: manifest.sourceRevision, RENDER_SERVICE_ID: "srv-independentqa01", RENDER_INSTANCE_ID: "independent-qa",
    FLUID_NAMING_BRAIN_ENABLED: "true", FLUID_PAID_CALLS_APPROVED: "true", OPENAI_API_KEY: canary,
    FLUID_NAMING_BRAIN_DATABASE_URL: `postgresql://fluid_naming_brain_worker.fricsfwqibyhemknqgyf:${canary}@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full`,
    FLUID_NAMING_BRAIN_DATABASE_CA_PEM: publicCa, FLUID_NAMING_BRAIN_DEPLOYMENT_ID: "embel-naming-local-b2ff6ce8bbc2-20261017",
    FLUID_NAMING_BRAIN_MODEL: "gpt-6-luna", FLUID_OPENAI_VERIFIED_MODELS: "gpt-6-luna",
  };
}

function launch(args: string[] = [], changes: Environment = {}, source = false) {
  // A separate process exercises the actual bundled entrypoint. The built-in
  // transport tripwire rejects every attempt before DNS or network activity.
  const runtimeArguments = ["--import", tripwire, ...(source ? ["--conditions=react-server", "--import", "tsx"] : [])];
  return spawnSync(process.execPath, [...runtimeArguments, source ? "services/naming-worker/index.ts" : "services/naming-worker/dist/index.js", ...args], {
    cwd: root, env: { ...environment(), ...changes }, encoding: "utf8", timeout: 10_000,
  });
}

beforeAll(() => {
  temporary = mkdtempSync(path.join(tmpdir(), "embel-cloud-naming-qa-"));
  tripwire = path.join(temporary, "network-tripwire.mjs");
  writeFileSync(tripwire, `
    import net from "node:net";
    import tls from "node:tls";
    import http from "node:http";
    import https from "node:https";
    import dns from "node:dns";
    import { syncBuiltinESMExports } from "node:module";
    const blocked = () => { console.error("QA_NETWORK_BLOCKED"); throw new Error("synthetic_transport_denied"); };
    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
      const first = Array.isArray(args[0]) ? args[0][0] : args[0];
      const localPath = typeof first === "string" ? first : first?.path;
      // tsx uses a Unix socket for local loader IPC; it cannot reach a server.
      if (typeof localPath === "string" && localPath.startsWith("/")) return connect.apply(this, args);
      console.error("QA_NETWORK_BLOCKED");
      queueMicrotask(() => this.destroy(new Error("synthetic_transport_denied")));
      return this;
    };
    tls.connect = http.request = http.get = https.request = https.get = blocked;
    dns.lookup = dns.resolve = blocked;
    globalThis.fetch = blocked;
    syncBuiltinESMExports();
  `);
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, "outdated-qa.js"), canary);
  const build = spawnSync(process.execPath, ["scripts/build-naming-worker.mjs"], {
    cwd: root, env: { ...hostEnvironment, OPENAI_API_KEY: canary, FLUID_NAMING_BRAIN_DATABASE_URL: canary,
      SUPABASE_SERVICE_ROLE_KEY: canary, DATABASE_URL: canary }, encoding: "utf8", timeout: 20_000,
  });
  expect(build.error).toBeUndefined();
  expect(build.status, build.stderr).toBe(0);
  expect(build.stdout + build.stderr).not.toContain(canary);
  manifest = JSON.parse(readFileSync(path.join(output, "build-manifest.json"), "utf8")) as Manifest;
  bundle = readFileSync(path.join(output, "index.js"), "utf8");
}, 25_000);

afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

describe("independent cloud Naming deployment artifact", () => {
  it("binds the executable bytes and source revision without embedding the build environment", () => {
    expect(manifest.sourceRevision).toBe(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    expect(manifest.sourceClean).toBe(execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8" }).trim() === "");
    expect(manifest.bundleSha256).toBe(createHash("sha256").update(bundle).digest("hex"));
    expect(bundle).toContain(manifest.sourceRevision);
    expect(bundle).not.toContain("__EMBEL_NAMING_BUILD_REVISION__");
    for (const file of readdirSync(output)) expect(readFileSync(path.join(output, file), "utf8")).not.toContain(canary);
    expect(JSON.parse(readFileSync(path.join(output, "package.json"), "utf8"))).toMatchObject({ private: true, type: "module", engines: { node: "22.22.2" } });
  });

  it("includes only Naming handlers and no local secrets, app routes or other service executable", () => {
    expect(readdirSync(output).sort()).toEqual(["build-manifest.json", "index.js", "package.json"]);
    expect(manifest.inputs.filter(input => input.startsWith("services/"))).toEqual(["services/naming-worker/index.ts", "services/naming-worker/runtime.ts"]);
    expect(manifest.inputs.filter(input => input.startsWith("worker/handlers/"))).toEqual(["worker/handlers/naming-brain.ts", "worker/handlers/naming-progressive.ts"]);
    expect(manifest.inputs.some(input => input === "worker/naming-brain-store.ts")).toBe(true);
    expect(manifest.inputs.some(input => input === "src/server/ai/naming-brain/protocol.ts")).toBe(true);
    for (const input of manifest.inputs) {
      expect(input).not.toMatch(/(?:^|\/)(?:\.local-fluid|\.env[^/]*|\.credentials|\.secrets|\.vercel)(?:\/|$)/u);
      expect(input).not.toMatch(/^(?:src\/app\/|scripts\/|worker\/index\.|worker\/local-|worker\/hosting\/)/u);
    }
  });

  it("rejects a provider source-revision mismatch before replacing an existing artifact", () => {
    const before = readFileSync(path.join(output, "build-manifest.json"), "utf8");
    const result = spawnSync(process.execPath, ["scripts/build-naming-worker.mjs"], {
      cwd: root, env: { ...hostEnvironment, RENDER_GIT_COMMIT: "f".repeat(40), OPENAI_API_KEY: canary }, encoding: "utf8", timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(canary);
    expect(readFileSync(path.join(output, "build-manifest.json"), "utf8")).toBe(before);
  });

  it("keeps the planned service singular, manually deployed, private and explicitly unactivated", () => {
    const blueprint = readFileSync(path.join(root, "render.yaml"), "utf8").replace(/^\s*#.*$/gmu, "");
    expect(blueprint.match(/^\s*- type:/gmu)).toHaveLength(1);
    expect(blueprint).toMatch(/^\s*- type: worker$/mu);
    expect(blueprint).toMatch(/^\s*numInstances: 1$/mu);
    expect(blueprint).toMatch(/^\s*autoDeployTrigger: off$/mu);
    expect(blueprint).toMatch(/^previews:\n\s+generation: off$/mu);
    expect(blueprint).toMatch(/^\s*branch: main$/mu);
    expect(blueprint).toMatch(/^\s*preDeployCommand: node services\/naming-worker\/dist\/index\.js --preflight$/mu);
    expect(blueprint).toMatch(/^\s*startCommand: node services\/naming-worker\/dist\/index\.js$/mu);
    for (const key of ["EMBEL_NAMING_CLOUD_ACTIVATED", "OPENAI_API_KEY", "FLUID_NAMING_BRAIN_DATABASE_URL", "FLUID_NAMING_BRAIN_DATABASE_CA_PEM"]) {
      expect(blueprint).toMatch(new RegExp(`- key: ${key}\\n\\s+sync: false(?:\\n|$)`, "u"));
      expect(blueprint).not.toMatch(new RegExp(`- key: ${key}\\n\\s+value:`, "u"));
    }
    expect(blueprint).not.toMatch(/(?:SUPABASE_SERVICE_ROLE_KEY|DATABASE_ADMIN|\bdisks:|\bdatabases:|\bhealthCheckPath:)/u);
  });
});

describe("independent packaged cloud Naming startup", () => {
  it.each([
    ["unactivated production", [], {}],
    ["preview service", ["--preflight"], { IS_PULL_REQUEST: "true" }],
    ["foreign source revision", ["--preflight"], { RENDER_GIT_COMMIT: "f".repeat(40) }],
    ["foreign logical deployment", ["--preflight"], { FLUID_NAMING_BRAIN_DEPLOYMENT_ID: "synthetic-unapproved-deployment" }],
    ["local authority override", ["--preflight"], { FLUID_LOCAL_PROTOTYPE: "true" }],
    ["another worker operation", ["--strategy"], { EMBEL_NAMING_CLOUD_ACTIVATED: "true" }],
  ] as const)("rejects %s without touching the network or disclosing configuration", (_label, args, changes) => {
    const result = launch([...args], changes);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(JSON.stringify(stopped));
  });

  it("rejects an unpackaged source launch even when the production environment is supplied", () => {
    const result = launch(["--preflight"], { EMBEL_NAMING_CLOUD_ACTIVATED: "true" }, true);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(JSON.stringify(stopped));
  });

  it("reaches native preflight only on the qualified runtime, without activation or leaking a connection failure", () => {
    const result = launch(["--preflight"], { FLUID_NAMING_BRAIN_ENABLED: "false", FLUID_PAID_CALLS_APPROVED: "false" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    const qualified = process.versions.node === "22.22.2" && process.versions.icu === "78.2" && process.versions.unicode === "17.0";
    expect(result.stderr.trim().split("\n")).toEqual([...(qualified ? ["QA_NETWORK_BLOCKED"] : []), JSON.stringify(stopped)]);
    expect(result.stdout + result.stderr).not.toContain(canary);
  });
});
