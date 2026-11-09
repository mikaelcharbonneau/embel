import type { EventEmitter } from "node:events";
import type { StrategyJobPolicy, StrategyOperation } from "../../src/domain/strategy-jobs";
import type { OpenAIStrategyConfiguration } from "../../src/server/ai/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guidedJobFixture } from "./guided-strategy-fixtures";
import { transportFixture } from "../server/openai-fixtures";
vi.mock("server-only", () => ({}));
const fixture = vi.hoisted(() => ({ clients: [] as EventEmitter[], query: vi.fn(), end: vi.fn(), run: vi.fn(),
  configuration: null as OpenAIStrategyConfiguration | null,
  gate: undefined as ((operation: StrategyOperation, policy: StrategyJobPolicy) => Promise<void>) | undefined }));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  return { Pool: class extends EventEmitter { constructor() { super(); fixture.clients.push(this); } query = fixture.query; end = fixture.end;
    connect = async () => ({ query: (sql: string, values?: unknown[]) => /^(?:BEGIN|SET LOCAL|COMMIT|ROLLBACK)/u.test(sql) ? Promise.resolve({ rows: [] }) : fixture.query(sql, values), release() {} }); } };
});
vi.mock("../../worker/runner", async importOriginal => ({ ...await importOriginal<typeof import("../../worker/runner")>(), runOneJob: fixture.run }));
vi.mock("../../worker/handlers/openai-strategy", async importOriginal => {
  const original = await importOriginal<typeof import("../../worker/handlers/openai-strategy")>();
  return { ...original, createOpenAIStrategyHandlers: (...args: Parameters<typeof original.createOpenAIStrategyHandlers>) => {
    fixture.configuration = args[0]; fixture.gate = args[2]; return original.createOpenAIStrategyHandlers(...args);
  } };
});
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
  fixture.clients.length = 0; fixture.query.mockReset(); fixture.end.mockReset(); fixture.run.mockReset(); fixture.configuration = null; fixture.gate = undefined;
});

async function start(local = true) {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const model = local ? "gpt-6-luna" : "gpt-6.1-sol";
  const databaseUrl = "postgresql://fluid_naming_brain_worker.fricsfwqibyhemknqgyf:synthetic-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full";
  for (const [key, value] of Object.entries({ OPENAI_API_KEY: "synthetic-prototype-key", FLUID_OPENAI_VERIFIED_MODELS: model, FLUID_PAID_CALLS_APPROVED: "true",
    FLUID_LOCAL_PROTOTYPE: String(local), FLUID_RUNTIME: "local", NODE_ENV: "production", APP_ORIGIN: "http://127.0.0.1:3106", FLUID_WORKER_DATABASE_URL: databaseUrl, FLUID_GUIDED_INTERVIEW_ENABLED: "true",
    FLUID_TEXT_MODEL_REFORMULATE: model, FLUID_TEXT_MODEL_COMPETITORS: model, FLUID_TEXT_MODEL_AUDIENCE: model, FLUID_TEXT_MODEL_PERSONALITY: model })) vi.stubEnv(key, value);
  let readiness: "ready" | "false" | "error" = "ready", reports = 0, blocked = false;
  let release: (() => void) | undefined;
  const claims = { strategy: [] as number[] }, expiry = { strategy: 0 };
  fixture.query.mockImplementation(async (sql: string) => {
    if (sql.includes("report_strategy_worker_ready")) {
      reports++;
      if (blocked) { blocked = false; return new Promise(resolve => { release = () => resolve({ rows: [{ ready: true }] }); }); }
      if (readiness === "error") throw new Error("synthetic-private-readiness-error");
      return { rows: [{ ready: readiness === "ready" }] };
    }
    if (sql.includes("public.expire_job_leases")) { expiry.strategy++; return { rows: [{ count: 0 }] }; }
    throw new Error("unexpected_synthetic_query");
  });
  fixture.run.mockImplementation(async () => { claims.strategy.push(Date.now()); return "idle"; });
  fixture.end.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {});
  const signals = vi.spyOn(process, "once");
  await import("../../worker/index"); await vi.advanceTimersByTimeAsync(0);
  shutdown = signals.mock.calls.find(([name]) => name === "SIGTERM")?.[1] as (() => void) | undefined;
  expect(shutdown).toBeTypeOf("function");
  return { claims, expiry, reports: () => reports,
    setReadiness: (value: typeof readiness) => { readiness = value; }, blockNextReport: () => { blocked = true; }, release: () => { release!(); } };
}

