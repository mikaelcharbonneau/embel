import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createDevelopmentIdentityRuntime, readDevelopmentIdentityConfiguration } from "@/server/development/identity";
import { productionIdentityTransactions } from "@/server/data/identity-transaction";
import type { IdentityPoolClientPort } from "@/server/runtime/identity-pool";
import type { PoolConfig } from "pg";
import { createIdentityTrustedDatabase } from "../database/identity-trusted-replacement-database";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const foreign = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const role = "embel_dev_identity_test";
const env = () => ({ NODE_ENV: "test" as const, EMBEL_DEVELOPMENT_ENABLED: "true",
  APP_ORIGIN: "http://127.0.0.1:3105", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  EMBEL_DEVELOPMENT_IDENTITY_DATABASE_URL: `postgresql://${role}:synthetic-password@127.0.0.1:54322/postgres`,
  EMBEL_DEVELOPMENT_IDENTITY_OWNER_ID: owner, EMBEL_DEVELOPMENT_IDENTITY_ROLE_NAME: role,
  EMBEL_DEVELOPMENT_IDENTITY_ROLE_OID: "12345" });

// The helper bodies as the baseline migration (and production) define them.
const sql = readFileSync(new URL("../../supabase/migrations/20261110190000_baseline.sql", import.meta.url), "utf8");
function helperRows() {
  return ["identity_web_owner", "prepare_identity_transaction", "commit_identity_transaction"].map(name => {
    // pg_dump quotes a body with $$, or with $_$ when the body itself contains $$.
    const match = sql.match(new RegExp(`CREATE FUNCTION fluid_private\\.${name}\\([\\s\\S]*?AS (\\$[A-Za-z_]*\\$)([\\s\\S]*?)\\1;`));
    if (!match) throw new Error("Missing reviewed local helper");
    return { name, body: match[2]!, definer: name !== "identity_web_owner", owner: name === "identity_web_owner" ? "postgres" : "fluid_identity_writer_definer_v1",
      volatility: name === "identity_web_owner" ? "s" : "v", safe_path: true, no_public_execute: true, trusted_owner: true, owner_attributes: true, callable: true };
  });
}
function ports() {
  const state = {
    login: { role_name: role, role_oid: "12345", restricted: true, incoming_safe: true }, helpers: helperRows(),
    probeError: { code: "22023", message: "invalid_identity_request" } as { code: string; message: string } | null,
    rollbackFailure: false, releaseFailure: false,
  };
  const queries: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (input: Parameters<IdentityPoolClientPort["query"]>[0]) => {
      queries.push(input.text);
      if (input.text.includes("AS restricted")) return { rows: [state.login] };
      if (input.text.includes("p.prosrc AS body")) return { rows: state.helpers };
      if (input.text.includes("prepare_identity_transaction($1")) {
        if (state.probeError) throw state.probeError;
        return { rows: [{ value: {} }] };
      }
      if (input.text === "ROLLBACK" && state.rollbackFailure) throw new Error("synthetic database unavailable");
      return { rows: [] };
    }),
    release: vi.fn((destroy?: boolean) => { void destroy; if (state.releaseFailure) throw new Error("synthetic release failure"); }),
    end: vi.fn(async () => {}),
  });
  const pool = Object.assign(new EventEmitter(), { connect: vi.fn(async () => client) });
  const createPool = vi.fn((_configuration: PoolConfig) => { void _configuration; return pool; });
  return { state, queries, client, pool, createPool };
}
afterEach(() => vi.unstubAllEnvs());

