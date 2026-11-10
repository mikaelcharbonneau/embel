import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("../../src/server/api-text/publication", () => ({ publishApiTextDispatch: vi.fn() }));
import { isLocalPollingRuntime, isLocalPrototypeRuntime } from "../../src/server/api-text/config";
import { getStrategyAvailability, retryStrategyJobDelivery } from "../../src/server/data/strategy-jobs";
import { isLocalLogoRuntime } from "../../src/server/logo-creation/local-runtime";
import type { AuthenticatedContext } from "../../src/server/auth/context";

const local = { NODE_ENV: "development", EMBEL_DEVELOPMENT_ENABLED: "true", APP_ORIGIN: "http://127.0.0.1:3105", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" };
const project = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const job = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("isolated development polling route", () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(local)) vi.stubEnv(name, value);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the historical prototype guard unchanged and chooses local SQL", async () => {
    expect(isLocalPrototypeRuntime(local)).toBe(false);
    expect(isLocalPollingRuntime(local)).toBe(true);
    expect(isLocalLogoRuntime(local)).toBe(true);
    expect(isLocalLogoRuntime({ ...local, NODE_ENV: "production" })).toBe(false);
    expect(isLocalLogoRuntime({ ...local, VERCEL: "1" })).toBe(false);
    const rpc = vi.fn().mockResolvedValue({ data: { status: "unavailable", operations: [], reason: "worker_unavailable" }, error: null });
    const auth = { userId: project, client: { rpc } } as unknown as AuthenticatedContext;
    expect(await getStrategyAvailability(auth, project)).toMatchObject({ status: "unavailable" });
    expect(rpc).toHaveBeenCalledWith("get_local_strategy_availability", { p_project_id: project });
    await expect(retryStrategyJobDelivery(auth, project, job)).rejects.toMatchObject({ code: "conflict" });
    // The only other read is the generation engine's switch, which stays off here.
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["get_generation_catalog", "get_local_strategy_availability"]);
  });

  it("does not change default or hosted routing", async () => {
    vi.stubEnv("EMBEL_DEVELOPMENT_ENABLED", "false");
    const rpc = vi.fn().mockResolvedValue({ data: { status: "unavailable", operations: [], reason: "worker_unavailable" }, error: null });
    const auth = { userId: project, client: { rpc } } as unknown as AuthenticatedContext;
    await getStrategyAvailability(auth, project);
    expect(rpc).toHaveBeenCalledWith("get_strategy_availability", { p_project_id: project });
    expect(isLocalPollingRuntime({ ...local, NODE_ENV: "production" })).toBe(false);
    expect(isLocalPollingRuntime({ ...local, VERCEL: "1" })).toBe(false);
  });
});
