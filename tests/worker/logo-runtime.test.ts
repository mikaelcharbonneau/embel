import { createHash } from "node:crypto";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createLogoWorkerRuntime, type LogoWorkerRuntimeInput } from "../../worker/logo-runtime";
import type { LogoWorkerConnection } from "../../src/server/data/logo-jobs";
import type { LogoOperationCompositionInput } from "../../worker/logo-operation-composition";
import type { LogoImageProductionResult } from "../../src/server/ai/logo-image-prompts";
import { CAPPED_LOGO_IMAGE_MODEL } from "../../src/domain/providers";
import { logoFixtureId as id, syntheticLogoJob, syntheticResolvedLogoConcept } from "../fixtures/logo-creation";
const empty = (): LogoOperationCompositionInput => ({ concepts: null, refinements: null, vector: null, directions: null, exports: null, unavailableReasons: {} });
const descriptor = () => ({ operation: "identity.logo_concept" as const, policyIdentity: "c".repeat(64), handlerVersion: "logo-image-v1", provider: "openai", model: CAPPED_LOGO_IMAGE_MODEL, engine: null, maxCostMicrousd: 2000 });
const notDispatched: LogoImageProductionResult = { status: "not_dispatched", code: "unavailable", providerRequestId: null, responseHash: null, billing: { status: "recorded", confirmedMicrousd: 0 } };
function fixture() {
  const job = syntheticLogoJob(), input = syntheticResolvedLogoConcept(), events: string[] = [];
  const row = { id: job.id, owner_id: job.ownerId, project_id: job.projectId, operation: job.operation, input: job.input, input_revision: job.inputRevision, lease_token: job.leaseToken, state: job.status, reserved_cost_microusd: job.reservedCostMicrousd, actual_cost_microusd: job.actualCostMicrousd };
  let report = true, dispatch = true, completed = false, expiryFailure = false;
  const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
    void parameters;
    if (sql.includes("report_logo_worker_ready")) { events.push("report"); return { rows: [{ value: report }] }; }
    if (sql.includes("expire_logo_job_leases")) { events.push("expire"); if (expiryFailure) throw new Error("Expiry unavailable"); return { rows: [{ value: 0 }] }; }
    if (sql.includes("claim_logo_job")) { events.push("claim"); return { rows: [row] }; }
    if (sql.includes("heartbeat_logo_job")) return { rows: [row] };
    if (sql.includes("runtime_readiness")) { events.push("dispatch-check"); return { rows: [{ value: dispatch }] }; }
    if (sql.includes("begin_logo_job_step")) return { rows: [{ value: completed ? "already_succeeded" : "started" }] };
    if (sql.includes("complete_logo_job_step")) events.push("complete");
    if (sql.includes("finish_logo_job")) events.push("finish");
    return { rows: [] };
  });
  const never = async (): Promise<never> => { throw new Error("Unused fixture capability"); };
  const produce = vi.fn(async (): Promise<LogoImageProductionResult> => { events.push("produce"); return notDispatched; });
  const guard = vi.fn(async () => { events.push("existing-guard"); });
  const composition: LogoOperationCompositionInput = { ...empty(), concepts: { model: CAPPED_LOGO_IMAGE_MODEL, producer: { produce }, assets: { readLeasedAsset: never, publishLeasedAsset: never, readOwnedAsset: never, stageOwnedAsset: never, publishOwnedUpload: never }, resolveInputs: async () => input, recordProviderResponse: never, assertPolicyReady: guard } };
  const options: LogoWorkerRuntimeInput = { connection: { query } as unknown as LogoWorkerConnection, workerId: "synthetic-logo-worker", composition, manifest: [descriptor()] };
  return { job, events, query, produce, guard, options, setReport: (value: boolean) => { report = value; }, setDispatch: (value: boolean) => { dispatch = value; }, setCompleted: () => { completed = true; }, setExpiryFailure: (value: boolean) => { expiryFailure = value; } };
}
afterEach(() => vi.useRealTimers());
describe("injected logo runtime", () => {
  it("does no I/O on construction and omits missing dependencies from its frozen report", async () => {
    const f = fixture(), runtime = createLogoWorkerRuntime({ ...f.options, composition: empty() });
    expect(runtime.manifest).toEqual([]); expect(Object.values(runtime.capabilities).every(value => value.status === "unavailable")).toBe(true);
    expect(await runtime.tick()).toBe("idle"); expect(f.query).not.toHaveBeenCalled(); expect(f.produce).not.toHaveBeenCalled();
    runtime.close();
  });
  it("requires complete constructed adapters and a matching pinned manifest before advertising an operation", () => {
    const f = fixture();
    for (const composition of [empty(), { ...f.options.composition, concepts: { ...f.options.composition.concepts!, producer: {} } }]) {
      const runtime = createLogoWorkerRuntime({ ...f.options, composition: composition as LogoOperationCompositionInput });
      expect(runtime.manifest).toEqual([]); expect(runtime.capabilities["identity.logo_concept"].status).toBe("unavailable"); runtime.close();
    }
    for (const manifest of [[], [{ ...descriptor(), handlerVersion: "unsupported" }], [{ ...descriptor(), model: "text-subscription" }]]) {
      const runtime = createLogoWorkerRuntime({ ...f.options, manifest });
      expect(runtime.manifest).toEqual([]); runtime.close();
    }
    expect(f.query).not.toHaveBeenCalled();
  });
  it("rejects unusable timing before it could advertise a worker", () => {
    const f = fixture();
    for (const options of [{ readinessSeconds: 0 }, { readinessSeconds: 91 }, { readinessSeconds: 1, refreshMs: 1000 }, { runner: { leaseSeconds: 9 } }, { runner: { heartbeatMs: 60_000 } }, { runner: { abortGraceMs: 30_001 } }]) {
      expect(() => createLogoWorkerRuntime({ ...f.options, ...options })).toThrow();
    }
    expect(f.query).not.toHaveBeenCalled();
  });
  it("expires abandoned logo leases before claiming on the same connection and chains the real predispatch guard", async () => {
    const f = fixture(), runtime = createLogoWorkerRuntime(f.options);
    expect(f.query).not.toHaveBeenCalled(); expect(runtime.manifest).toEqual([descriptor()]);
    expect(await runtime.tick()).toBe("failed");
    expect(f.events).toEqual(["report", "expire", "claim", "existing-guard", "dispatch-check", "produce", "complete", "finish"]);
    expect(f.query.mock.calls.find(([sql]) => sql.includes("claim_logo_job"))?.[1]).toEqual(["synthetic-logo-worker", 120]); runtime.close();
  });
  it("does not claim after an unacknowledged or failed report, and retries reporting before later work", async () => {
    const f = fixture(), runtime = createLogoWorkerRuntime(f.options); f.setReport(false);
    expect(await runtime.tick()).toBe("idle"); expect(f.events).toEqual(["report"]);
    f.setReport(true); expect(await runtime.tick()).toBe("failed"); expect(f.events.slice(0, 4)).toEqual(["report", "report", "expire", "claim"]); runtime.close();
  });
  it("does not claim when lease expiry fails and releases tick ownership for a later cycle", async () => {
    const f = fixture(), runtime = createLogoWorkerRuntime(f.options); f.setExpiryFailure(true);
    await expect(runtime.tick()).rejects.toThrow("Expiry unavailable");
    expect(f.events).toEqual(["report", "expire"]); expect(f.produce).not.toHaveBeenCalled();
    f.setExpiryFailure(false); expect(await runtime.tick()).toBe("failed");
    expect(f.events.slice(0, 5)).toEqual(["report", "expire", "report", "expire", "claim"]); runtime.close();
  });
  it.each(["close", "abort"] as const)("does not claim after %s while lease expiry is pending", async action => {
    const f = fixture(), controller = new AbortController(), original = f.query.getMockImplementation()!;
    let expired!: (result: { rows: { value: number }[] }) => void, started!: () => void;
    const expiring = new Promise<void>(resolve => { started = resolve; });
    f.query.mockImplementation((sql, parameters) => {
      if (sql.includes("expire_logo_job_leases")) { started(); return new Promise(resolve => { expired = resolve; }); }
      return original(sql, parameters);
    });
    const runtime = createLogoWorkerRuntime(f.options), pending = runtime.tick(controller.signal); await expiring;
    if (action === "close") runtime.close(); else controller.abort();
    expired({ rows: [{ value: 0 }] }); expect(await pending).toBe("idle");
    expect(f.events).toEqual(["report"]); expect(f.produce).not.toHaveBeenCalled(); runtime.close();
  });
  it("blocks new provider work when leased readiness disappears, while retaining the safe failure", async () => {
    const f = fixture(), runtime = createLogoWorkerRuntime(f.options); f.setDispatch(false);
    expect(await runtime.tick()).toBe("failed"); expect(f.produce).not.toHaveBeenCalled(); expect(f.events.slice(-2)).toEqual(["complete", "finish"]); runtime.close();
  });
  it("does not re-run predispatch guards for an already recorded successful step", async () => {
    const f = fixture(), runtime = createLogoWorkerRuntime(f.options); f.setCompleted(); f.setDispatch(false);
    expect(await runtime.tick()).toBe("succeeded"); expect(f.guard).not.toHaveBeenCalled(); expect(f.produce).not.toHaveBeenCalled();
    expect(f.events).toEqual(["report", "expire", "claim", "finish"]); runtime.close();
  });
  it("refreshes during an in-flight attempt and a failed refresh never prevents its recorded completion", async () => {
    vi.useFakeTimers(); const f = fixture(); let respond!: (value: LogoImageProductionResult) => void;
    const dispatched = new Promise<void>(resolve => { f.produce.mockImplementationOnce(() => { resolve(); return new Promise(done => { respond = done; }); }); });
    const runtime = createLogoWorkerRuntime({ ...f.options, readinessSeconds: 30, refreshMs: 1000 });
    const tick = runtime.tick(); await dispatched; f.setReport(false); await vi.advanceTimersByTimeAsync(1000);
    expect(f.events.filter(event => event === "report")).toHaveLength(2);
    respond({ status: "needs_reconciliation", code: "outcome_unknown", providerRequestId: null, responseHash: null, billing: { status: "unknown", confirmedMicrousd: null } });
    expect(await tick).toBe("needs_reconciliation"); expect(f.events.at(-1)).toBe("complete");
    expect(await runtime.tick()).toBe("idle"); expect(f.events.filter(event => event === "claim")).toHaveLength(1);
    runtime.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it("retains actual response evidence and raster publication after readiness is lost after dispatch", async () => {
    const f = fixture(), png = new Uint8Array(await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#222222" } }).png().toBuffer());
    const deps = f.options.composition.concepts!;
    deps.recordProviderResponse = vi.fn(async (job, observation) => ({ ...observation, id: id(801), ownerId: job.ownerId, projectId: job.projectId, jobId: job.id, leaseToken: job.leaseToken }));
    deps.assets.publishLeasedAsset = vi.fn<typeof deps.assets.publishLeasedAsset>(async (job, publication, bytes) => ({ id: id(802), reference: { ownerId: job.ownerId, projectId: job.projectId, assetId: id(803), versionId: id(804), contentHash: createHash("sha256").update(bytes).digest("hex") }, verification: { status: "verified", checkedAt: "2026-10-07T00:00:00Z", contentHash: publication.contentHash, mimeType: publication.mimeType, byteLength: bytes.length }, purpose: "brand_asset", sourceReceiptId: publication.source.sourceId, rightsEvidenceId: null, publicationState: "staged" }));
    const runtime = createLogoWorkerRuntime(f.options);
    f.produce.mockImplementationOnce(async () => {
      f.setReport(false); expect(await runtime.refreshReadiness()).toBe(false);
      return { status: "completed", bytes: png, mimeType: "image/png", providerRequestId: "fixture-response", responseHash: "a".repeat(64), billing: { status: "recorded", confirmedMicrousd: 1000 } };
    });
    expect(await runtime.tick()).toBe("succeeded");
    expect(deps.recordProviderResponse).toHaveBeenCalledTimes(1); expect(deps.assets.publishLeasedAsset).toHaveBeenCalledTimes(1);
    const complete = f.query.mock.calls.find(([sql]) => sql.includes("complete_logo_job_step"));
    expect(complete?.[1]?.[3]).toBe("succeeded"); expect(complete?.[1]?.[4]).toBe(1000);
    expect(JSON.parse(complete?.[1]?.[5] as string)).toMatchObject({ kind: "logo_concept", publicationId: id(802), providerResponseReceiptId: id(801) });
    expect(await runtime.tick()).toBe("idle"); expect(f.events.filter(event => event === "claim")).toHaveLength(1); runtime.close();
  });
  it("coalesces active tick ownership rather than racing two claims", async () => {
    const f = fixture(); let resolve!: (value: LogoImageProductionResult) => void;
    const dispatched = new Promise<void>(done => { f.produce.mockImplementationOnce(() => { done(); return new Promise(accept => { resolve = accept; }); }); });
    const runtime = createLogoWorkerRuntime(f.options), first = runtime.tick(); await dispatched;
    expect(await runtime.tick()).toBe("idle"); resolve(notDispatched); await first;
    expect(f.events.filter(event => event === "claim")).toHaveLength(1); runtime.close();
  });
  it("does not claim after shutdown while the initial readiness report is pending", async () => {
    const f = fixture(); let respond!: (value: { rows: { value: boolean }[] }) => void;
    f.query.mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
    const runtime = createLogoWorkerRuntime(f.options), pending = runtime.tick(); runtime.close(); respond({ rows: [{ value: true }] });
    expect(await pending).toBe("idle"); expect(f.query).toHaveBeenCalledTimes(1);
  });
  it("never changes its captured manifest when the caller changes configuration", async () => {
    const f = fixture(), manifest = [descriptor()], runtime = createLogoWorkerRuntime({ ...f.options, manifest }); manifest[0] = { ...descriptor(), policyIdentity: "d".repeat(64) };
    expect(await runtime.refreshReadiness()).toBe(true);
    expect(JSON.parse(f.query.mock.calls[0]![1]![1] as string)).toEqual([descriptor()]); runtime.close();
  });
});
