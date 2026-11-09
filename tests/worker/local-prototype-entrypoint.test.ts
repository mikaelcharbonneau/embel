import type { PoolConfig } from "pg";
import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const fixture = vi.hoisted(() => ({ pools: [] as PoolConfig[], clients: [] as EventEmitter[], query: vi.fn(), end: vi.fn() }));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  return { Pool: class extends EventEmitter { constructor(options: PoolConfig) { super(); fixture.pools.push(options); fixture.clients.push(this); } query = fixture.query; end = fixture.end;
    connect = async () => ({ query: (sql: string, values?: unknown[]) => /^(?:BEGIN|SET LOCAL|COMMIT|ROLLBACK)/u.test(sql) ? Promise.resolve({ rows: [] }) : fixture.query(sql, values), release() {} }); } };
});
const priorExitCode = process.exitCode;
const priorArguments = process.argv;
beforeEach(() => { process.argv = [process.execPath, "worker/index.ts"]; });
afterEach(() => { process.argv = priorArguments; process.exitCode = priorExitCode; vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); fixture.pools.length = 0; fixture.clients.length = 0; fixture.query.mockReset(); fixture.end.mockReset(); });
const databaseUrl = "postgresql://fluid_naming_brain_worker.fricsfwqibyhemknqgyf:synthetic-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full";
function strategyEnvironment() {
  for (const [key, value] of Object.entries({ OPENAI_API_KEY: "synthetic-prototype-api-key", FLUID_WORKER_DATABASE_URL: databaseUrl, FLUID_OPENAI_VERIFIED_MODELS: "gpt-6.1-sol", FLUID_PAID_CALLS_APPROVED: "true",
    FLUID_TEXT_MODEL_REFORMULATE: "gpt-6.1-sol", FLUID_TEXT_MODEL_COMPETITORS: "gpt-6.1-sol", FLUID_TEXT_MODEL_AUDIENCE: "gpt-6.1-sol", FLUID_TEXT_MODEL_PERSONALITY: "gpt-6.1-sol" })) vi.stubEnv(key, value);
}
function prototypeEnvironment() {
  strategyEnvironment();
  for (const [key, value] of Object.entries({ FLUID_LOCAL_PROTOTYPE: "true", FLUID_RUNTIME: "local", NODE_ENV: "production", APP_ORIGIN: "http://127.0.0.1:3106", FLUID_GUIDED_INTERVIEW_ENABLED: "true" })) vi.stubEnv(key, value);
}
const idleWorker = async (sql: string) => {
  if (sql.includes("report_strategy_worker_ready")) return { rows: [{ ready: true }] };
  if (sql.includes("public.expire_job_leases")) return { rows: [{ count: 0 }] };
  if (sql.includes("public.claim_job")) return { rows: [] };
  throw new Error("unexpected_synthetic_query");
};
async function startWorker(answer: (sql: string) => Promise<unknown>) {
  fixture.query.mockImplementation(answer);
  fixture.end.mockResolvedValue(undefined);
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  await import("../../worker/index");
  return diagnostic;
}
async function failBeforeDispatch(error = new Error("synthetic_database_unavailable")) {
  const diagnostic = await startWorker(async () => { throw error; });
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  return diagnostic;
}
/** An idle pool error is the worker's own stop path for the Strategy loop. */
async function stopWorker() {
  await vi.waitFor(() => expect(fixture.clients).toHaveLength(1));
  fixture.clients[0]!.emit("error", new Error("synthetic-stop"));
  await vi.waitFor(() => expect(fixture.end).toHaveBeenCalledOnce());
}
const events = (diagnostic: { mock: { calls: unknown[][] } }) => diagnostic.mock.calls.flatMap(([value]) => { try { return [JSON.parse(String(value))]; } catch { return []; } });
describe("one local Strategy worker with a bounded restricted-role connection budget", () => {
  it.each([["--all"], ["--naming-only"], ["extra", "arguments"]])("rejects process arguments %j before opening a pool", async (...args) => {
    prototypeEnvironment(); process.argv.push(...args);
    await failBeforeDispatch();
    expect(fixture.pools).toEqual([]); expect(fixture.query).not.toHaveBeenCalled();
  });
  it("uses one verified-TLS connection and leaves reconnect headroom under the four-connection role cap", async () => {
    prototypeEnvironment();
    await startWorker(idleWorker);
    await vi.waitFor(() => expect(fixture.query.mock.calls.some(([sql]) => String(sql).includes("public.claim_job"))).toBe(true));
    await stopWorker();
    expect(fixture.pools.map(pool => pool.max)).toEqual([1]);
    expect(fixture.pools[0]).not.toHaveProperty("connectionString");
    expect(fixture.pools[0]!.connectionTimeoutMillis).toBe(30_000);
    expect(fixture.pools[0]!.ssl).toMatchObject({ rejectUnauthorized: true, servername: "aws-0-us-east-1.pooler.supabase.com", minVersion: "TLSv1.2" });
    expect(fixture.query.mock.calls.every(([sql]) => ["report_strategy_worker_ready", "public.expire_job_leases", "public.claim_job"].some(name => String(sql).includes(name)))).toBe(true);
  });
  it("treats a false prototype flag as normal worker mode and preserves its pool config", async () => {
    strategyEnvironment(); vi.stubEnv("FLUID_LOCAL_PROTOTYPE", "false");
    const diagnostic = await failBeforeDispatch(Object.assign(new Error("synthetic-private-capacity-message"), { code: "53300" }));
    expect(fixture.pools).toHaveLength(1);
    expect(fixture.pools[0]).toMatchObject({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 10_000 });
    expect(fixture.end).toHaveBeenCalledOnce();
    expect(fixture.query).toHaveBeenCalledOnce();
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("local_database_failure");
  });
  it("refuses an explicitly requested prototype outside the exact local boundary", async () => {
    strategyEnvironment(); vi.stubEnv("FLUID_LOCAL_PROTOTYPE", "true"); vi.stubEnv("APP_ORIGIN", "https://unapproved.example.invalid");
    await failBeforeDispatch();
    expect(fixture.pools).toHaveLength(0); expect(fixture.query).not.toHaveBeenCalled();
  });
  it("contains an idle pool error, stops the loop and omits the attached private Client", async () => {
    prototypeEnvironment();
    const diagnostic = await startWorker(idleWorker);
    await vi.waitFor(() => expect(fixture.clients).toHaveLength(1));
    const failure = Object.assign(new Error("synthetic-private-error-message"), { code: "53300", client: { password: "synthetic-private-password" } });
    expect(fixture.clients[0]!.emit("error", failure)).toBe(true);
    await vi.waitFor(() => expect(fixture.end).toHaveBeenCalledOnce());
    expect(process.exitCode).toBe(1);
    expect(diagnostic.mock.calls[0]).toEqual(["Worker stopped after a database connection failure."]);
    expect(JSON.parse(String(diagnostic.mock.calls[1]![0]))).toEqual({ event: "local_database_failure", at: expect.any(String), role: "strategy", operation: "idle_connection", sqlState: "53300", failureClass: "postgres" });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("synthetic-private");
    expect(fixture.clients.every(pool => pool.listenerCount("error") === 0)).toBe(true);
  });
  it("omits unrecognized error codes, messages, details and attached clients", async () => {
    prototypeEnvironment();
    const failure = Object.assign(new Error("synthetic-private-database-message"), { code: "synthetic-private-code", detail: "synthetic-private-detail", client: { password: "synthetic-private-password" } });
    const diagnostic = await startWorker(async sql => { if (sql.includes("report_strategy_worker_ready")) return { rows: [{ ready: true }] }; throw failure; });
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(events(diagnostic)).toContainEqual(expect.objectContaining({ event: "local_database_failure", role: "strategy", operation: "expire_leases", sqlState: null, failureClass: "unknown" }));
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
    const failure = Object.assign(new Error(message), { code, detail: "synthetic-private-detail", client: { password: "synthetic-private-password" } });
    const diagnostic = await startWorker(async () => { throw failure; });
    await vi.waitFor(() => expect(events(diagnostic)).toContainEqual(expect.objectContaining({ event: "local_database_failure", role: "strategy", operation: "readiness", sqlState: null, failureClass: classification })));
    await stopWorker();
    for (const event of events(diagnostic)) expect(new Date(event.at).toISOString()).toBe(event.at);
    expect(fixture.query).toHaveBeenCalledOnce();
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("retryAfterMs");
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("synthetic-private");
  });
});