describe("opt-in local Identity transaction capability", () => {
  it.each([
    { EMBEL_DEVELOPMENT_ENABLED: undefined }, { EMBEL_DEVELOPMENT_ENABLED: "false" }, { NODE_ENV: "production" },
    { VERCEL: "1" }, { VERCEL_ENV: "preview" }, { APP_ORIGIN: "https://embel.example" },
    { NEXT_PUBLIC_SUPABASE_URL: "https://production.supabase.co" },
  ])("keeps hosted/default contexts closed before reading credentials %#", overrides => {
    const f = ports(), input = { ...env(), ...overrides, EMBEL_DEVELOPMENT_IDENTITY_DATABASE_URL: "invalid secret value" };
    expect(readDevelopmentIdentityConfiguration(input)).toBeNull();
    expect(createDevelopmentIdentityRuntime(input, f)).toBeNull();
    expect(f.createPool).not.toHaveBeenCalled();
  });
  it.each([
    { EMBEL_DEVELOPMENT_IDENTITY_OWNER_ID: "not-an-owner" }, { EMBEL_DEVELOPMENT_IDENTITY_ROLE_OID: "0" },
    { EMBEL_DEVELOPMENT_IDENTITY_ROLE_OID: "4294967296" }, { EMBEL_DEVELOPMENT_IDENTITY_ROLE_NAME: "postgres" },
    { EMBEL_DEVELOPMENT_IDENTITY_ROLE_NAME: "fluid_naming_brain_worker" },
    { EMBEL_DEVELOPMENT_IDENTITY_DATABASE_URL: `postgresql://${role}:synthetic-password@localhost:54322/postgres` },
    { EMBEL_DEVELOPMENT_IDENTITY_DATABASE_URL: `postgresql://${role}:synthetic-password@192.0.2.1:54322/postgres` },
    ...["127.1", "2130706433", "0177.0.0.1", "0x7f000001", "0x7f.0.0.1"].map(host => ({
      EMBEL_DEVELOPMENT_IDENTITY_DATABASE_URL: `postgresql://${role}:synthetic-password@${host}:54322/postgres`,
    })),
    { EMBEL_DEVELOPMENT_IDENTITY_DATABASE_URL: `postgresql://${role}:synthetic-password@127.0.0.1:3105/postgres` },
    { EMBEL_DEVELOPMENT_IDENTITY_DATABASE_URL: `postgresql://${role}:synthetic-password@127.0.0.1:54321/postgres` },
    { EMBEL_DEVELOPMENT_IDENTITY_DATABASE_URL: `postgresql://${role}:${"x".repeat(8193)}@127.0.0.1:54322/postgres` },
    { EMBEL_DEVELOPMENT_IDENTITY_DATABASE_URL: `postgresql://${role}:synthetic-password@127.0.0.1:\n54322/postgres` },
    { EMBEL_DEVELOPMENT_IDENTITY_DATABASE_URL: `postgresql://${role}:synthetic-password@127.0.0.1:54322/other` },
    { EMBEL_DEVELOPMENT_IDENTITY_DATABASE_URL: env().EMBEL_DEVELOPMENT_IDENTITY_DATABASE_URL + "?options=unsafe" },
    { EMBEL_DEVELOPMENT_IDENTITY_DATABASE_URL: env().EMBEL_DEVELOPMENT_IDENTITY_DATABASE_URL + "#unsafe" },
    { EMBEL_DEVELOPMENT_IDENTITY_DATABASE_URL: `postgresql://postgres:synthetic-password@127.0.0.1:54322/postgres` },
  ])("rejects broader or ambiguous principal configuration without constructing a pool %#", overrides => {
    const f = ports();
    expect(() => createDevelopmentIdentityRuntime({ ...env(), ...overrides }, f)).toThrow(expect.objectContaining({ code: "integration_unavailable" }));
    expect(f.createPool).not.toHaveBeenCalled();
  });
  it("uses an explicit dedicated loopback pool without a worker or PG environment fallback", () => {
    const f = ports();
    const config = readDevelopmentIdentityConfiguration(env());
    expect(JSON.stringify(config)).not.toContain("synthetic-password");
    expect(createDevelopmentIdentityRuntime({ ...env(), PGHOST: "production.invalid", PGPASSWORD: "ignored", FLUID_WORKER_DATABASE_URL: "ignored" }, f)).not.toBeNull();
    expect(f.createPool).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ host: "127.0.0.1", port: 54322,
      user: role, database: "postgres", ssl: false, max: 2, connectionTimeoutMillis: 5000, password: expect.any(Function) }));
    expect(f.pool.connect).not.toHaveBeenCalled();
    expect(f.createPool.mock.calls[0]![0]).not.toHaveProperty("connectionString");
    const configured = f.createPool.mock.calls[0]![0];
    expect((configured.password as () => string)()).toBe("synthetic-password");
    expect(configured.options).toBe("-c row_security=on -c statement_timeout=15000 -c lock_timeout=1500 -c idle_in_transaction_session_timeout=5000");
  });
  it("constructs the actual JS pool despite native-client and ambient PG overrides", () => {
    const script = `import { createDevelopmentIdentityRuntime } from './src/server/development/identity.ts';
      const runtime = createDevelopmentIdentityRuntime(process.env);
      if (!runtime || await runtime.resolve('${foreign}') !== null) throw new Error('local_runtime_invalid');
      console.log('local-js-pool-constructed');`;
    const output = execFileSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, ...env(), NODE_PG_FORCE_NATIVE: "1", PGHOST: "production.invalid", PGPORT: "6543",
        PGDATABASE: "production", PGUSER: "postgres", PGPASSWORD: "ignored-ambient", PGOPTIONS: "-c role=postgres" },
    });
    expect(output.trim()).toBe("local-js-pool-constructed");
  });
  it("does not acquire a connection for an unconfigured or aborted account", async () => {
    const f = ports(), runtime = createDevelopmentIdentityRuntime(env(), f)!;
    expect(await runtime.resolve(foreign)).toBeNull();
    expect(await runtime.resolve(owner, AbortSignal.abort())).toBeNull();
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it("advertises availability only after exact helper, principal and owner qualification, always rolling back", async () => {
    const f = ports(), runtime = createDevelopmentIdentityRuntime(env(), f)!;
    expect((await runtime.resolve(owner))?.saveAvailability).toEqual({ status: "available" });
    expect(f.queries[0]).toBe("BEGIN"); expect(f.queries.at(-1)).toBe("ROLLBACK");
    expect(f.queries).not.toContain("COMMIT");
    const probe = f.client.query.mock.calls.find(([input]) => input.text.includes("prepare_identity_transaction($1"))!;
    expect(probe[0].values).toEqual(["00000000-0000-4000-8000-000000000000", "{}"]);
    // The deliberate SQL rejection taints this lease; the pool destroys it.
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it.each(["foreign-bound-owner", "placeholder-helper", "changed-helper", "unsafe-helper", "missing-commit-grant", "privileged-login", "changed-oid", "unexpected-success"])(
    "keeps readiness unavailable for %s and cleans its transaction", async mode => {
      const f = ports();
      if (mode === "foreign-bound-owner") f.state.probeError = { code: "42501", message: "identity_claim_mismatch" };
      if (mode === "placeholder-helper") f.state.helpers = [];
      if (mode === "changed-helper") f.state.helpers[1]!.body += "\n-- unknown source";
      if (mode === "unsafe-helper") f.state.helpers[1]!.trusted_owner = false;
      if (mode === "missing-commit-grant") f.state.helpers[2]!.callable = false;
      if (mode === "privileged-login") f.state.login.restricted = false;
      if (mode === "changed-oid") f.state.login.role_oid = "9999";
      if (mode === "unexpected-success") f.state.probeError = null;
      expect(await createDevelopmentIdentityRuntime(env(), f)!.resolve(owner)).toBeNull();
      expect(f.queries.at(-1)).toBe("ROLLBACK");
      expect(f.client.release).toHaveBeenCalledTimes(1);
      expect(f.queries).not.toContain("COMMIT");
      if (!["foreign-bound-owner", "unexpected-success"].includes(mode)) {
        expect(f.queries.some(query => query.includes("prepare_identity_transaction($1"))).toBe(false);
      }
    });
  it("does not cache a successful readiness observation", async () => {
    const f = ports(), runtime = createDevelopmentIdentityRuntime(env(), f)!;
    expect(await runtime.resolve(owner)).not.toBeNull();
    f.state.probeError = { code: "42501", message: "unbound_identity_login" };
    expect(await runtime.resolve(owner)).toBeNull();
    expect(f.pool.connect).toHaveBeenCalledTimes(2);
  });
  it("keeps availability closed when rollback fails and destroys the connection", async () => {
    const f = ports();
    f.state.rollbackFailure = true;
    expect(await createDevelopmentIdentityRuntime(env(), f)!.resolve(owner)).toBeNull();
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("hard-closes a discarded connection when pool release fails", async () => {
    const f = ports(); f.state.releaseFailure = true;
    expect(await createDevelopmentIdentityRuntime(env(), f)!.resolve(owner)).not.toBeNull();
    expect(f.client.end).toHaveBeenCalledTimes(1);
  });
  it("retains the production default without any development gate", async () => {
    await expect(productionIdentityTransactions.select({ userId: owner }, foreign, {
      systemVersionId: foreign, expectedProjectRevision: 1, expectedReferenceRevision: 0,
      expectedPreferencesRevision: 0, expectedIdentityRevision: 0, acceptEarlierBasis: false,
    })).rejects.toMatchObject({ code: "integration_unavailable" });
  });
});

describe("readiness over actual restricted local SQL helpers (PGlite services fixture)", () => {
  let db: Awaited<ReturnType<typeof createIdentityTrustedDatabase>>;
  beforeAll(async () => { db = await createIdentityTrustedDatabase(); }, 60_000);
  afterAll(async () => { await db?.close(); });
  it("qualifies the real owner before invalid-request rejection and rejects a foreign administrative binding", async () => {
    await db.exec(`alter role fixture_identity_replacement_a rename to ${role}`);
    await db.query("update fluid_private.identity_web_principals set login_role_name=$1 where owner_id=$2", [role, owner]);
    const oid = (await db.query<{ oid: number }>("select oid from pg_catalog.pg_roles where rolname=$1", [role])).rows[0]!.oid;
    const client = Object.assign(new EventEmitter(), {
      query: async (input: Parameters<IdentityPoolClientPort["query"]>[0]) => db.query(input.text, input.values),
      release: vi.fn(), end: async () => { await db.exec("set session authorization postgres"); },
    });
    const pool = Object.assign(new EventEmitter(), { connect: async () => {
      await db.exec(`set session authorization ${role}`); return client;
    } });
    const runtime = createDevelopmentIdentityRuntime({ ...env(), EMBEL_DEVELOPMENT_IDENTITY_ROLE_OID: String(oid) }, { createPool: () => pool })!;
    try {
      expect((await runtime.resolve(owner))?.saveAvailability).toEqual({ status: "available" });
      expect(db.isInTransaction()).toBe(false);
      await db.exec("set session authorization postgres");
      expect((await db.query<{ absent: boolean }>("select to_regclass('pg_temp.identity_transaction_preparation') is null as absent")).rows[0]!.absent).toBe(true);
      // This is the real helper's independent binding check, not an intercepted
      // response or a claimed owner selected by the readiness resolver.
      await db.query("delete from fluid_private.identity_web_principals where owner_id=$1", [foreign]);
      await db.query("update fluid_private.identity_web_principals set owner_id=$1 where login_role_name=$2", [foreign, role]);
      expect(await runtime.resolve(owner)).toBeNull();
      expect(db.isInTransaction()).toBe(false);
      await db.exec("set session authorization postgres");
      expect((await db.query<{ absent: boolean }>("select to_regclass('pg_temp.identity_transaction_preparation') is null as absent")).rows[0]!.absent).toBe(true);
      expect(client.release).toHaveBeenCalledTimes(2);
    } finally {
      if (db.isInTransaction()) await db.exec("ROLLBACK");
      await db.exec("set session authorization postgres");
    }
  });
});
