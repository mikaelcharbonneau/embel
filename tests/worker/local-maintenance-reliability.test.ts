import type { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const fixture = vi.hoisted(() => ({ clients: [] as EventEmitter[], query: vi.fn(), end: vi.fn(), run: vi.fn() }));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  return { Pool: class extends EventEmitter { constructor() { super(); fixture.clients.push(this); } query = fixture.query; end = fixture.end;
    connect = async () => ({ query: (sql: string, values?: unknown[]) => /^(?:BEGIN|SET LOCAL|COMMIT|ROLLBACK)/u.test(sql) ? Promise.resolve({ rows: [] }) : fixture.query(sql, values), release() {} }); } };
});
vi.mock("../../worker/runner", async importOriginal => ({ ...await importOriginal<typeof import("../../worker/runner")>(), runOneJob: fixture.run }));
vi.mock("node:timers/promises", () => ({ setTimeout: (milliseconds: number, value: unknown, options: { signal: AbortSignal }) => new Promise((resolve, reject) => {
  const signal = options.signal;
  const abort = () => { clearTimeout(timer); reject(new Error("synthetic_timer_cancelled")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(value); }, milliseconds);
  signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
}) }));
const priorExitCode = process.exitCode;
let shutdown: (() => void) | undefined;
afterEach(async () => {
  shutdown?.(); await vi.advanceTimersByTimeAsync(0); shutdown = undefined;
  process.exitCode = priorExitCode; vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); vi.clearAllTimers(); vi.useRealTimers();
  fixture.clients.length = 0; fixture.query.mockReset(); fixture.end.mockReset(); fixture.run.mockReset();
});
function environment() {
  const databaseUrl = "postgresql://fluid_naming_brain_worker.fricsfwqibyhemknqgyf:synthetic-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full";
  for (const [key, value] of Object.entries({ OPENAI_API_KEY: "synthetic-prototype-key", FLUID_NAMING_BRAIN_DATABASE_URL: databaseUrl,
    FLUID_NAMING_BRAIN_DEPLOYMENT_ID: "embel-naming-local-b2ff6ce8bbc2-20261017", FLUID_NAMING_BRAIN_MODEL: "gpt-6.1-sol", FLUID_OPENAI_VERIFIED_MODELS: "gpt-6.1-sol", FLUID_NAMING_BRAIN_ENABLED: "true", FLUID_PAID_CALLS_APPROVED: "true",
    FLUID_LOCAL_PROTOTYPE: "true", FLUID_RUNTIME: "local", NODE_ENV: "production", APP_ORIGIN: "http://127.0.0.1:3106", FLUID_WORKER_DATABASE_URL: databaseUrl, FLUID_GUIDED_INTERVIEW_ENABLED: "true",
    FLUID_TEXT_MODEL_REFORMULATE: "gpt-6.1-sol", FLUID_TEXT_MODEL_COMPETITORS: "gpt-6.1-sol", FLUID_TEXT_MODEL_AUDIENCE: "gpt-6.1-sol", FLUID_TEXT_MODEL_PERSONALITY: "gpt-6.1-sol" })) vi.stubEnv(key, value);
}
async function start(options: { operation: "expire_leases" | "claim" | "preferences"; code?: string; message?: string; failures: number }) {
  vi.useFakeTimers(); environment();
  let failures = options.failures, strategyClaims = 0, expiryCalls = 0, namingCalls = 0, ready = true;
  const namingSignals: AbortSignal[] = [];
  const fail = () => { throw Object.assign(new Error(options.message ?? "synthetic-private-database-message"), { code: options.code, detail: "synthetic-private-detail", client: { password: "synthetic-private-password" } }); };
  fixture.query.mockImplementation(async (sql: string) => {
    if (sql.includes("report_strategy_worker_ready")) return { rows: [{ ready }] };
    if (sql.includes("public.expire_job_leases")) { expiryCalls++; if (options.operation === "expire_leases" && failures-- > 0) fail(); return { rows: [{ count: 0 }] }; }
    if (sql.includes("get_naming_brain_preference_work")) { if (options.operation === "preferences" && failures-- > 0) fail(); return { rows: [{ result: [] }] }; }
    if (sql.includes("report_naming_brain_worker_ready")) return { rows: [{ result: true }] };
    if (sql.includes("expire_naming_brain_leases")) return { rows: [{ result: 0 }] };
    throw new Error("unexpected_synthetic_query");
  });
  fixture.run.mockImplementation(async (value: { workerId: string; signal: AbortSignal }) => {
    if (value.workerId.startsWith("naming-")) {
      namingCalls++; namingSignals.push(value.signal);
      // An already leased Naming execution remains active through independent
      // Strategy maintenance failure. No provider work is replayed by the mock.
      return value.signal.aborted ? "lease_lost" : new Promise(resolve => value.signal.addEventListener("abort", () => resolve("lease_lost"), { once: true }));
    }
    strategyClaims++;
    if (options.operation === "claim" && failures-- > 0) fail();
    return "idle";
  });
  fixture.end.mockResolvedValue(undefined);
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {});
  const signals = vi.spyOn(process, "once");
  await import("../../worker/index"); await vi.advanceTimersByTimeAsync(0);
  shutdown = signals.mock.calls.find(([name]) => name === "SIGTERM")?.[1] as (() => void) | undefined;
  expect(shutdown).toBeTypeOf("function");
  return { diagnostic, namingSignals, strategyClaims: () => strategyClaims, expiryCalls: () => expiryCalls, namingCalls: () => namingCalls, setReady: (value: boolean) => { ready = value; } };
}

