import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readDevelopmentWorkerArguments, readDevelopmentWorkerConfiguration, readDevelopmentWorkerExecution,
  type DevelopmentWorkerEnvironment } from "../../worker/development/config";
import { runDevelopmentWorker, type DevelopmentWorkerDependencies, type DevelopmentWorkerPool } from "../../worker/development/runtime";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const environment = (): DevelopmentWorkerEnvironment => ({ NODE_ENV: "development", EMBEL_DEVELOPMENT_ENABLED: "true",
  APP_ORIGIN: "http://127.0.0.1:3105", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  EMBEL_DEVELOPMENT_WORKER_OWNER_ID: owner, EMBEL_DEVELOPMENT_WORKER_DEPLOYMENT_ID: "embel-dev-test",
  EMBEL_DEVELOPMENT_WORKER_DATABASE_URL: "postgresql://embel_development_text_worker@127.0.0.1:54322/postgres" });
function fixture(options: { identity?: Record<string, unknown>; owner?: unknown; permissions?: Record<string, unknown>; failRollback?: boolean } = {}) {
  const sql: string[] = [], release = vi.fn(), end = vi.fn(async () => {}), runText = vi.fn(async () => {});
  const client = { release, async query(query: string, values?: unknown[]) {
    sql.push(query);
    if (query === "ROLLBACK" && options.failRollback) throw new Error("private transport detail");
    if (query.includes("from pg_catalog.pg_roles")) return { rows: [{ session_user: "embel_development_text_worker", current_user: "embel_development_text_worker",
      database: "postgres", role_oid: 12345, rolcanlogin: true, rolinherit: false, rolsuper: false, rolbypassrls: false,
      rolcreatedb: false, rolcreaterole: false, rolreplication: false, has_memberships: false, owns_objects: false, ...options.identity }] };
    if (query.includes("owner_id")) return { rows: [{ owner_id: options.owner === undefined ? owner : options.owner }] };
    if (query.includes("has_function_privilege")) return { rows: [{ found: (values?.[0] as string[]).length, available: true, ...options.permissions }] };
    return { rows: [] };
  } };
  const pool: DevelopmentWorkerPool = { connect: vi.fn(async () => client), query: client.query, end, on: vi.fn(), removeListener: vi.fn() };
  const createPool = vi.fn(() => pool);
  const dependencies: DevelopmentWorkerDependencies = { createPool, runText };
  return { sql, release, end, runText, createPool, pool, dependencies };
}

it("requires an explicit lane and defaults to read-only preflight", () => {
  expect(readDevelopmentWorkerArguments(["--lane", "naming"])).toEqual({ lane: "naming", mode: "preflight" });
  expect(readDevelopmentWorkerArguments(["--lane", "strategy", "--run"])).toEqual({ lane: "strategy", mode: "run" });
  for (const args of [[], ["--run"], ["--lane", "all"], ["--lane", "naming", "--check"], ["--lane", "naming", "--run", "extra"]])
    expect(() => readDevelopmentWorkerArguments(args)).toThrow("development_worker_arguments_invalid");
});

it("builds explicit loopback connection fields without ambient Postgres fallbacks", () => {
  const config = readDevelopmentWorkerConfiguration("naming", { ...environment(), PGHOST: "production.invalid", PGPASSWORD: "private-value", PGOPTIONS: "-c role=postgres" });
  expect(config?.poolOptions).toMatchObject({ host: "127.0.0.1", port: 54322, user: "embel_development_text_worker", password: "", database: "postgres", ssl: false, options: "-c row_security=on" });
});

it.each([
  ["NODE_ENV", "production"], ["EMBEL_DEVELOPMENT_ENABLED", "false"], ["VERCEL", "1"], ["VERCEL_PROJECT_ID", "prj_local"],
  ["EMBEL_DEVELOPMENT_WORKER_OWNER_ID", "not-an-owner"], ["EMBEL_DEVELOPMENT_WORKER_DEPLOYMENT_ID", "production"],
  ["EMBEL_DEVELOPMENT_WORKER_DATABASE_URL", "postgresql://postgres@127.0.0.1:54322/postgres"],
  ["EMBEL_DEVELOPMENT_WORKER_DATABASE_URL", "postgresql://embel_development_text_worker@db.example.com:54322/postgres"],
  ["EMBEL_DEVELOPMENT_WORKER_DATABASE_URL", "postgresql://embel_development_text_worker@localhost:54322/postgres"],
  ["EMBEL_DEVELOPMENT_WORKER_DATABASE_URL", "postgresql://embel_development_text_worker@127.1:54322/postgres"],
  ["EMBEL_DEVELOPMENT_WORKER_DATABASE_URL", "postgresql://embel_development_text_worker@127.0.0.1:54321/postgres"],
  ["EMBEL_DEVELOPMENT_WORKER_DATABASE_URL", "postgresql://embel_development_text_worker@127.0.0.1:54322/other"],
  ["EMBEL_DEVELOPMENT_WORKER_DATABASE_URL", "postgresql://embel_development_text_worker@127.0.0.1:54322/postgres?host=production.invalid"],
])("rejects unsafe development worker configuration %s", async (key, value) => {
  const env = { ...environment(), [key]: value }, f = fixture();
  expect(readDevelopmentWorkerConfiguration("naming", env)).toBeNull();
  await expect(runDevelopmentWorker({ lane: "naming", mode: "preflight", signal: new AbortController().signal, env }, f.dependencies)).rejects.toThrow("development_worker_unavailable");
  expect(f.createPool).not.toHaveBeenCalled();
});