describe("strict local idle database load", () => {
  it("reuses only a 20-second acknowledged report while polling idle work every 5 seconds", async () => {
    const state = await start();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(state.reports()).toBe(4);
    expect(state.claims.strategy).toEqual([0, 5_000, 10_000, 15_000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.reports()).toBe(8);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(state.reports()).toBe(16);
    expect(state.claims.strategy).toHaveLength(13);
    expect(state.expiry).toEqual({ strategy: 7 });
    expect(fixture.end).not.toHaveBeenCalled();
  });

  it("shares an in-flight real report between timer and claim instead of overlapping groups", async () => {
    const state = await start(); state.blockNextReport();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(state.reports()).toBe(5); expect(state.claims.strategy).toHaveLength(4);
    state.release(); await vi.advanceTimersByTimeAsync(0);
    expect(state.reports()).toBe(8); expect(state.claims.strategy).toHaveLength(5);
  });

  it.each(["false", "error"] as const)("invalidates cached readiness after a real paid-dispatch %s without issuing a provider request", async result => {
    const state = await start(); state.setReadiness(result);
    const original = await vi.importActual<typeof import("../../worker/handlers/openai-strategy")>("../../worker/handlers/openai-strategy");
    const transport = transportFixture(), base = guidedJobFixture();
    const policy = fixture.configuration!.policies.get("strategy.competitors")!;
    const job = { ...base, input: { ...base.input, policy, acceptedMaxCostMicrousd: policy.maximumCostMicrousd }, reservedCostMicrousd: policy.maximumCostMicrousd };
    const handlers = original.createOpenAIStrategyHandlers(fixture.configuration, transport, fixture.gate);
    expect(await handlers.get(job.operation)!.steps(job)[0]!.execute({ job, signal: new AbortController().signal })).toMatchObject({ status: "failed", code: "runtime_policy_unavailable" });
    expect(transport.countInputTokens).not.toHaveBeenCalled(); expect(transport.createResponse).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.claims.strategy).toHaveLength(1);
    expect(fixture.end).not.toHaveBeenCalled();
    state.setReadiness("ready"); await vi.advanceTimersByTimeAsync(25_000);
    expect(state.claims.strategy.length).toBeGreaterThan(1);
  });

  it("does not restore an older report group after a concurrent dispatch refusal", async () => {
    const state = await start(); state.blockNextReport(); await vi.advanceTimersByTimeAsync(20_000);
    state.setReadiness("false");
    await expect(fixture.gate!("strategy.competitors", fixture.configuration!.policies.get("strategy.competitors")!)).rejects.toThrow("Strategy policy unavailable");
    state.setReadiness("ready"); state.release(); await vi.advanceTimersByTimeAsync(5_000);
    expect(state.claims.strategy).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(20_000); expect(state.claims.strategy.length).toBeGreaterThan(4);
  });

  it("keeps native idle polling at 1 second with uncached readiness", async () => {
    const state = await start(false); await vi.advanceTimersByTimeAsync(4_000);
    expect(state.claims.strategy).toEqual([0, 1_000, 2_000, 3_000, 4_000]);
    expect(state.reports()).toBe(24);
    expect(state.expiry).toEqual({ strategy: 5 });
  });

  it("cancels local idle waits on explicit shutdown without another scan or claim", async () => {
    const state = await start(); const calls = fixture.query.mock.calls.length;
    shutdown!(); await vi.advanceTimersByTimeAsync(60_000);
    expect(state.claims.strategy).toEqual([0]);
    expect(fixture.query).toHaveBeenCalledTimes(calls); expect(fixture.end).toHaveBeenCalledOnce();
  });
});
