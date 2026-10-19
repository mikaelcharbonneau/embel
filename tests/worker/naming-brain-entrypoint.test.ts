import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const fixture = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn() }));
vi.mock("pg", () => ({ Pool: class { query = fixture.query; end = fixture.end; on() { return this; } removeListener() { return this; } } }));
vi.mock("../../src/server/ai/config", () => ({ readOpenAIStrategyConfiguration: () => null }));
vi.mock("../../worker/naming-brain-configuration", async importOriginal => {
  const actual = await importOriginal<typeof import("../../worker/naming-brain-configuration")>();
  return { ...actual, readNamingBrainConfiguration: () => actual.readNamingBrainConfiguration({ FLUID_NAMING_BRAIN_ENABLED: "true", FLUID_PAID_CALLS_APPROVED: "true", OPENAI_API_KEY: "synthetic-fixture-key", FLUID_NAMING_BRAIN_MODEL: "synthetic", FLUID_OPENAI_VERIFIED_MODELS: "synthetic", FLUID_NAMING_BRAIN_DATABASE_URL: "postgresql://synthetic.invalid/fixture", FLUID_NAMING_BRAIN_DEPLOYMENT_ID: "fixture" }) };
});
const priorExitCode = process.exitCode;
afterEach(() => { process.exitCode = priorExitCode; vi.restoreAllMocks(); });
it("closes the dedicated pool when initial preference attestation fails before readiness setup", async () => {
  fixture.query.mockRejectedValue(new Error("synthetic_missing_migration")); fixture.end.mockResolvedValue(undefined);
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  await import("../../worker/index");
  await vi.waitFor(() => expect(fixture.end).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(fixture.query).toHaveBeenCalledOnce(); expect(fixture.query.mock.calls[0]![0]).toContain("get_naming_brain_preference_work");
  expect(diagnostic).toHaveBeenCalledWith("Worker stopped after a database or configuration failure. Check private operational diagnostics.");
});
