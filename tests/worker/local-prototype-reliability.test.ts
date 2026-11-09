import type { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const fixture = vi.hoisted(() => ({ clients: [] as EventEmitter[], query: vi.fn(), end: vi.fn() }));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  return { Pool: class extends EventEmitter { constructor() { super(); fixture.clients.push(this); } query = fixture.query; end = fixture.end;
    connect = async () => ({ query: (sql: string, values?: unknown[]) => /^(?:BEGIN|SET LOCAL|COMMIT|ROLLBACK)/u.test(sql) ? Promise.resolve({ rows: [] }) : fixture.query(sql, values), release() {} }); } };
});
vi.mock("node:timers/promises", () => ({ setTimeout: (milliseconds: number, value: unknown, options: { signal: AbortSignal }) => new Promise((resolve, reject) => {
  const signal = options.signal;
  const abort = () => { clearTimeout(timer); reject(new Error("synthetic_timer_cancelled")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(value); }, milliseconds);
  signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
}) }));
const priorExitCode = process.exitCode;
afterEach(async () => {
  for (const client of fixture.clients) if (client.listenerCount("error")) client.emit("error", new Error("synthetic cleanup"));
  await vi.advanceTimersByTimeAsync(0);
  process.exitCode = priorExitCode; vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); vi.clearAllTimers(); vi.useRealTimers();
  fixture.clients.length = 0; fixture.query.mockReset(); fixture.end.mockReset();
});

describe("strict local Strategy readiness isolation", () => {
  it("keeps the worker running through a failed refresh, then restores acknowledged Strategy readiness on the next interval", async () => {
    vi.useFakeTimers();
    const databaseUrl = "postgresql://fluid_naming_brain_worker.fricsfwqibyhemknqgyf:synthetic-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full";
    for (const [key, value] of Object.entries({ OPENAI_API_KEY: "synthetic-prototype-key", FLUID_OPENAI_VERIFIED_MODELS: "gpt-6.1-sol", FLUID_PAID_CALLS_APPROVED: "true",
      FLUID_LOCAL_PROTOTYPE: "true", FLUID_RUNTIME: "local", NODE_ENV: "production", APP_ORIGIN: "http://127.0.0.1:3106", FLUID_WORKER_DATABASE_URL: databaseUrl, FLUID_GUIDED_INTERVIEW_ENABLED: "true",
      FLUID_TEXT_MODEL_REFORMULATE: "gpt-6.1-sol", FLUID_TEXT_MODEL_COMPETITORS: "gpt-6.1-sol", FLUID_TEXT_MODEL_AUDIENCE: "gpt-6.1-sol", FLUID_TEXT_MODEL_PERSONALITY: "gpt-6.1-sol" })) vi.stubEnv(key, value);
    let reports = 0, strategyClaims = 0;
    fixture.query.mockImplementation(async (sql: string) => {
      if (sql.includes("report_strategy_worker_ready")) { if (++reports === 1) throw new Error("synthetic-private-database-timeout"); return { rows: [{ ready: true }] }; }
      if (sql.includes("public.expire_job_leases")) return { rows: [{ count: 0 }] };
      if (sql.includes("public.claim_job")) { strategyClaims++; return { rows: [] }; }
      throw new Error("unexpected_synthetic_query");
    });
    fixture.end.mockResolvedValue(undefined);
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    await import("../../worker/index"); await vi.advanceTimersByTimeAsync(0);
    expect(reports).toBe(1); expect(strategyClaims).toBe(0);
    expect(fixture.end).not.toHaveBeenCalled(); expect(process.exitCode).toBe(priorExitCode);
    expect(JSON.parse(String(diagnostic.mock.calls[0]![0]))).toEqual({ event: "local_database_failure", at: expect.any(String), role: "strategy", operation: "readiness", sqlState: null, failureClass: "unknown" });
    expect(diagnostic.mock.calls[1]).toEqual(["Local Strategy readiness unavailable; retrying."]);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(reports).toBe(1); expect(strategyClaims).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(reports).toBeGreaterThanOrEqual(5); expect(strategyClaims).toBeGreaterThan(0);
    expect(fixture.end).not.toHaveBeenCalled(); expect(process.exitCode).toBe(priorExitCode);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("synthetic-private");
    fixture.clients[0]!.emit("error", new Error("synthetic cleanup"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.end).toHaveBeenCalledOnce();
  });
});
