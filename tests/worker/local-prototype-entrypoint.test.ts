import type { PoolConfig } from "pg";
import type { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const fixture = vi.hoisted(() => ({ pools: [] as PoolConfig[], clients: [] as EventEmitter[], query: vi.fn(), end: vi.fn() }));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  return { Pool: class extends EventEmitter { constructor(options: PoolConfig) { super(); fixture.pools.push(options); fixture.clients.push(this); } query = fixture.query; end = fixture.end;
    connect = async () => ({ query: (sql: string, values?: unknown[]) => /^(?:BEGIN|SET LOCAL|COMMIT|ROLLBACK)/u.test(sql) ? Promise.resolve({ rows: [] }) : fixture.query(sql, values), release() {} }); } };
});
const priorExitCode = process.exitCode;
afterEach(() => { process.exitCode = priorExitCode; vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); fixture.pools.length = 0; fixture.clients.length = 0; fixture.query.mockReset(); fixture.end.mockReset(); });
const databaseUrl = "postgresql://fluid_naming_brain_worker.fricsfwqibyhemknqgyf:synthetic-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full";
function namingEnvironment() {
  for (const [key, value] of Object.entries({ OPENAI_API_KEY: "synthetic-prototype-api-key", FLUID_NAMING_BRAIN_DATABASE_URL: databaseUrl, FLUID_NAMING_BRAIN_DEPLOYMENT_ID: "embel-naming-local-b2ff6ce8bbc2-20261017", FLUID_NAMING_BRAIN_MODEL: "gpt-6.1-sol", FLUID_OPENAI_VERIFIED_MODELS: "gpt-6.1-sol", FLUID_NAMING_BRAIN_ENABLED: "true", FLUID_PAID_CALLS_APPROVED: "true" })) vi.stubEnv(key, value);
}
function prototypeEnvironment() {
  namingEnvironment();
  for (const [key, value] of Object.entries({ FLUID_LOCAL_PROTOTYPE: "true", FLUID_RUNTIME: "local", NODE_ENV: "production", APP_ORIGIN: "http://127.0.0.1:3106", FLUID_WORKER_DATABASE_URL: databaseUrl, FLUID_GUIDED_INTERVIEW_ENABLED: "true",
    FLUID_TEXT_MODEL_REFORMULATE: "gpt-6.1-sol", FLUID_TEXT_MODEL_COMPETITORS: "gpt-6.1-sol", FLUID_TEXT_MODEL_AUDIENCE: "gpt-6.1-sol", FLUID_TEXT_MODEL_PERSONALITY: "gpt-6.1-sol" })) vi.stubEnv(key, value);
}
async function failBeforeDispatch(error = new Error("synthetic_database_unavailable"), readinessOnly = false) {
  if (readinessOnly) fixture.query.mockImplementation(async (sql: string) => { throw sql.includes("report_strategy_worker_ready") ? error : new Error("synthetic-private-unclassified-failure"); });
  else fixture.query.mockRejectedValue(error);
  fixture.end.mockResolvedValue(undefined);
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  await import("../../worker/index");
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  return diagnostic;
}
describe("one local worker with a bounded restricted-role connection budget", () => {
  it("leaves one server connection of reconnect headroom under the existing four-connection role cap", async () => {
    prototypeEnvironment();
    await failBeforeDispatch();
    expect(fixture.pools.map(pool => pool.max)).toEqual([1, 2]);
    expect(fixture.pools.reduce((total, pool) => total + pool.max!, 0)).toBe(3);
    expect(4 - fixture.pools.reduce((total, pool) => total + pool.max!, 0)).toBe(1);
    for (const pool of fixture.pools) { expect(pool).not.toHaveProperty("connectionString"); expect(pool.connectionTimeoutMillis).toBe(30_000); expect(pool.ssl).toMatchObject({ rejectUnauthorized: true, servername: "aws-0-us-east-1.pooler.supabase.com" }); }
    expect(fixture.end).toHaveBeenCalledTimes(2);
    expect(fixture.query.mock.calls.every(([sql]) => sql.includes("report_strategy_worker_ready") || sql.includes("get_naming_brain_preference_work"))).toBe(true);
  });
  it("treats a false prototype flag as normal worker mode and preserves its pool config", async () => {
    namingEnvironment(); vi.stubEnv("FLUID_LOCAL_PROTOTYPE", "false");
    const diagnostic = await failBeforeDispatch(Object.assign(new Error("synthetic-private-capacity-message"), { code: "53300" }));
    expect(fixture.pools).toHaveLength(1);
    expect(fixture.pools[0]).toMatchObject({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 10_000 });
    expect(fixture.end).toHaveBeenCalledOnce();
    expect(fixture.query).toHaveBeenCalledOnce();
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("local_database_failure");
  });
  it("refuses an explicitly requested prototype outside the exact local boundary", async () => {
    namingEnvironment(); vi.stubEnv("FLUID_LOCAL_PROTOTYPE", "true"); vi.stubEnv("APP_ORIGIN", "https://unapproved.example.invalid");
    await failBeforeDispatch();
    expect(fixture.pools).toHaveLength(0); expect(fixture.query).not.toHaveBeenCalled();
  });
  it.each([0, 1])("contains an idle error from pool %s, stops both loops and omits the attached private Client", async index => {
    prototypeEnvironment();
    fixture.query.mockImplementation(async (sql: string) => {
      if (sql.includes("report_strategy_worker_ready")) return { rows: [{ ready: true }] };
      if (sql.includes("public.expire_job_leases")) return { rows: [{ count: 0 }] };
      if (sql.includes("public.claim_job")) return { rows: [] };
      if (sql.includes("get_naming_brain_preference_work")) return { rows: [{ result: [] }] };
      if (sql.includes("report_naming_brain_worker_ready")) return { rows: [{ result: true }] };
      if (sql.includes("expire_naming_brain_leases")) return { rows: [{ result: 0 }] };
      if (sql.includes("claim_naming_brain_job")) return { rows: [{ result: null }] };
      throw new Error("unexpected_synthetic_query");
    });
    fixture.end.mockResolvedValue(undefined);
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    await import("../../worker/index");
    await vi.waitFor(() => expect(fixture.clients).toHaveLength(2));
    const failure = Object.assign(new Error("synthetic-private-error-message"), { code: index === 0 ? "53300" : "57014", client: { password: "synthetic-private-password" } });
    expect(fixture.clients[index]!.emit("error", failure)).toBe(true);
    await vi.waitFor(() => expect(fixture.end).toHaveBeenCalledTimes(2));
    expect(process.exitCode).toBe(1);
    expect(diagnostic.mock.calls[0]).toEqual(["Worker stopped after a database connection failure."]);
    expect(JSON.parse(String(diagnostic.mock.calls[1]![0]))).toEqual({ event: "local_database_failure", at: expect.any(String), role: index === 0 ? "strategy" : "naming", operation: "idle_connection", sqlState: index === 0 ? "53300" : "57014", failureClass: "postgres" });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("synthetic-private");
    expect(fixture.clients.every(pool => pool.listenerCount("error") === 0)).toBe(true);
  });
  it("omits unrecognized error codes, messages, details and attached clients", async () => {
    prototypeEnvironment();
    const diagnostic = await failBeforeDispatch(Object.assign(new Error("synthetic-private-database-message"), { code: "synthetic-private-code", detail: "synthetic-private-detail", client: { password: "synthetic-private-password" } }));
    expect(diagnostic.mock.calls.map(([value]) => { try { return JSON.parse(String(value)); } catch { return null; } })).toContainEqual(expect.objectContaining({ event: "local_database_failure", role: "naming", operation: "preferences", sqlState: null, failureClass: "unknown" }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("synthetic-private");
  });
  it.each([
    ["timeout expired", undefined, "connection_timeout"],
    ["Connection terminated due to connection timeout", undefined, "connection_timeout"],
    ["timeout exceeded when trying to connect", undefined, "pool_acquire_timeout"],
    ["Query read timeout", undefined, "query_timeout"],
    ["Connection terminated unexpectedly", undefined, "connection_terminated"],
    ...["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ECONNABORTED"].map(code => ["synthetic-private-network-message", code, code] as [string, string, string]),
    ["Query read timeout synthetic-private-suffix", "synthetic-private-code", "unknown"],
  ])("reports only a fixed client failure class (%s/%s), with no new retry", async (message, code, classification) => {
    prototypeEnvironment();
    const diagnostic = await failBeforeDispatch(Object.assign(new Error(message), { code, detail: "synthetic-private-detail", client: { password: "synthetic-private-password" } }), true);
    const events = diagnostic.mock.calls.flatMap(([value]) => { try { return [JSON.parse(String(value))]; } catch { return []; } });
    expect(events).toContainEqual(expect.objectContaining({ event: "local_database_failure", role: "strategy", operation: "readiness", sqlState: null, failureClass: classification }));
    for (const event of events) expect(new Date(event.at).toISOString()).toBe(event.at);
    expect(fixture.query.mock.calls.filter(([sql]) => sql.includes("get_naming_brain_preference_work"))).toHaveLength(1);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("retryAfterMs");
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("synthetic-private");
  });
});
