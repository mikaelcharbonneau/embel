import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { LogoWorkerConnection } from "../../src/server/data/logo-jobs";
import { syntheticLogoJob } from "../fixtures/logo-creation";
import { createLogoReadiness, freezeLogoWorkerManifest } from "../../worker/logo-readiness";
import { IMAGE_MODEL } from "../../src/domain/providers";

const capability = () => ({ operation: "identity.logo_concept" as const, policyIdentity: "c".repeat(64), handlerVersion: "logo-image-v1", provider: "openai", model: IMAGE_MODEL, engine: null, maxCostMicrousd: 2000 });
function fixture() {
  const query = vi.fn(async (sql: string, parameters?: unknown[]) => { void sql; void parameters; return { rows: [{ value: true }] }; });
  const connection = { query } as unknown as LogoWorkerConnection;
  const readiness = createLogoReadiness({ connection, workerId: "logo-fixture", manifest: [capability()], readinessSeconds: 30 });
  return { query, connection, readiness };
}
afterEach(() => vi.useRealTimers());
describe("restricted logo readiness reporter", () => {
  it("constructs without queries and freezes an independent strict manifest", () => {
    const input = [capability()], frozen = freezeLogoWorkerManifest(input);
    input[0]!.policyIdentity = "d".repeat(64);
    expect(frozen[0]!.policyIdentity).toBe("c".repeat(64));
    expect(Object.isFrozen(frozen)).toBe(true); expect(Object.isFrozen(frozen[0])).toBe(true);
    const f = fixture(); expect(f.query).not.toHaveBeenCalled(); expect(f.readiness.isReady()).toBe(false);
  });
  it.each([
    [{ ...capability(), unexpected: true }], [capability(), capability()],
    [{ ...capability(), operation: "strategy.generate" }], [{ ...capability(), engine: { id: "x", version: "1", artifactHash: "a".repeat(64), extra: true } }],
    [{ ...capability(), maxCostMicrousd: Number.MAX_SAFE_INTEGER + 1 }],
  ].map(value => ({ value })))("rejects malformed, duplicate or foreign descriptor input %#", ({ value }) => {
    expect(() => freezeLogoWorkerManifest(value)).toThrow();
  });
  it("reports exactly the frozen manifest and checks leased readiness only for a matching job", async () => {
    const f = fixture(), job = syntheticLogoJob();
    expect(await f.readiness.refresh()).toBe(true);
    expect(f.query.mock.calls[0]).toEqual(["select public.report_logo_worker_ready($1,$2,$3) value", ["logo-fixture", JSON.stringify([capability()]), 30]]);
    await expect(f.readiness.assertReady(job)).resolves.toBeUndefined();
    expect(f.query.mock.calls[1]).toEqual(["select public.read_leased_logo_record($1,$2,'runtime_readiness',null) value", [job.id, job.leaseToken]]);
  });
  it("fails closed before dispatch for missing, false, malformed or multiple-row replies", async () => {
    for (const rows of [[], [{ value: false }], [{ value: "true" }], [{ value: true }, { value: true }]]) {
      const f = fixture(); f.query.mockResolvedValueOnce({ rows } as { rows: { value: boolean }[] });
      expect(await f.readiness.refresh()).toBe(false);
      await expect(f.readiness.assertReady(syntheticLogoJob())).rejects.toThrow("Logo runtime is unavailable");
      expect(f.query).toHaveBeenCalledTimes(1);
    }
  });
  it("withdraws local readiness after report failure and restores it only on acknowledged refresh", async () => {
    const f = fixture(); await f.readiness.refresh();
    f.query.mockRejectedValueOnce(new Error("private database error"));
    expect(await f.readiness.refresh()).toBe(false); expect(f.readiness.isReady()).toBe(false);
    await expect(f.readiness.assertReady(syntheticLogoJob())).rejects.toThrow("Logo runtime is unavailable");
    expect(await f.readiness.refresh()).toBe(true);
  });
  it("expires a delayed report conservatively from its start time and coalesces concurrent reports", async () => {
    vi.useFakeTimers(); const f = fixture();
    let respond!: (value: { rows: { value: boolean }[] }) => void;
    f.query.mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
    const first = f.readiness.refresh(), second = f.readiness.refresh();
    expect(f.query).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(30_001);
    respond({ rows: [{ value: true }] }); expect(await first).toBe(false); expect(await second).toBe(false);
  });
  it("rejects policy, version, operation and reservation mismatches before any leased query", async () => {
    const f = fixture(); await f.readiness.refresh(); const job = syntheticLogoJob();
    for (const changed of [{ ...job, operation: "identity.logo_refine" }, { ...job, reservedCostMicrousd: 2001 }, { ...job, input: { ...job.input as object, policyIdentity: "d".repeat(64) } }, { ...job, input: { ...job.input as object, handlerVersion: "other" } }]) {
      await expect(f.readiness.assertReady(changed)).rejects.toThrow("Logo runtime is unavailable");
    }
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it("does not accept an unacknowledged leased check or a readiness loss during it", async () => {
    const f = fixture(); await f.readiness.refresh(); f.query.mockResolvedValueOnce({ rows: [{ value: false }] });
    await expect(f.readiness.assertReady(syntheticLogoJob())).rejects.toThrow("Logo runtime is unavailable");
    expect(f.readiness.isReady()).toBe(false);
  });
  it("recovers after a synchronously throwing connection without pinning a settled refresh", async () => {
    const f = fixture(); f.query.mockImplementationOnce(() => { throw new Error("Disconnected"); });
    expect(await f.readiness.refresh()).toBe(false);
    expect(await f.readiness.refresh()).toBe(true); expect(f.query).toHaveBeenCalledTimes(2);
  });
  it("never revives a closed reporter from an in-flight response", async () => {
    const f = fixture(); let respond!: (value: { rows: { value: boolean }[] }) => void;
    f.query.mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
    const pending = f.readiness.refresh(); f.readiness.close(); respond({ rows: [{ value: true }] });
    expect(await pending).toBe(false); expect(await f.readiness.refresh()).toBe(false); expect(f.query).toHaveBeenCalledTimes(1);
  });
});
