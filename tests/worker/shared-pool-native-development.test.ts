import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevelopmentSharedLogoProductionRuntimeQualification } from "../../worker/shared-pool/logo-native-qualification";
import * as source from "../../worker/logo-production-qualification";
import * as gate from "../../src/server/development/config";
import type { LogoWorkerCapability } from "../../worker/logo-readiness";
vi.mock("server-only", () => ({}));
vi.mock("../../worker/logo-production-qualification", () => ({ createLogoProductionRuntimeQualification: vi.fn(), preflightLogoProductionRuntimeInstallation: vi.fn(async () => {}) }));
vi.mock("../../src/server/development/config", () => ({ readDevelopmentConfiguration: vi.fn(() => ({ supabaseUrl: "http://127.0.0.1:54321", origin: "http://127.0.0.1:3100" })) }));
const capability: LogoWorkerCapability = { operation: "identity.logo_vectorize", handlerVersion: "1", policyIdentity: "a".repeat(64), provider: null, model: null, maxCostMicrousd: 0,
  engine: { id: "vtracer", version: "1.0.0-alpha.4", artifactHash: "63716b70497b7468ef97545b50f5f34b8bbb7acde2d7b00deb4eb40781446d45" } };
const first = "00000000-0000-4000-8000-000000000001", second = "00000000-0000-4000-8000-000000000002", workerId = "native-development-unit";
afterEach(() => { vi.clearAllMocks(); vi.mocked(gate.readDevelopmentConfiguration).mockReturnValue({ supabaseUrl: "http://127.0.0.1:54321", origin: "http://127.0.0.1:3100" }); });
describe("explicit development native probe lifecycle (mocked source probes)", () => {
  it("refuses absent development qualification instead of falling back from production", () => {
    vi.mocked(gate.readDevelopmentConfiguration).mockReturnValue(null);
    expect(() => createDevelopmentSharedLogoProductionRuntimeQualification({ workerId, capabilities: [capability] })).toThrow("unavailable");
    expect(source.createLogoProductionRuntimeQualification).not.toHaveBeenCalled();
  });
  it("preflights without a dummy owner and drains a new exact-owner source probe per assertion", async () => {
    const probes: { assertRuntimeAvailable: ReturnType<typeof vi.fn>; invalidate: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
    vi.mocked(source.createLogoProductionRuntimeQualification).mockImplementation(() => { const probe = { assertRuntimeAvailable: vi.fn(async () => {}), invalidate: vi.fn(), close: vi.fn(async () => {}) }; probes.push(probe); return probe; });
    const qualification = createDevelopmentSharedLogoProductionRuntimeQualification({ workerId, capabilities: [capability] });
    await qualification.preflight();
    expect(source.preflightLogoProductionRuntimeInstallation).toHaveBeenCalledTimes(1);
    expect(source.createLogoProductionRuntimeQualification).not.toHaveBeenCalled();
    for (const ownerId of [first, second]) await qualification.assertRuntimeAvailable({ ownerId, workerId, capability });
    expect(vi.mocked(source.createLogoProductionRuntimeQualification).mock.calls.map(([input]) => input.ownerId)).toEqual([first, second]);
    expect(probes.every(probe => probe.close.mock.calls.length === 1)).toBe(true);
    await qualification.close();
  });
  it("holds the single active fence and shutdown until the real source probe drains", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), entered = vi.fn();
    const probe = { assertRuntimeAvailable: vi.fn(async () => { entered(); await held; }), invalidate: vi.fn(), close: vi.fn(async () => {}) };
    vi.mocked(source.createLogoProductionRuntimeQualification).mockReturnValue(probe);
    const qualification = createDevelopmentSharedLogoProductionRuntimeQualification({ workerId, capabilities: [capability] });
    const running = qualification.assertRuntimeAvailable({ ownerId: first, workerId, capability }).catch(error => error);
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    await expect(qualification.assertRuntimeAvailable({ ownerId: second, workerId, capability })).rejects.toThrow("unavailable");
    qualification.invalidate();
    const closing = qualification.close(); let closed = false; void closing.then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    release(); await closing; expect(await running).toBeInstanceOf(Error);
    expect(probe.close).toHaveBeenCalledOnce();
    expect(source.createLogoProductionRuntimeQualification).toHaveBeenCalledTimes(1);
  });
});
