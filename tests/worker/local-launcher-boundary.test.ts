import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localWorkerDatabaseConfiguration, prepareLocalChildEnvironments } from "../../scripts/local-environment.mjs";

// These are synthetic credentials, files and child entrypoints. Neither child
// opens a listener, loads the application, contacts Postgres or invokes a provider.
const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
const databaseUrl = "postgresql://fluid_local_worker:synthetic-password@db.fricsfwqibyhemknqgyf.supabase.co:5432/postgres?sslmode=verify-full";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "fluid-launcher-fixture-")); roots.push(root);
  for (const directory of ["scripts", "scripts/certs", "worker", ".next", "node_modules/tsx", "node_modules/next/dist/bin"])
    await mkdir(path.join(root, directory), { recursive: true });
  for (const filename of await readdir(path.join(sourceRoot, "scripts"))) {
    if (filename.endsWith(".mjs")) await copyFile(path.join(sourceRoot, "scripts", filename), path.join(root, "scripts", filename));
  }
  await copyFile(path.join(sourceRoot, "scripts/certs/supabase-prod-ca-2021.crt"), path.join(root, "scripts/certs/supabase-prod-ca-2021.crt"));
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await writeFile(path.join(root, ".next/BUILD_ID"), "synthetic-build");
  await writeFile(path.join(root, "node_modules/tsx/package.json"), '{"type":"module","exports":"./index.mjs"}');
  await writeFile(path.join(root, "node_modules/tsx/index.mjs"), "");
  for (const [child, filename] of [["worker", "worker/local-runtime.ts"], ["web", "node_modules/next/dist/bin/next"]]) {
    await writeFile(path.join(root, filename!), `console.log(JSON.stringify({fixture: ${JSON.stringify(child)}, env: process.env})); setTimeout(() => process.exit(0), 300);`);
  }
  async function envFile(filename: string, contents: string, mode = 0o600) {
    await writeFile(path.join(root, filename), contents, { mode });
    await chmod(path.join(root, filename), mode);
  }
  async function workerFile(contents = `FLUID_WORKER_DATABASE_URL='${databaseUrl}'\n`) {
    await mkdir(path.join(root, ".local-fluid"), { mode: 0o700 });
    await envFile(".local-fluid/worker.env", contents);
  }
  function launch(env: Record<string, string> = {}, flags: string[] = []) {
    // A minimal environment prevents tests from forwarding any real secrets.
    const result = spawnSync(process.execPath, ["scripts/local.mjs", ...flags], { cwd: root,
      env: { NODE_ENV: "production", PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 5000 });
    const children = result.stdout.split("\n").filter(line => line.startsWith('{"fixture":'))
      .map(line => JSON.parse(line) as { fixture: string; env: Record<string, string> });
    return { ...result, children };
  }
  return { root, envFile, workerFile, launch };
}

