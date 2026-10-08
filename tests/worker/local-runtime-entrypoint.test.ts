import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  const events: string[] = [];
  const logo = { refreshReadiness: vi.fn(), tick: vi.fn(), close: vi.fn() };
  return { events, logo, pool: { on: vi.fn(), removeListener: vi.fn(), end: vi.fn(async () => { events.push("text-pool-end"); }) },
    configuration: { status: "configured", names: [] }, host: vi.fn(async () => { events.push("host-finished"); }),
    text: { handle: vi.fn(), refreshReadiness: vi.fn(), tick: vi.fn(), close: vi.fn() },
    closeLogo: vi.fn(async () => { events.push("logo-pool-end"); }) };
});
vi.mock("pg", () => ({ Pool: class { constructor() { return mocks.pool; } } }));
vi.mock("../../scripts/local-environment.mjs", () => ({ localWorkerDatabaseConfiguration: () => ({}) }));
vi.mock("../../worker/local-chatgpt", () => ({ readLocalRuntimeConfiguration: () => ({}), createLocalChatGPTRuntime: () => mocks.text }));
vi.mock("../../worker/local-runtime-host", () => ({ runLocalRuntimeHost: mocks.host }));
vi.mock("../../worker/logo-concept-startup", () => ({ readProtectedLogoConceptConfiguration: vi.fn(async () => mocks.configuration),
  startLogoConceptWorker: vi.fn(async () => ({ status: "ready", runtime: mocks.logo, close: mocks.closeLogo })) }));
import { runLocalRuntime } from "../../worker/local-runtime";
import { startLogoConceptWorker } from "../../worker/logo-concept-startup";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); mocks.events.length = 0; });
describe("local CLI concept startup handoff", () => {
  it("passes the independently supplied logo runtime to the host and closes pools only after the host drains", async () => {
    vi.stubEnv("FLUID_WORKER_DATABASE_URL", "synthetic-text-database");
    const storage = { assertAvailable: async () => {}, authorize: async () => { throw new Error("unused"); } };
    await runLocalRuntime({ logoStorage: storage });
    expect(startLogoConceptWorker).toHaveBeenCalledWith({ configuration: mocks.configuration, storage });
    expect(mocks.host).toHaveBeenCalledWith(expect.objectContaining({ runtime: mocks.text, logoRuntime: mocks.logo }));
    expect(mocks.events).toEqual(["host-finished", "logo-pool-end", "text-pool-end"]);
  });
  it("uses protected configuration composition in the ordinary CLI and still closes after host failure", async () => {
    mocks.host.mockRejectedValueOnce(new Error("Synthetic host failure"));
    await expect(runLocalRuntime()).rejects.toThrow("Synthetic host failure");
    expect(startLogoConceptWorker).toHaveBeenCalledWith({ configuration: mocks.configuration, storage: undefined });
    expect(mocks.closeLogo).toHaveBeenCalledOnce();
  });
});