it("preflight checks actual restricted identity, owner and RPC privileges without readiness/claim/provider work", async () => {
  const f = fixture();
  expect(await runDevelopmentWorker({ lane: "naming", mode: "preflight", signal: new AbortController().signal, env: environment() }, f.dependencies))
    .toEqual({ status: "preflight_passed", lane: "naming", executionSupported: true });
  expect(f.sql[0]).toBe("BEGIN READ ONLY"); expect(f.sql.at(-1)).toBe("ROLLBACK");
  expect(f.sql.some(sql => /select public\.(?:claim|report|authorize|expire|complete)/u.test(sql))).toBe(false);
  expect(f.runText).not.toHaveBeenCalled(); expect(f.end).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledWith(undefined);
});

it.each([
  { identity: { rolsuper: true } }, { identity: { rolinherit: true } }, { identity: { rolbypassrls: true } },
  { identity: { has_memberships: true } }, { identity: { owns_objects: true } }, { identity: { current_user: "postgres" } },
  { owner: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, { permissions: { available: false } }, { permissions: { found: 0 } }, { failRollback: true },
])("fails closed on unqualified database identity or unconfirmed rollback %j", async bad => {
  const f = fixture(bad);
  await expect(runDevelopmentWorker({ lane: "naming", mode: "preflight", signal: new AbortController().signal, env: environment() }, f.dependencies)).rejects.toThrow("development_worker_unavailable");
  expect(f.runText).not.toHaveBeenCalled(); expect(f.sql.at(-1)).toBe("ROLLBACK"); expect(f.end).toHaveBeenCalledOnce();
  expect(f.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
});

it("never accepts the platform agent's provider key or a single paid flag", async () => {
  const env = { ...environment(), OPENAI_API_KEY: "platform-agent-key-not-for-application", FLUID_PAID_CALLS_APPROVED: "true",
    EMBEL_DEVELOPMENT_DISPATCH_APPROVED: "true", EMBEL_DEVELOPMENT_MODEL: "gpt-6-luna", EMBEL_DEVELOPMENT_VERIFIED_MODELS: "gpt-6-luna" };
  expect(readDevelopmentWorkerExecution("naming", env)).toBeNull();
  const f = fixture();
  await expect(runDevelopmentWorker({ lane: "naming", mode: "run", signal: new AbortController().signal, env }, f.dependencies)).rejects.toThrow("development_worker_unavailable");
  expect(f.createPool).not.toHaveBeenCalled(); expect(f.runText).not.toHaveBeenCalled();
  expect(readDevelopmentWorkerExecution("naming", { ...env, EMBEL_DEVELOPMENT_PROVIDER_API_KEY: "explicit-development-only-test-key", EMBEL_DEVELOPMENT_DISPATCH_APPROVED: "false" })).toBeNull();
});

it("requires explicit application access and database proof before entering a text runner", async () => {
  const f = fixture(), env = { ...environment(), EMBEL_DEVELOPMENT_PROVIDER_API_KEY: "explicit-development-only-test-key",
    FLUID_PAID_CALLS_APPROVED: "true", EMBEL_DEVELOPMENT_DISPATCH_APPROVED: "true", EMBEL_DEVELOPMENT_MODEL: "gpt-6-luna", EMBEL_DEVELOPMENT_VERIFIED_MODELS: "gpt-6-luna" };
  await runDevelopmentWorker({ lane: "naming", mode: "run", signal: new AbortController().signal, env }, f.dependencies);
  expect(f.runText).toHaveBeenCalledOnce(); expect(f.sql.at(-1)).toBe("ROLLBACK"); expect(f.end).toHaveBeenCalledOnce();
});

it("does no database or provider work after a prior stop", async () => {
  const controller = new AbortController(); controller.abort(); const f = fixture();
  expect(await runDevelopmentWorker({ lane: "strategy", mode: "preflight", signal: controller.signal, env: environment() }, f.dependencies)).toMatchObject({ status: "stopped" });
  expect(f.createPool).not.toHaveBeenCalled(); expect(f.runText).not.toHaveBeenCalled();
});

it("requires the explicit Logo operation and Storage configuration before constructing a pool", async () => {
  const env = { ...environment(), EMBEL_DEVELOPMENT_WORKER_DATABASE_URL: "postgresql://embel_development_logo_worker@127.0.0.1:54322/postgres",
    EMBEL_DEVELOPMENT_PROVIDER_API_KEY: "explicit-development-only-test-key", FLUID_PAID_CALLS_APPROVED: "true", EMBEL_DEVELOPMENT_DISPATCH_APPROVED: "true" };
  const f = fixture();
  expect(readDevelopmentWorkerConfiguration("logo", env)).not.toBeNull();
  await expect(runDevelopmentWorker({ lane: "logo", mode: "run", signal: new AbortController().signal, env }, f.dependencies)).rejects.toThrow("development_worker_unavailable");
  expect(f.createPool).not.toHaveBeenCalled(); expect(f.runText).not.toHaveBeenCalled();
});

it("reports Logo preflight without constructing a host or Storage authorization", async () => {
  const env = { ...environment(), EMBEL_DEVELOPMENT_WORKER_DATABASE_URL: "postgresql://embel_development_logo_worker@127.0.0.1:54322/postgres" };
  const f = fixture({ identity: { session_user: "embel_development_logo_worker", current_user: "embel_development_logo_worker" } });
  expect(await runDevelopmentWorker({ lane: "logo", mode: "preflight", signal: new AbortController().signal, env }, f.dependencies))
    .toEqual({ status: "preflight_passed", lane: "logo", executionSupported: true });
  expect(f.runText).not.toHaveBeenCalled(); expect(f.end).toHaveBeenCalledOnce();
});
