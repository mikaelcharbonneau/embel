import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.join(root, "services/naming-worker/dist");
const canary = "synthetic-QA-secret-must-never-enter-artifacts-728ba61d";
const syntheticProject = "prj_independentqa01";
const publicCa = readFileSync(path.join(root, "scripts/certs/supabase-prod-ca-2021.crt"), "utf8");
const hostEnvironment = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_ENV: "test" as const };
const stopped = { event: "cloud_naming_worker_stopped", reason: "configuration_or_database_failure" };
type Manifest = { sourceRevision: string; sourceClean: boolean | null; sourceOrigin: string; bundleSha256: string; inputs: string[] };
type Environment = Record<string, string | undefined>;
let temporary: string, tripwire: string, manifest: Manifest, bundle: string;

function environment(): NodeJS.ProcessEnv {
  return { ...hostEnvironment,
    NODE_ENV: "production", FLUID_RUNTIME: "cloud", FLUID_LOCAL_PROTOTYPE: "false", VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
    VERCEL_PROJECT_ID: syntheticProject, VERCEL_DEPLOYMENT_ID: "dpl_independentqa01", VERCEL_REGION: "iad1",
    VERCEL_GIT_PROVIDER: "github", VERCEL_GIT_REPO_OWNER: "mikaelcharbonneau", VERCEL_GIT_REPO_SLUG: "embel",
    VERCEL_GIT_COMMIT_REF: "main", VERCEL_GIT_COMMIT_SHA: manifest.sourceRevision,
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

function packagingFixture() {
  const checkout = mkdtempSync(path.join(temporary, "package-source-"));
  for (const input of ["scripts/package-naming-worker.mjs", "services/naming-worker/Containerfile", "services/naming-worker/.dockerignore", "services/naming-worker/vercel.json"]) {
    mkdirSync(path.dirname(path.join(checkout, input)), { recursive: true });
    cpSync(path.join(root, input), path.join(checkout, input));
  }
  writeFileSync(path.join(checkout, ".gitignore"), "/.tmp/\n/services/naming-worker/dist/\n/.env.local\n/.local-fluid/\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: checkout, env: { ...hostEnvironment, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8",
  }).trim();
  git("init", "--quiet", "--initial-branch=main", "--template=");
  git("add", ".");
  git("-c", "user.name=Synthetic QA", "-c", "user.email=qa@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Synthetic packaging fixture");
  const revision = git("rev-parse", "HEAD"), bundleDirectory = path.join(checkout, "services/naming-worker/dist");
  mkdirSync(bundleDirectory);
  const contents = "// Synthetic inert packaging fixture; never executes provider work.\n";
  const receipt = { sourceRevision: revision, sourceClean: true, sourceOrigin: "git_checkout", projectId: syntheticProject,
    bundleSha256: createHash("sha256").update(contents).digest("hex"), inputs: [] };
  writeFileSync(path.join(bundleDirectory, "index.js"), contents);
  writeFileSync(path.join(bundleDirectory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  writeFileSync(path.join(bundleDirectory, "build-manifest.json"), JSON.stringify(receipt));
  writeFileSync(path.join(checkout, ".env.local"), canary);
  mkdirSync(path.join(checkout, ".local-fluid"));
  writeFileSync(path.join(checkout, ".local-fluid", "synthetic.env"), canary);
  const run = (mode = "stopped", project = syntheticProject) => spawnSync(process.execPath, ["scripts/package-naming-worker.mjs", "--project", project, "--mode", mode], {
    cwd: checkout, env: hostEnvironment, encoding: "utf8", timeout: 10_000,
  });
  return { checkout, git, revision, bundleDirectory, receipt, run };
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
      SUPABASE_SERVICE_ROLE_KEY: canary, DATABASE_URL: canary, EMBEL_NAMING_VERCEL_PROJECT_ID: syntheticProject }, encoding: "utf8", timeout: 20_000,
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
    expect(manifest.sourceOrigin).toBe("git_checkout");
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
    // This shared persistence helper was already in the reviewed source graph;
    // its historical filename is not a local launcher or service executable.
    expect(manifest.inputs.filter(input => input.startsWith("worker/local-"))).toEqual(["worker/local-persistence-recovery.ts"]);
    for (const input of manifest.inputs) {
      expect(input).not.toMatch(/(?:^|\/)(?:\.local-fluid|\.env[^/]*|\.credentials|\.secrets|\.vercel)(?:\/|$)/u);
      expect(input).not.toMatch(/^(?:src\/app\/|scripts\/|worker\/index\.|worker\/hosting\/)/u);
    }
  });

  it("rejects a provider source-revision mismatch before replacing an existing artifact", () => {
    const before = readFileSync(path.join(output, "build-manifest.json"), "utf8");
    const result = spawnSync(process.execPath, ["scripts/build-naming-worker.mjs"], {
      cwd: root, env: { ...hostEnvironment, VERCEL_GIT_COMMIT_SHA: "f".repeat(40), OPENAI_API_KEY: canary }, encoding: "utf8", timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(canary);
    expect(readFileSync(path.join(output, "build-manifest.json"), "utf8")).toBe(before);
  });

  it("builds from public Vercel metadata without Git, preserves missing provenance honestly and embeds no supplied secrets", () => {
    const context = path.join(temporary, "container-context");
    for (const input of [...manifest.inputs.filter(file => !file.startsWith("node_modules/")), "scripts/build-naming-worker.mjs", "services/naming-worker/source-inputs.json", "package.json", "package-lock.json", "tsconfig.json"]) {
      const destination = path.join(context, input);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(path.join(root, input), destination);
    }
    symlinkSync(path.join(root, "node_modules"), path.join(context, "node_modules"));
    const containerEnvironment = { ...environment(), PATH: path.join(temporary, "no-system-commands"), EMBEL_NAMING_VERCEL_PROJECT_ID: syntheticProject };
    const run = (changes: Environment = {}) => spawnSync(process.execPath, ["scripts/build-naming-worker.mjs", "--container"], {
      cwd: context, env: { ...containerEnvironment, ...changes }, encoding: "utf8", timeout: 20_000,
    });
    expect(existsSync(path.join(context, ".git"))).toBe(false);
    const built = run();
    expect(built.error).toBeUndefined();
    expect(built.status, built.stderr).toBe(0);
    const containerOutput = path.join(context, "services/naming-worker/dist");
    const receipt = JSON.parse(readFileSync(path.join(containerOutput, "build-manifest.json"), "utf8")) as Manifest;
    expect(receipt).toMatchObject({ sourceRevision: manifest.sourceRevision, sourceOrigin: "vercel_git_metadata", sourceClean: null });
    expect(receipt.bundleSha256).toBe(createHash("sha256").update(readFileSync(path.join(containerOutput, "index.js"))).digest("hex"));
    for (const file of readdirSync(containerOutput)) expect(readFileSync(path.join(containerOutput, file), "utf8")).not.toContain(canary);
    expect(built.stdout + built.stderr).not.toContain(canary);
    for (const changes of [
      { VERCEL_GIT_COMMIT_SHA: "unverified" }, { EMBEL_NAMING_VERCEL_PROJECT_ID: undefined },
      { VERCEL_PROJECT_ID: "prj_unapprovedproject01" }, { VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview" },
      { VERCEL_PROJECT_ID: "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt", EMBEL_NAMING_VERCEL_PROJECT_ID: "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt" },
    ]) {
      const rejected = run(changes);
      expect(rejected.status).toBe(1);
      expect(rejected.stdout + rejected.stderr).not.toContain(canary);
      expect(JSON.parse(readFileSync(path.join(containerOutput, "build-manifest.json"), "utf8"))).toEqual(receipt);
    }

    // A new side-effect import must require deliberate review of the source
    // boundary; a successful old bundle must survive this rejected rebuild.
    const entrypoint = path.join(context, "services/naming-worker/index.ts");
    const originalEntrypoint = readFileSync(entrypoint, "utf8");
    const preserved = Object.fromEntries(readdirSync(containerOutput).map(file => [file, readFileSync(path.join(containerOutput, file), "utf8")]));
    writeFileSync(path.join(context, "services/naming-worker/unreviewed.ts"), 'console.info("Synthetic unreviewed source");\n');
    writeFileSync(entrypoint, originalEntrypoint + '\nimport "./unreviewed";\n');
    const unreviewed = run();
    expect(unreviewed.status).toBe(1);
    expect(unreviewed.stdout + unreviewed.stderr).not.toContain(canary);
    expect(Object.fromEntries(readdirSync(containerOutput).map(file => [file, readFileSync(path.join(containerOutput, file), "utf8")]))).toEqual(preserved);
    writeFileSync(entrypoint, originalEntrypoint);
    rmSync(path.join(context, "services/naming-worker/unreviewed.ts"));

    // Only a synthetic marker is created: repository history and Git metadata
    // never enter this image-build fixture.
    mkdirSync(path.join(context, ".git"));
    const rejected = run();
    expect(rejected.status).toBe(1);
    expect(rejected.stdout + rejected.stderr).not.toContain(canary);
    expect(JSON.parse(readFileSync(path.join(containerOutput, "build-manifest.json"), "utf8"))).toEqual(receipt);
  }, 25_000);

  it("assembles a runtime image without build arguments, package installation or secret-bearing source", () => {
    const containerfile = readFileSync(path.join(root, "services/naming-worker/Containerfile"), "utf8")
      .replace(/^\s*#.*$/gmu, "").replace(/\\\r?\n/gu, " ");
    expect(containerfile).toMatch(/^FROM node:22\.22\.2[a-z0-9.-]*(?:@sha256:[a-f0-9]{64})?$/mu);
    expect(containerfile).not.toMatch(/^\s*(?:ARG|RUN|ADD|EXPOSE|VOLUME)\b/gmu);
    expect(containerfile).not.toMatch(/(?:OPENAI_API_KEY|DATABASE_URL|SERVICE_ROLE|OIDC|CREDENTIAL|ACTIVATED)/u);
    expect(containerfile).toMatch(/^\s*USER node(?::node)?$/mu);
    const copyLines = containerfile.split("\n").filter(line => /^\s*COPY\s/u.test(line));
    expect(copyLines.length).toBeGreaterThan(0);
    for (const line of copyLines) {
      const operands = line.trim().replace(/^COPY\s+/u, "").split(/\s+/u).filter(word => !word.startsWith("--"));
      const inputs = operands.slice(0, -1);
      expect(inputs.length).toBeGreaterThan(0);
      for (const input of inputs) expect(["dist/index.js", "dist/package.json", "dist/build-manifest.json"]).toContain(input);
    }
    const command = containerfile.match(/^\s*CMD (\[[^\n]+\])$/mu)?.[1];
    expect(command && JSON.parse(command)).toEqual(["node", "dist/index.js"]);

    const patterns = readFileSync(path.join(root, "services/naming-worker/.dockerignore"), "utf8").split(/\r?\n/u)
      .map(line => line.trim()).filter(line => line && !line.startsWith("#"));
    expect(["*", "**"]).toContain(patterns[0]);
    for (const pattern of patterns.slice(1)) expect(["!Containerfile", "!.dockerignore", "!dist", "!dist/index.js", "!dist/package.json", "!dist/build-manifest.json"]).toContain(pattern);
  });

  it("keeps the dedicated Vercel release dormant with no web runtime, functions or secret configuration", () => {
    const config = JSON.parse(readFileSync(path.join(root, "services/naming-worker/vercel.json"), "utf8"));
    expect(Object.keys(config.daemons)).toEqual(["naming-worker"]);
    expect(config.daemons["naming-worker"]).toMatchObject({ root: "naming-worker", entrypoint: "Containerfile", instances: { iad1: 0 } });
    expect(config.daemons["naming-worker"].terminationGracePeriodSeconds).toBeGreaterThanOrEqual(60);
    expect(config.daemons["naming-worker"].terminationGracePeriodSeconds).toBeLessThanOrEqual(3600);
    expect(config.framework).toBeNull();
    for (const key of ["env", "build", "functions", "services", "crons", "rewrites", "routes"]) expect(config).not.toHaveProperty(key);
    expect(JSON.stringify(config)).not.toMatch(/(?:OPENAI_API_KEY|DATABASE_URL|SERVICE_ROLE|OIDC|CREDENTIAL|ACTIVATED|\.\.\/)/u);
  });

});

describe("independent isolated Naming release packaging", () => {
  it.each(["stopped", "standby", "active"])("packages only the reviewed files for %s without copying local recovery or credentials", mode => {
    const fixture = packagingFixture(), result = fixture.run(mode);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(canary);
    const receipt = JSON.parse(result.stdout) as { release: string; sourceRevision: string; mode: string; projectId: string };
    expect(receipt).toMatchObject({ sourceRevision: fixture.revision, mode, projectId: syntheticProject });
    expect(receipt).toMatchObject({ deploymentMetadata: { githubDeployment: "1", githubOrg: "mikaelcharbonneau", githubRepo: "embel", githubCommitOrg: "mikaelcharbonneau", githubCommitRepo: "embel", githubCommitRef: "main", githubCommitSha: fixture.revision } });
    const metadata = JSON.parse(result.stdout).deploymentMetadata;
    expect(JSON.parse(result.stdout).deploymentMetadataArgs).toEqual(Object.entries(metadata).flatMap(([key, value]) => ["--meta", `${key}=${value}`]));
    expect(realpathSync(path.dirname(receipt.release))).toBe(realpathSync(path.join(fixture.checkout, ".tmp")));
    expect(readdirSync(receipt.release).sort()).toEqual([".vercelignore", "naming-worker", "package.json", "static", "vercel.json"]);
    expect(readdirSync(path.join(receipt.release, "naming-worker")).sort()).toEqual([".dockerignore", "Containerfile", "dist"]);
    expect(readdirSync(path.join(receipt.release, "naming-worker/dist")).sort()).toEqual(["build-manifest.json", "index.js", "package.json"]);
    expect(readdirSync(path.join(receipt.release, "static"))).toEqual(["index.html"]);
    // Vercel CLI ignores directory negations ending in a slash. They can make
    // a complete local release upload without its runtime and static files.
    const uploadPatterns = readFileSync(path.join(receipt.release, ".vercelignore"), "utf8").split(/\r?\n/u);
    expect(uploadPatterns).toEqual(expect.arrayContaining(["!static", "!naming-worker", "!naming-worker/dist"]));
    expect(uploadPatterns.filter(pattern => /^!.+\/$/u.test(pattern))).toEqual([]);
    const configuration = JSON.parse(readFileSync(path.join(receipt.release, "vercel.json"), "utf8"));
    expect(configuration.daemons["naming-worker"].instances).toEqual({ iad1: mode === "stopped" ? 0 : 1 });
    expect(configuration.daemons["naming-worker"].command).toEqual(mode === "standby" ? ["node", "dist/index.js", "--standby"] : undefined);
    for (const file of ["Containerfile", ".dockerignore"]) expect(readFileSync(path.join(receipt.release, "naming-worker", file), "utf8")).toBe(readFileSync(path.join(root, "services/naming-worker", file), "utf8"));
    for (const file of ["build-manifest.json", "index.js", "package.json"]) {
      const packaged = readFileSync(path.join(receipt.release, "naming-worker/dist", file), "utf8");
      expect(packaged).toBe(readFileSync(path.join(fixture.bundleDirectory, file), "utf8"));
      expect(packaged).not.toContain(canary);
    }
  });

  it("refuses running releases from a feature branch while allowing an inert stopped package", () => {
    const fixture = packagingFixture();
    fixture.git("checkout", "--quiet", "-b", "codex/synthetic-packaging-qa");
    for (const mode of ["standby", "active"]) expect(fixture.run(mode).status).toBe(1);
    expect(existsSync(path.join(fixture.checkout, ".tmp"))).toBe(false);
    expect(fixture.run("stopped").status).toBe(0);
  });

  it("rejects dirty source, wrong project, stale provenance, altered bytes and extra bundle files before creating a release", () => {
    const fixture = packagingFixture();
    const reject = () => {
      const result = fixture.run();
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).not.toContain(canary);
      expect(existsSync(path.join(fixture.checkout, ".tmp"))).toBe(false);
    };
    expect(fixture.run("stopped", "prj_unapprovedproject01").status).toBe(1);
    expect(fixture.run("stopped", "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt").status).toBe(1);
    writeFileSync(path.join(fixture.checkout, "uncommitted.txt"), "synthetic unsaved source"); reject();
    rmSync(path.join(fixture.checkout, "uncommitted.txt"));
    const receiptPath = path.join(fixture.bundleDirectory, "build-manifest.json");
    for (const changed of [{ sourceRevision: "f".repeat(40) }, { sourceClean: false }, { sourceClean: null, sourceOrigin: "vercel_git_metadata" }]) {
      writeFileSync(receiptPath, JSON.stringify({ ...fixture.receipt, ...changed })); reject();
    }
    writeFileSync(receiptPath, JSON.stringify(fixture.receipt));
    const indexPath = path.join(fixture.bundleDirectory, "index.js"), original = readFileSync(indexPath);
    writeFileSync(indexPath, "// Altered synthetic bundle\n"); reject();
    writeFileSync(indexPath, original);
    writeFileSync(path.join(fixture.bundleDirectory, "extra.env"), canary); reject();
    rmSync(path.join(fixture.bundleDirectory, "extra.env"));
    rmSync(indexPath);
    symlinkSync(path.join(fixture.checkout, ".env.local"), indexPath); reject();
  });
});

describe("independent packaged cloud Naming startup", () => {
  it.each([
    ["unactivated production", [], {}],
    ["preview deployment", ["--preflight"], { VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview" }],
    ["foreign source revision", ["--preflight"], { VERCEL_GIT_COMMIT_SHA: "f".repeat(40) }],
    ["another Vercel project", ["--preflight"], { VERCEL_PROJECT_ID: "prj_unapprovedproject01" }],
    ["Render hosting", ["--preflight"], { RENDER: "true" }],
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

  it.each(["--preflight", "--standby"])("reaches native %s only on the qualified runtime, without activation or leaking a connection failure", mode => {
    const result = launch([mode], { FLUID_NAMING_BRAIN_ENABLED: "false", FLUID_PAID_CALLS_APPROVED: "false" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    const qualified = process.versions.node === "22.22.2" && process.versions.icu === "78.2" && process.versions.unicode === "17.0";
    expect(result.stderr.trim().split("\n")).toEqual([...(qualified ? ["QA_NETWORK_BLOCKED"] : []), JSON.stringify(stopped)]);
    expect(result.stdout + result.stderr).not.toContain(canary);
  });
});
