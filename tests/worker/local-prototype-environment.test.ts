import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { localPrototypeDatabaseConfiguration, prepareLocalChildEnvironments } from "../../scripts/local-environment.mjs";

// Synthetic files and pg construction only. No connection, provider or real
// local runtime is started by this suite.
const databaseUrl = "postgresql://fluid_naming_brain_worker.fricsfwqibyhemknqgyf:synthetic-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=%2Fsynthetic%2Fnative-ca.crt";
const credentials = `OPENAI_API_KEY='synthetic-prototype-api-key'\nFLUID_NAMING_BRAIN_DATABASE_URL='${databaseUrl}'\n`;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(contents = credentials) {
  const root = await mkdtemp(path.join(tmpdir(), "embel-prototype-fixture-")); roots.push(root);
  await mkdir(path.join(root, ".local-fluid"), { mode: 0o700 });
  await writeFile(path.join(root, ".local-fluid/naming-worker.env"), contents, { mode: 0o600 });
  return { root, prepare: (inherited: Record<string, string | undefined> = {}, options = {}) =>
    prepareLocalChildEnvironments(root, inherited, { bridgeToken: "synthetic-unused-subscription-capability", prototype: true, ...options }) };
}

describe("explicit local prototype credential boundary", () => {
  it("gives only the supervised worker the protected credentials and four exact guided policies", async () => {
    const { root, prepare } = await fixture();
    await writeFile(path.join(root, ".env.local"), "NEXT_PUBLIC_SUPABASE_URL=https://public.example.invalid\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=synthetic-public-key\n", { mode: 0o600 });
    const inherited = { PATH: "/synthetic/bin", NODE_OPTIONS: "--env-file=unapproved", PGPASSWORD: "synthetic-other-password", FLUID_TEXT_MODEL_POSITIONING: "gpt-6.1-sol", FLUID_TEXT_MODEL_STRATEGY: "gpt-6.1-sol", UNRELATED_SECRET: "synthetic-unrelated" };
    const { web, worker } = await prepare(inherited);
    expect(web).toMatchObject({ NODE_ENV: "production", FLUID_RUNTIME: "local", FLUID_LOCAL_PROTOTYPE: "true", APP_ORIGIN: "http://127.0.0.1:3106", FLUID_PAID_CALLS_APPROVED: "false", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic-public-key" });
    expect(worker).toMatchObject({ OPENAI_API_KEY: "synthetic-prototype-api-key", FLUID_NAMING_BRAIN_DATABASE_URL: databaseUrl, FLUID_WORKER_DATABASE_URL: databaseUrl,
      FLUID_OPENAI_VERIFIED_MODELS: "gpt-6-luna", FLUID_PAID_CALLS_APPROVED: "true", FLUID_GUIDED_INTERVIEW_ENABLED: "true" });
    // Naming runs only on the shared worker; the prototype no longer configures a Naming lane.
    for (const key of ["FLUID_NAMING_BRAIN_DEPLOYMENT_ID", "FLUID_NAMING_BRAIN_MODEL", "FLUID_NAMING_BRAIN_ENABLED"]) expect(worker).not.toHaveProperty(key);
    for (const operation of ["REFORMULATE", "COMPETITORS", "AUDIENCE", "PERSONALITY"]) expect(worker[`FLUID_TEXT_MODEL_${operation}`]).toBe("gpt-6-luna");
    for (const env of [web, worker]) for (const key of ["NODE_OPTIONS", "PGPASSWORD", "FLUID_LOCAL_BRIDGE_TOKEN", "FLUID_TEXT_MODEL_POSITIONING", "FLUID_TEXT_MODEL_STRATEGY", "UNRELATED_SECRET"]) expect(env).not.toHaveProperty(key);
    for (const key of ["OPENAI_API_KEY", "FLUID_NAMING_BRAIN_DATABASE_URL", "FLUID_WORKER_DATABASE_URL", "FLUID_NAMING_BRAIN_ENABLED"]) expect(web).not.toHaveProperty(key);
    expect(inherited).toHaveProperty("NODE_OPTIONS");
  });
  it.each(["VERCEL", "VERCEL_ENV", "VERCEL_DEPLOYMENT_ID", "VERCEL_OIDC_TOKEN"])("rejects inherited hosted marker %s", async key => {
    const { prepare } = await fixture();
    await expect(prepare({ [key]: "" })).rejects.toThrow("isolated local runtime");
  });
  it("refuses to combine subscription sign-in with the API prototype", async () => {
    const { prepare } = await fixture();
    await expect(prepare({}, { connectionApproved: true })).rejects.toThrow("isolated local runtime");
  });
  it.each(["OPENAI_API_KEY", "FLUID_NAMING_BRAIN_DATABASE_URL"])("rejects a second inherited credential source %s", async key => {
    const { prepare } = await fixture();
    await expect(prepare({ [key]: "synthetic-credential" })).rejects.toThrow("protected Naming worker file");
  });
  it.each([".env", ".env.local", ".env.production", ".env.production.local"])("rejects privileged credential assignments in Next's %s", async filename => {
    const { root, prepare } = await fixture();
    await writeFile(path.join(root, filename), "OPENAI_API_KEY: synthetic-secret", { mode: 0o600 });
    await expect(prepare()).rejects.toThrow("cannot be stored in Next.js");
  });
  it("rejects a hosted marker loaded later by Next", async () => {
    const { root, prepare } = await fixture();
    await writeFile(path.join(root, ".env.production"), "VERCEL_DEPLOYMENT_ID=synthetic", { mode: 0o600 });
    await expect(prepare()).rejects.toThrow("hosted runtime markers");
  });
  it("preserves an inert local project ID without forwarding it to either child environment", async () => {
    const { root, prepare } = await fixture();
    await writeFile(path.join(root, ".env.local"), "VERCEL_PROJECT_ID=synthetic-local-project", { mode: 0o600 });
    const { web, worker } = await prepare({ VERCEL_PROJECT_ID: "synthetic-inherited-project" });
    expect(web).not.toHaveProperty("VERCEL_PROJECT_ID");
    expect(worker).not.toHaveProperty("VERCEL_PROJECT_ID");
    expect(web.FLUID_LOCAL_PROTOTYPE).toBe("true");
    expect(worker.FLUID_LOCAL_PROTOTYPE).toBe("true");
  });
  it.each(["", credentials + "OPENAI_API_KEY='synthetic-duplicate'\n", credentials + "FLUID_PAID_CALLS_APPROVED=true\n", credentials + "$(touch must-not-exist)\n", credentials.replace("synthetic-prototype-api-key", "short")])("rejects malformed protected credential files (%#)", async contents => {
    const { prepare } = await fixture(contents);
    await expect(prepare()).rejects.toThrow(/protected Naming/);
  });
  it.each([0o644, 0o400, 0o1600])("requires exact owner-only file mode (%s)", async mode => {
    const { root, prepare } = await fixture();
    await chmod(path.join(root, ".local-fluid/naming-worker.env"), mode);
    await expect(prepare()).rejects.toThrow("protected regular file");
  });
  it("refuses symlinked credentials", async () => {
    const { root, prepare } = await fixture();
    await rm(path.join(root, ".local-fluid/naming-worker.env"));
    await writeFile(path.join(root, "synthetic-target"), credentials, { mode: 0o600 });
    await symlink(path.join(root, "synthetic-target"), path.join(root, ".local-fluid/naming-worker.env"));
    await expect(prepare()).rejects.toThrow("protected regular file");
  });
  it("keeps missing protected configuration unavailable", async () => {
    const { root, prepare } = await fixture();
    await rm(path.join(root, ".local-fluid/naming-worker.env"));
    await expect(prepare()).rejects.toThrow("existing protected Naming");
  });
});

describe("prototype's restricted database destination", () => {
  it("pins hostname and CA verification instead of loading the native URL's CA path", () => {
    const options = localPrototypeDatabaseConfiguration(databaseUrl), client = new Client(options);
    expect(options).not.toHaveProperty("connectionString");
    expect(client.ssl).toEqual({ ca: expect.stringContaining("BEGIN CERTIFICATE"), rejectUnauthorized: true, servername: "aws-0-us-east-1.pooler.supabase.com", minVersion: "TLSv1.2" });
    expect(client.user).toBe("fluid_naming_brain_worker.fricsfwqibyhemknqgyf");
  });
  it.each([
    databaseUrl.replace("fluid_naming_brain_worker.fricsfwqibyhemknqgyf", "postgres.fricsfwqibyhemknqgyf"),
    databaseUrl.replace("aws-0-us-east-1", "aws-1-us-east-1"), databaseUrl.replace(":5432", ":6543"),
    databaseUrl.replace("verify-full", "no-verify"), databaseUrl + "&sslmode=disable", databaseUrl + "&options=synthetic", databaseUrl + "&host=unapproved.example.invalid",
    databaseUrl.replace("synthetic-password", "%00private"), databaseUrl + "#secret", databaseUrl.replace("/postgres?", "/other?"),
  ])("rejects overrides or a different destination without exposing credentials (%#)", value => {
    expect(() => localPrototypeDatabaseConfiguration(value)).toThrow("approved endpoint, dedicated role and verified TLS");
  });
});