describe("strict local maintenance isolation", () => {
  it.each([
    ["expire_leases", "Connection terminated due to connection timeout", "connection_timeout"],
    ["claim", "timeout expired", "connection_timeout"],
    ["preferences", "Connection terminated due to connection timeout", "connection_timeout"],
    ["expire_leases", "timeout exceeded when trying to connect", "pool_acquire_timeout"],
  ] as const)("recovers a proven pre-execution timeout during %s (%s) without replaying leased Naming", async (operation, message, classification) => {
    const state = await start({ operation, message, failures: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.namingCalls()).toBe(1); expect(state.namingSignals[0]!.aborted).toBe(false);
    expect(fixture.end).not.toHaveBeenCalled(); expect(process.exitCode).toBe(priorExitCode);
    expect(state.diagnostic.mock.calls.map(([value]) => { try { return JSON.parse(String(value)); } catch { return null; } })).toContainEqual(expect.objectContaining({
      event: "local_database_failure", role: operation === "preferences" ? "naming" : "strategy", operation, sqlState: null, failureClass: classification, retryAfterMs: 1_000 }));
    expect(JSON.stringify(state.diagnostic.mock.calls)).not.toContain("synthetic-private");
  });
  it.each([
    ["42501", "timeout expired"], ["synthetic-private-code", "Query read timeout"],
    ["ETIMEDOUT", "synthetic-private-message"], [undefined, "Connection terminated unexpectedly"], [undefined, "Query read timeout synthetic-private-suffix"], [undefined, "Query read timeout"],
  ] as const)("never retries a coded or unapproved %s failure (%s)", async (code, message) => {
    const state = await start({ operation: "expire_leases", code, message, failures: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.expiryCalls()).toBe(1); expect(process.exitCode).toBe(1); expect(fixture.end).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(state.diagnostic.mock.calls)).not.toContain("retryAfterMs");
  });
  it("backs off claim capacity failures1/2/4/20 while the original Naming execution stays active", async () => {
    const state = await start({ operation: "claim", code: "53300", failures: 4 });
    expect(state.expiryCalls()).toBe(1); expect(state.strategyClaims()).toBe(1); expect(state.namingCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(27_000);
    expect(state.strategyClaims()).toBeGreaterThan(0); expect(state.namingCalls()).toBe(1); expect(state.namingSignals[0]!.aborted).toBe(false);
    expect(fixture.end).not.toHaveBeenCalled(); expect(process.exitCode).toBe(priorExitCode);
    const retries = state.diagnostic.mock.calls.map(([value]) => { try { return JSON.parse(String(value)); } catch { return null; } }).filter(value => value?.retryAfterMs);
    expect(retries).toEqual([1_000, 2_000, 4_000, 20_000].map(retryAfterMs => ({ event: "local_database_failure", at: expect.any(String), role: "strategy", operation: "claim", sqlState: "53300", failureClass: "postgres", retryAfterMs })));
    expect(JSON.stringify(state.diagnostic.mock.calls)).not.toContain("synthetic-private");
  });
  it("cancels a query-cancelled claim backoff on explicit shutdown without retrying or duplicating Naming", async () => {
    const state = await start({ operation: "claim", code: "57014", failures: 1 });
    expect(state.strategyClaims()).toBe(1); expect(state.namingCalls()).toBe(1); expect(state.namingSignals[0]!.aborted).toBe(false);
    expect(state.diagnostic.mock.calls.map(([value]) => { try { return JSON.parse(String(value)); } catch { return null; } })).toContainEqual(expect.objectContaining({ event: "local_database_failure", role: "strategy", operation: "claim", sqlState: "57014", failureClass: "postgres", retryAfterMs: 1_000 }));
    shutdown!(); await vi.advanceTimersByTimeAsync(60_000);
    expect(state.strategyClaims()).toBe(1); expect(state.namingCalls()).toBe(1); expect(state.namingSignals[0]!.aborted).toBe(true);
    expect(fixture.end).toHaveBeenCalledTimes(2); expect(process.exitCode).toBe(priorExitCode);
  });
  it("expires the acknowledged cache after an expiry failure and stops claims while readiness is unavailable", async () => {
    const state = await start({ operation: "expire_leases", code: "57014", failures: 1 });
    state.setReady(false); await vi.advanceTimersByTimeAsync(20_000);
    const cachedClaims = state.strategyClaims(); expect(cachedClaims).toBe(4);
    await vi.advanceTimersByTimeAsync(47_000);
    expect(state.strategyClaims()).toBe(cachedClaims); expect(state.namingCalls()).toBe(1); expect(state.namingSignals[0]!.aborted).toBe(false);
    state.setReady(true); await vi.advanceTimersByTimeAsync(45_000);
    expect(state.strategyClaims()).toBeGreaterThan(cachedClaims); expect(state.namingCalls()).toBe(1); expect(fixture.end).not.toHaveBeenCalled();
  });
  it("does not retain cached readiness beyond 20 seconds across a retried claim", async () => {
    const state = await start({ operation: "claim", code: "57014", failures: 1 });
    state.setReady(false); await vi.advanceTimersByTimeAsync(20_000);
    const cachedClaims = state.strategyClaims(); expect(cachedClaims).toBe(5);
    await vi.advanceTimersByTimeAsync(47_000);
    expect(state.strategyClaims()).toBe(cachedClaims); expect(state.namingCalls()).toBe(1); expect(state.namingSignals[0]!.aborted).toBe(false);
    state.setReady(true); await vi.advanceTimersByTimeAsync(45_000);
    expect(state.strategyClaims()).toBeGreaterThan(cachedClaims); expect(state.namingCalls()).toBe(1); expect(fixture.end).not.toHaveBeenCalled();
  });
  it("recovers initial Naming attestation without discarding healthy Strategy work", async () => {
    const state = await start({ operation: "preferences", code: "53300", failures: 1 });
    expect(state.namingCalls()).toBe(0); expect(state.strategyClaims()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.namingCalls()).toBe(1); expect(state.namingSignals[0]!.aborted).toBe(false); expect(fixture.end).not.toHaveBeenCalled();
    expect(state.diagnostic.mock.calls.map(([value]) => { try { return JSON.parse(String(value)); } catch { return null; } })).toContainEqual(expect.objectContaining({ event: "local_database_failure", role: "naming", operation: "preferences", sqlState: "53300", failureClass: "postgres", retryAfterMs: 1_000 }));
  });
  it("propagates a permission failure without applying the transient maintenance retry", async () => {
    const state = await start({ operation: "expire_leases", code: "42501", failures: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.expiryCalls()).toBe(1); expect(state.strategyClaims()).toBe(0); expect(process.exitCode).toBe(1);
    expect(fixture.end).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(state.diagnostic.mock.calls)).not.toContain("retryAfterMs");
    expect(JSON.stringify(state.diagnostic.mock.calls)).not.toContain("synthetic-private");
  });
});
