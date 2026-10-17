import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readNamingBrainConfiguration, startNamingReadiness } from "../../worker/naming-brain-configuration";
describe("Naming independent configuration and readiness", () => {
  it("requires explicit Naming configuration and never borrows Strategy permissions", () => {
    expect(readNamingBrainConfiguration({ FLUID_PAID_CALLS_APPROVED: "true", OPENAI_API_KEY: "synthetic-fixture-key", FLUID_TEXT_MODEL_STRATEGY: "fixture" })).toBeNull();
    const config = readNamingBrainConfiguration({ FLUID_PAID_CALLS_APPROVED: "true", FLUID_NAMING_BRAIN_ENABLED: "true", OPENAI_API_KEY: "synthetic-fixture-key", FLUID_NAMING_BRAIN_MODEL: "fixture", FLUID_OPENAI_VERIFIED_MODELS: "fixture", FLUID_NAMING_BRAIN_DATABASE_URL: "postgresql://synthetic.invalid/database", FLUID_NAMING_BRAIN_DEPLOYMENT_ID: "fixture-deployment" });
    expect(config?.policy.model).toBe("fixture"); expect(config?.policy.protocol).toBe("openai_agents");
  });
  it("refreshes readiness during long stages independently of lease heartbeat", async () => {
    vi.useFakeTimers(); let refreshes = 0, stopped = false;
    const readiness = await startNamingReadiness(async () => { refreshes++; return true; }, () => { stopped = true; });
    await vi.advanceTimersByTimeAsync(65_000); expect(refreshes).toBe(4); expect(stopped).toBe(false);
    await readiness.stop(); await vi.advanceTimersByTimeAsync(60_000); expect(refreshes).toBe(4); vi.useRealTimers();
  });
});

describe("Naming observation remains available", () => {
  it("keeps observation alive when readiness is disabled, while rejecting paid work", async () => {
    vi.useFakeTimers(); let ready = false;
    const gate = await startNamingReadiness(async () => ready);
    await expect(gate.assertReady()).rejects.toThrow("naming_readiness_unavailable");
    await vi.advanceTimersByTimeAsync(65_000);
    ready = true; await expect(gate.assertReady()).resolves.toBeUndefined();
    await gate.stop(); vi.useRealTimers();
  });
});