describe("local launcher credential boundary", () => {
  it("delivers dedicated logo web configuration only to the Next child", async () => {
    const { launch } = await fixture();
    const logo = { FLUID_LOGO_WEB_DATABASE_URL: "synthetic-web-database-url", FLUID_LOGO_WEB_OWNER_ID: "synthetic-web-owner",
      FLUID_LOGO_WEB_ROLE_NAME: "fluid_logo_web_fixture", FLUID_LOGO_WEB_ROLE_OID: "987" };
    const result = launch(logo);
    expect(result.error).toBeUndefined(); expect(result.children).toHaveLength(2);
    const web = result.children.find(child => child.fixture === "web")!.env;
    const worker = result.children.find(child => child.fixture === "worker")!.env;
    for (const [key, value] of Object.entries(logo)) { expect(web[key]).toBe(value); expect(worker).not.toHaveProperty(key); }
  });
  it("rejects inherited worker credentials before spawning either child", async () => {
    const { launch } = await fixture();
    const result = launch({ FLUID_WORKER_DATABASE_URL: databaseUrl });
    expect(result.children).toHaveLength(0);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("synthetic-password");
  });
  it("gives the dedicated worker file only to the worker and retains public configuration", async () => {
    const { workerFile, envFile, launch } = await fixture();
    await workerFile();
    await envFile(".env.local", "NEXT_PUBLIC_SUPABASE_URL=https://public-config.example.invalid\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=synthetic-public-key\nFLUID_LOCAL_CONNECTION_APPROVED=true\n");
    const result = launch({ NODE_ENV: "test", OPENAI_API_KEY: "synthetic-api-key", PGPASSWORD: "synthetic-pg-password", FLUID_LOCAL_PROTOTYPE: "true" });
    expect(result.error).toBeUndefined();
    expect(result.children).toHaveLength(2);
    const web = result.children.find(child => child.fixture === "web")!.env;
    const worker = result.children.find(child => child.fixture === "worker")!.env;
    expect(worker.FLUID_WORKER_DATABASE_URL).toBe(databaseUrl);
    expect(web).not.toHaveProperty("FLUID_WORKER_DATABASE_URL");
    for (const env of [web, worker]) {
      expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://public-config.example.invalid");
      expect(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toBe("synthetic-public-key");
      expect(env.NODE_ENV).toBe("production");
      expect(env.FLUID_LOCAL_CONNECTION_APPROVED).toBe("false");
      expect(env.FLUID_LOCAL_PROTOTYPE).toBe("false");
      expect(env.FLUID_PAID_CALLS_APPROVED).toBe("false");
      expect(env).not.toHaveProperty("OPENAI_API_KEY");
      expect(env).not.toHaveProperty("PGPASSWORD");
      expect(env.FLUID_LOCAL_BRIDGE_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(web.FLUID_LOCAL_BRIDGE_TOKEN).toBe(worker.FLUID_LOCAL_BRIDGE_TOKEN);
  });
  it("keeps missing worker configuration unavailable and requires the explicit connection flag", async () => {
    const { launch } = await fixture();
    const result = launch({}, ["--enable-connection"]);
    expect(result.children).toHaveLength(2);
    for (const child of result.children) {
      expect(child.env).not.toHaveProperty("FLUID_WORKER_DATABASE_URL");
      expect(child.env.FLUID_LOCAL_CONNECTION_APPROVED).toBe("true");
    }
  });
  it.each([".env", ".env.local", ".env.production", ".env.production.local"])("rejects credentials in %s before spawning", async filename => {
    const { envFile, launch } = await fixture();
    await envFile(filename, `export FLUID_WORKER_DATABASE_URL="${databaseUrl}"\n`);
    const result = launch();
    expect(result.children).toHaveLength(0);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("synthetic-password");
  });
  it.each(["FLUID_WORKER_DATABASE_URL=", "\uFEFF FLUID_WORKER_DATABASE_URL : synthetic-password", "FLUID_WORKER_DATABASE_URL='line-one\nline-two'", "export\tFLUID_WORKER_DATABASE_URL = synthetic-password"])("rejects alternate Next.js assignment syntax without exposing its value (%#)", async assignment => {
    const { envFile, launch } = await fixture();
    await envFile(".env.production.local", assignment);
    const result = launch();
    expect(result.children).toHaveLength(0);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("synthetic-password");
  });
  it.each([0o644, 0o640, 0o400, 0o1600])("rejects worker file mode %i", async mode => {
    const { root, workerFile, launch } = await fixture();
    await workerFile(); await chmod(path.join(root, ".local-fluid/worker.env"), mode);
    expect(launch().children).toHaveLength(0);
  });
  it.each([0o755, 0o750, 0o500, 0o1700])("rejects worker directory mode %i", async mode => {
    const { root, workerFile, launch } = await fixture();
    await workerFile(); await chmod(path.join(root, ".local-fluid"), mode);
    expect(launch().children).toHaveLength(0);
    await chmod(path.join(root, ".local-fluid"), 0o700);
  });
  it.each([".local-fluid/worker.env", ".local-fluid", ".env.production.local"])("rejects symlinked configuration %s", async filename => {
    const { root, envFile, launch } = await fixture();
    if (filename === ".local-fluid") {
      await mkdir(path.join(root, "linked-directory"), { mode: 0o700 });
      await symlink(path.join(root, "linked-directory"), path.join(root, filename));
    } else {
      await mkdir(path.join(root, ".local-fluid"), { mode: 0o700 });
      await envFile("linked-file", `FLUID_WORKER_DATABASE_URL='${databaseUrl}'`);
      await symlink(path.join(root, "linked-file"), path.join(root, filename));
    }
    const result = launch();
    expect(result.children).toHaveLength(0);
    expect(result.status).toBe(1);
  });
  it.each([
    "", "# Empty configuration", "OTHER_KEY=synthetic-password", `FLUID_WORKER_DATABASE_URL=${databaseUrl}\nOTHER_KEY=value`,
    `FLUID_WORKER_DATABASE_URL=${databaseUrl}\nFLUID_WORKER_DATABASE_URL=${databaseUrl}`,
    `FLUID_WORKER_DATABASE_URL=${databaseUrl}\n$(touch should-never-exist)`,
    `FLUID_WORKER_DATABASE_URL=\"${databaseUrl}\n\"`,
    "FLUID_WORKER_DATABASE_URL=$INHERITED_DATABASE_URL",
  ])("rejects malformed or nonexclusive worker files (%#)", async contents => {
    const { workerFile, launch } = await fixture(); await workerFile(contents);
    const result = launch();
    expect(result.children).toHaveLength(0);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("synthetic-password");
  });
  it("returns separate environment objects without mutating the inherited environment or expanding values", async () => {
    const { root, workerFile } = await fixture();
    const literal = databaseUrl.replace("synthetic-password", "literal%24(secret)%60value%60");
    await workerFile(`# Synthetic fixture\nFLUID_WORKER_DATABASE_URL="${literal}" # safe literal\n`);
    const inherited = { NODE_ENV: "test" as const, PATH: "/synthetic/bin", NODE_OPTIONS: "--env-file=.local-fluid/worker.env" };
    const before = { ...inherited };
    const { web, worker } = await prepareLocalChildEnvironments(root, inherited, { bridgeToken: "synthetic-capability" });
    expect(inherited).toEqual(before);
    expect(web).not.toHaveProperty("NODE_OPTIONS");
    expect(worker).not.toHaveProperty("NODE_OPTIONS");
    expect(web).not.toHaveProperty("FLUID_WORKER_DATABASE_URL");
    expect(worker.FLUID_WORKER_DATABASE_URL).toBe(literal);
    worker.PATH = "/changed";
    expect(web.PATH).toBe("/synthetic/bin");
  });
  it("rejects a global TLS verification bypass before launching", async () => {
    const { root } = await fixture();
    await expect(prepareLocalChildEnvironments(root, { NODE_ENV: "test", NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { bridgeToken: "synthetic" })).rejects.toThrow("verified TLS");
  });
  it("refuses a modified bundled database CA before launching either process", async () => {
    const { root, workerFile, launch } = await fixture();
    await workerFile();
    await writeFile(path.join(root, "scripts/certs/supabase-prod-ca-2021.crt"), "untrusted replacement");
    const result = launch();
    expect(result.status).toBe(1);
    expect(result.children).toHaveLength(0);
    expect(result.stderr).not.toContain("synthetic-password");
  });
});

describe("worker database TLS and destination", () => {
  it("keeps certificate and hostname verification in the effective pg client config", () => {
    vi.stubEnv("PGSSLMODE", "no-verify");
    vi.stubEnv("PGHOST", "unapproved.example.invalid");
    const configuration = localWorkerDatabaseConfiguration(databaseUrl);
    const client = new Client(configuration); // Construction only; no connect().
    expect(configuration).not.toHaveProperty("connectionString");
    expect(client.host).toBe("db.fricsfwqibyhemknqgyf.supabase.co");
    expect(client.port).toBe(5432);
    expect(client.ssl).toEqual({ ca: expect.stringContaining("BEGIN CERTIFICATE"), rejectUnauthorized: true, servername: "db.fricsfwqibyhemknqgyf.supabase.co", minVersion: "TLSv1.2" });
  });
  it("accepts only the exact project-qualified worker through the verified session pooler", () => {
    const pooled = databaseUrl.replace("fluid_local_worker:", "fluid_local_worker.fricsfwqibyhemknqgyf:").replace("db.fricsfwqibyhemknqgyf.supabase.co", "aws-0-us-east-1.pooler.supabase.com");
    const config = localWorkerDatabaseConfiguration(pooled);
    expect(config.host).toBe("aws-0-us-east-1.pooler.supabase.com");
    expect(config.user).toBe("fluid_local_worker.fricsfwqibyhemknqgyf");
    expect(config.ssl).toMatchObject({ rejectUnauthorized: true, servername: config.host, ca: expect.stringContaining("BEGIN CERTIFICATE") });
    for (const user of ["postgres.fricsfwqibyhemknqgyf", "fluid_local_worker.otherproject", "fluid_local_worker"]) {
      expect(() => localWorkerDatabaseConfiguration(pooled.replace("fluid_local_worker.fricsfwqibyhemknqgyf:", `${user}:`))).toThrow();
    }
    expect(() => localWorkerDatabaseConfiguration(pooled.replace(":5432", ":6543"))).toThrow();
    expect(() => localWorkerDatabaseConfiguration(pooled.replace("aws-0-", "aws-1-"))).toThrow();
    expect(() => localWorkerDatabaseConfiguration(databaseUrl.replace("fluid_local_worker:", "postgres:"))).toThrow();
  });
  it.each(["", "disable", "allow", "prefer", "require", "verify-ca", "no-verify", "VERIFY-FULL"])("rejects TLS mode %s", mode => {
    const value = databaseUrl.replace("?sslmode=verify-full", mode ? `?sslmode=${mode}` : "");
    expect(() => localWorkerDatabaseConfiguration(value)).toThrow("sslmode=verify-full");
  });
  it.each([
    "&sslmode=disable", "&ssl=false", "&ssl=no-verify", "&rejectUnauthorized=false", "&sslrootcert=/arbitrary/file",
    "&host=unapproved.example.invalid", "&user=postgres", "&password=replaced", "&options=-c%20role%3Dpostgres", "&uselibpqcompat=true",
  ])("rejects query overrides %s", suffix => {
    expect(() => localWorkerDatabaseConfiguration(databaseUrl + suffix)).toThrow("sslmode=verify-full");
  });
  it.each([
    "db.another-project.supabase.co", "db.fricsfwqibyhemknqgyf.supabase.co.evil.invalid", "127.0.0.1", "localhost",
    "aws-0-us-east-1.pooler.supabase.com", "db.fricsfwqibyhemknqgyf.supabase.co.",
  ])("rejects unapproved or unverified database host %s", host => {
    expect(() => localWorkerDatabaseConfiguration(databaseUrl.replace("db.fricsfwqibyhemknqgyf.supabase.co", host))).toThrow();
  });
  it.each([
    "not-a-database-url", databaseUrl.replace("postgresql:", "https:"), databaseUrl.replace(":5432", ":6543"),
    databaseUrl.replace("/postgres?", "/other?"), databaseUrl.replace("fluid_local_worker:", ":"), databaseUrl.replace(":synthetic-password", ":"),
    databaseUrl + "#fragment", databaseUrl.replace("synthetic-password", "%00private"), databaseUrl.replace("synthetic-password", "%invalid"),
  ])("rejects malformed credentials and endpoints without echoing values (%#)", value => {
    let message = "";
    try { localWorkerDatabaseConfiguration(value); } catch (error) { message = (error as Error).message; }
    expect(message).toBe("Worker database configuration requires the approved endpoint, dedicated role and sslmode=verify-full.");
    expect(message).not.toContain("synthetic-password");
  });
});
