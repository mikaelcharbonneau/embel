import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ attach: vi.fn(), constructed: vi.fn(), error: undefined as ((...args: unknown[]) => void) | undefined }));
vi.mock("@vercel/functions", () => ({ attachDatabasePool: mocks.attach }));
vi.mock("pg", () => ({ Pool: class {
  constructor(options: unknown) { mocks.constructed(options); }
  on(name: string, handler: (...args: unknown[]) => void) { if (name === "error") mocks.error = handler; }
} }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.error = undefined;
  vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("VERCEL_TARGET_ENV", "production");
  vi.stubEnv("VERCEL_PROJECT_ID", "prj_waP1hoGVtBiqJCTqTWKHfRy8iLMk"); vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_synthetic");
  vi.stubEnv("FLUID_WORKER_DATABASE_URL", undefined); vi.stubEnv("FLUID_WORKER_DATABASE_PASSWORD", "synthetic-password-not-a-credential");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("API worker Fluid database lifecycle", () => {
  it("attaches exactly once to each qualified module-scoped Pool and reuses it", async () => {
    const { workerDatabase } = await import("../../services/api-text-worker/runtime");
    const pool = workerDatabase(); expect(workerDatabase()).toBe(pool); expect(workerDatabase()).toBe(pool);
    expect(mocks.constructed).toHaveBeenCalledTimes(1); expect(mocks.attach).toHaveBeenCalledExactlyOnceWith(pool);
    expect(mocks.constructed.mock.calls[0]?.[0]).toMatchObject({ max: 3, ssl: { rejectUnauthorized: true }, idleTimeoutMillis: 10_000, allowExitOnIdle: true });
  });
  it("never creates or attaches a pool before worker identity and connection validation", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_unqualified");
    const { workerDatabase } = await import("../../services/api-text-worker/runtime");
    expect(() => workerDatabase()).toThrow("Unqualified worker environment");
    expect(mocks.constructed).not.toHaveBeenCalled(); expect(mocks.attach).not.toHaveBeenCalled();
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_waP1hoGVtBiqJCTqTWKHfRy8iLMk"); vi.stubEnv("FLUID_WORKER_DATABASE_PASSWORD", undefined);
    expect(() => workerDatabase()).toThrow("Worker database unavailable");
    expect(mocks.constructed).not.toHaveBeenCalled(); expect(mocks.attach).not.toHaveBeenCalled();
  });
  it("revalidates identity before returning an already attached pool", async () => {
    const { workerDatabase } = await import("../../services/api-text-worker/runtime"); workerDatabase();
    vi.stubEnv("VERCEL_ENV", "preview"); expect(() => workerDatabase()).toThrow("Unqualified worker environment");
    expect(mocks.constructed).toHaveBeenCalledTimes(1); expect(mocks.attach).toHaveBeenCalledTimes(1);
  });
  it("contains idle-client errors and logger failure without aborting independent work or leaking context", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const { workerDatabase } = await import("../../services/api-text-worker/runtime"); const pool = workerDatabase();
    const active = new AbortController();
    const secret = "SYNTHETIC_PRIVATE_IDLE_ERROR";
    expect(() => mocks.error?.(Object.assign(new Error(secret), { client: { password: secret } }), { password: secret })).not.toThrow();
    expect(active.signal.aborted).toBe(false); expect(workerDatabase()).toBe(pool);
    expect(log).toHaveBeenCalledTimes(1); expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.parse(log.mock.calls[0]?.[0])).toMatchObject({ phase: "database_idle", outcome: "error", errorClass: "database" });
    log.mockImplementation(() => { throw new Error("synthetic log failure"); });
    expect(() => mocks.error?.(new Error(secret))).not.toThrow(); expect(active.signal.aborted).toBe(false);
    expect(mocks.attach).toHaveBeenCalledTimes(1);
  });
});
