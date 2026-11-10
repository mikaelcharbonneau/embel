import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const qualification = vi.hoisted(() => ({ calls: [] as unknown[], fail: false, closes: 0, pending: undefined as undefined | (() => Promise<void>) }));
vi.mock("../../worker/logo-production-qualification", () => ({ createLogoProductionRuntimeQualification: () => ({
  async assertRuntimeAvailable(scope: unknown, signal?: AbortSignal) {
    qualification.calls.push(scope); if (qualification.pending) await qualification.pending();
    if (qualification.fail || signal?.aborted) throw Error("Synthetic private qualification failure");
  }, invalidate() {}, async close() { qualification.closes++; },
}) }));
import { startLogoProductionHost, type LogoProductionHostOptions } from "../../worker/logo-production-host";
import type { LogoProductionStorageAuthorization } from "../../worker/logo-production-storage-authorization";
import { QUALIFIED_VTRACER } from "../../worker/logo-vector/engine";
import { LOGO_EXPORT_HANDLER_VERSION, LOGO_EXPORT_POLICY_IDENTITY } from "../../worker/handlers/logo-exports";
import { syntheticConversionInput } from "../features/logo-vector/raster-fixtures";
import type { LogoWorkerCapability } from "../../worker/logo-readiness";
const binding = { ownerId: "d0000000-0000-4000-8000-000000000001", roleName: "fluid_logo_worker_host_test", roleOid: 1234 };
const vector = (): LogoWorkerCapability => ({ operation: "identity.logo_vectorize", policyIdentity: "b".repeat(64), handlerVersion: "1", provider: null, model: null,
  engine: { id: "vtracer", version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm }, maxCostMicrousd: 0 });
const exports = (): LogoWorkerCapability => ({ operation: "identity.logo_export", policyIdentity: LOGO_EXPORT_POLICY_IDENTITY, handlerVersion: LOGO_EXPORT_HANDLER_VERSION,
  provider: null, model: null, engine: null, maxCostMicrousd: 0 });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
function authorization(capability: LogoWorkerCapability): LogoProductionStorageAuthorization {
  const denied = vi.fn(async (): Promise<never> => { throw Error("No fixture source reads or writes expected"); });
  return { ownerId: binding.ownerId, capability, assertAvailable: vi.fn(async () => {}), authorizeRead: denied, authorizeWrite: denied, authorizeReadback: denied, close: vi.fn() };
}
function fixture() {
  const events: string[] = [], claims = deferred<void>();
  const c = Object.assign(new EventEmitter(), {
    query: vi.fn(async (q: { text: string; values: unknown[] }): Promise<{ rows: unknown[] }> => {
      if (q.text.includes("session_user")) { events.push("principal"); return { rows: [{ role_name: binding.roleName, active_role: binding.roleName, role_oid: "1234", owner_id: binding.ownerId }] }; }
      if (q.text.includes("logo_worker_owner()")) { events.push("owner"); return { rows: [{ owner_id: binding.ownerId }] }; }
      if (q.text.includes("report_logo_worker_ready")) { events.push("report"); return { rows: [{ value: true }] }; }
      if (q.text.includes("expire_logo_job_leases")) { events.push("expire"); return { rows: [{ value: 0 }] }; }
      if (q.text.includes("claim_logo_job")) { events.push("claim"); claims.resolve(); return { rows: [] }; }
      throw Error("Unexpected synthetic operation");
    }), release: vi.fn(), end: vi.fn(async () => {}),
  });
  const pool = { connect: vi.fn(async () => c), end: vi.fn(async () => {}) };
  const options: Extract<LogoProductionHostOptions, { enabled: true }> = { enabled: true, binding, pool, workerId: "synthetic-production-host",
    vector: { capability: vector(), authorization: authorization(vector()) }, exports: { capability: exports(), authorization: authorization(exports()) }, pollMs: 10 };
  return { options, c, pool, events, claims };
}
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  qualification.pending = undefined; await Promise.all(closers.splice(0).map(close => close()));
  qualification.calls = []; qualification.fail = false; qualification.closes = 0; vi.useRealTimers();
});
async function qualified(options: LogoProductionHostOptions) {
  const host = await startLogoProductionHost(options); closers.push(host.close);
  expect(host.status).toBe("qualified"); if (host.status !== "qualified") throw Error("Expected qualified fixture host"); return host;
}
describe("explicit dedicated production host", () => {
  it("defaults disabled with zero I/O, timers, authorization or qualification", async () => {
    const f = fixture();
    expect((await startLogoProductionHost()).status).toBe("disabled");
    expect((await startLogoProductionHost(null)).status).toBe("disabled");
    expect((await startLogoProductionHost({ ...f.options, enabled: false })).status).toBe("disabled");
    expect(f.pool.connect).not.toHaveBeenCalled(); expect(qualification.calls).toEqual([]);
    expect(f.options.vector!.authorization!.assertAvailable).not.toHaveBeenCalled();
  });
  it("rejects missing or mismatched dependencies before I/O instead of dropping selected operations", async () => {
    const f = fixture();
    for (const patch of [{ pool: null }, { workerId: "" }, { vector: null, exports: null },
      { vector: { ...f.options.vector!, authorization: null } },
      { vector: { ...f.options.vector!, capability: exports() } },
      { vector: { ...f.options.vector!, authorization: { ...f.options.vector!.authorization!, ownerId: "d0000000-0000-4000-8000-000000000002" } } },
      { vector: { ...f.options.vector!, authorization: { ...f.options.vector!.authorization!, capability: { ...vector(), policyIdentity: "c".repeat(64) } } } },
      { exports: { ...f.options.exports!, capability: { ...exports(), maxCostMicrousd: 1 } } },
    ]) {
      const host = await startLogoProductionHost({ ...f.options, ...patch });
      expect(host).toMatchObject({ status: "unavailable", reason: "configuration" }); await host.close();
    }
    expect(f.pool.connect).not.toHaveBeenCalled(); expect(qualification.calls).toEqual([]);
  });
  it("qualifies exactly vector and exports but does not report, claim or invent a leased storage check at construction", async () => {
    const f = fixture(), host = await qualified(f.options);
    expect(host.manifest).toEqual([vector(), exports()]); expect(f.events).toEqual(["principal", "owner"]);
    expect(qualification.calls).toEqual(host.manifest.map(capability => ({ ownerId: binding.ownerId, workerId: f.options.workerId, capability })));
    expect(f.options.vector!.authorization!.assertAvailable).not.toHaveBeenCalled(); expect(f.options.exports!.authorization!.assertAvailable).not.toHaveBeenCalled();
    expect(f.pool.end).not.toHaveBeenCalled();
  });
  it.each(["vector", "exports"] as const)("runs only explicitly selected %s operation", async operation => {
    const f = fixture(), host = await qualified({ ...f.options, vector: null, exports: null, [operation]: f.options[operation] });
    const signal = new AbortController(), running = host.run(signal.signal); await f.claims.promise; signal.abort(); await running;
    const report = f.c.query.mock.calls.find(([q]) => q.text.includes("report_logo_worker_ready"));
    expect(JSON.parse(report![0].values[1] as string)).toEqual([operation === "vector" ? vector() : exports()]);
    expect(f.events.filter(event => event === "claim")).toHaveLength(1); expect(f.pool.end).not.toHaveBeenCalled();
    expect(f.options.vector!.authorization!.close).not.toHaveBeenCalled();
  });
  it("fails qualification before readiness or claim and sanitizes its diagnostics", async () => {
    const f = fixture(); qualification.fail = true;
    const host = await startLogoProductionHost(f.options);
    expect(host).toMatchObject({ status: "unavailable", reason: "dependency_validation" });
    expect(f.events).not.toContain("report"); expect(f.events).not.toContain("claim");
    expect(JSON.stringify(host)).not.toContain("private"); await host.close();
  });
  it("requalifies before reports and refuses claim after qualifier revocation", async () => {
    const f = fixture(), host = await qualified(f.options); qualification.fail = true;
    const signal = new AbortController(), running = host.run(signal.signal);
    await new Promise(resolve => setTimeout(resolve, 30)); signal.abort(); await running;
    expect(qualification.calls.length).toBeGreaterThan(2); expect(f.events).not.toContain("report"); expect(f.events).not.toContain("claim");
  });
  it("accepts only one host loop and an already-aborted run causes no new I/O", async () => {
    const f = fixture(), host = await qualified(f.options), count = f.c.query.mock.calls.length;
    const signal = new AbortController(); signal.abort(); await host.run(signal.signal);
    await host.run(new AbortController().signal); expect(f.c.query).toHaveBeenCalledTimes(count);
  });
  it("fences immediately on stop and drains an in-flight claim before releasing external resources", async () => {
    const f = fixture(), host = await qualified(f.options), waiting = deferred<{ rows: unknown[] }>(), original = f.c.query.getMockImplementation()!;
    f.c.query.mockImplementation(q => {
      if (q.text.includes("claim_logo_job")) { f.events.push("claim"); f.claims.resolve(); return waiting.promise; }
      return original(q);
    });
    const signal = new AbortController(), running = host.run(signal.signal); await f.claims.promise;
    signal.abort(); let drained = false; const closing = host.close().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false); const count = f.c.query.mock.calls.length;
    const duplicate = host.run(new AbortController().signal);
    const jobId = "d0000000-0000-4000-8000-000000000002", projectId = "d0000000-0000-4000-8000-000000000003";
    waiting.resolve({ rows: [{ id: jobId, owner_id: binding.ownerId, project_id: projectId, operation: "identity.logo_vectorize", input_revision: 1,
      lease_token: "d0000000-0000-4000-8000-000000000004", state: "running", reserved_cost_microusd: 0, actual_cost_microusd: 0,
      input: { version: 2, ownerId: binding.ownerId, projectId, operation: "identity.logo_vectorize", requestKey: jobId, quoteId: jobId,
        policyIdentity: vector().policyIdentity, handlerVersion: "1", inputHash: "c".repeat(64), engine: vector().engine,
        source: { kind: "refinement", rasterRevisionId: jobId }, settings: syntheticConversionInput("mascot").settings },
    }] }); await Promise.all([running, closing, duplicate]);
    expect(drained).toBe(true); expect(f.c.query).toHaveBeenCalledTimes(count);
    expect(f.pool.end).not.toHaveBeenCalled(); expect(f.options.exports!.authorization!.close).not.toHaveBeenCalled();
  });
  it("stops a blocked readiness qualification without publishing a late report", async () => {
    const f = fixture(), host = await qualified(f.options), waiting = deferred<void>(), begun = deferred<void>();
    qualification.pending = async () => { begun.resolve(); await waiting.promise; };
    const signal = new AbortController(), running = host.run(signal.signal); await begun.promise;
    signal.abort(); const closing = host.close(); waiting.resolve(); await Promise.all([closing, running]);
    expect(f.events).not.toContain("report"); expect(f.events).not.toContain("claim");
  });
  it("captures configuration and supplied methods at construction", async () => {
    const f = fixture(), host = await qualified(f.options), signal = new AbortController();
    f.options.workerId = "changed"; f.options.vector!.capability = exports(); f.options.pool!.connect = async () => { throw Error("Changed caller pool"); };
    const running = host.run(signal.signal); await f.claims.promise; signal.abort(); await running;
    expect(host.manifest).toEqual([vector(), exports()]); expect(f.events).toContain("claim");
  });
  it("does not dispatch claim when shutdown arrives during that claim's acquired-client principal probe", async () => {
    const f = fixture(), host = await qualified(f.options), waiting = deferred<{ rows: unknown[] }>(), begun = deferred<void>(), original = f.c.query.getMockImplementation()!;
    let expired = false;
    f.c.query.mockImplementation(async q => {
      if (q.text.includes("expire_logo_job_leases")) { expired = true; return original(q); }
      if (expired && q.text.includes("session_user")) { begun.resolve(); return waiting.promise; }
      return original(q);
    });
    const stop = new AbortController(), running = host.run(stop.signal); await begun.promise;
    stop.abort(); waiting.resolve({ rows: [{ role_name: binding.roleName, active_role: binding.roleName, role_oid: "1234", owner_id: binding.ownerId }] });
    await running; await host.close(); expect(f.events).not.toContain("claim");
  });

  it("does not dispatch claim when shutdown arrives during pool acquisition", async () => {
    const f = fixture(), host = await qualified(f.options), waiting = deferred<typeof f.c>(), begun = deferred<void>(), original = f.c.query.getMockImplementation()!;
    let expired = false;
    f.c.query.mockImplementation(async q => { if (q.text.includes("expire_logo_job_leases")) expired = true; return original(q); });
    f.pool.connect.mockImplementation(async () => { if (expired) { begun.resolve(); return waiting.promise; } return f.c; });
    const stop = new AbortController(), running = host.run(stop.signal); await begun.promise;
    stop.abort(); waiting.resolve(f.c); await running; await host.close();
    expect(f.events).not.toContain("claim"); expect(f.c.release).toHaveBeenLastCalledWith(true);
  });

});

import type { LogoGenerativeStorageAuthorization } from "../../worker/logo-generative-storage-authorization";
import type { LogoProductionImageHostOperation } from "../../worker/logo-production-host";
import { CAPPED_LOGO_IMAGE_MODEL } from "../../src/domain/providers";
import { SUNBURST_STANDARD_IMAGE_PRICING } from "../../src/server/logo-creation/openai-image-pricing";
function imageHostOperation(operation: "identity.logo_concept" | "identity.logo_refine"): LogoProductionImageHostOperation {
  const capability: LogoWorkerCapability = { operation, policyIdentity: "c".repeat(64), handlerVersion: "logo-image-v1",
    provider: "openai", model: CAPPED_LOGO_IMAGE_MODEL, engine: null, maxCostMicrousd: 2000 };
  const denied = vi.fn(async (): Promise<never> => { throw Error("No byte I/O expected in host construction"); });
  const auth: LogoGenerativeStorageAuthorization = { ownerId: binding.ownerId, capability,
    assertAvailable: vi.fn(async () => {}), authorizeRead: denied, authorizeWrite: denied, close: vi.fn() };
  return { capability, authorization: auth, image: { apiKey: "synthetic-image-key", model: CAPPED_LOGO_IMAGE_MODEL,
    rateVersion: SUNBURST_STANDARD_IMAGE_PRICING.binding.rateVersion, paidCallsApproved: true }, transport: { createImage: denied } };
}
describe("combined dedicated logo host", () => {
  it("keeps one host loop and one full four-operation manifest, without pre-job Auth or image probes", async () => {
    const f = fixture(), concepts = imageHostOperation("identity.logo_concept"), refinements = imageHostOperation("identity.logo_refine");
    const host = await qualified({ ...f.options, concepts, refinements });
    const union = [concepts.capability, refinements.capability, vector(), exports()]; expect(host.manifest).toEqual(union);
    expect(concepts.authorization!.assertAvailable).not.toHaveBeenCalled(); expect(refinements.authorization!.authorizeRead).not.toHaveBeenCalled();
    expect(concepts.transport!.createImage).not.toHaveBeenCalled();
    const signal = new AbortController(), running = host.run(signal.signal); const duplicate = host.run(signal.signal);
    expect(duplicate).toBe(running); await f.claims.promise; signal.abort(); await running;
    const reports = f.c.query.mock.calls.filter(([q]) => q.text.includes("report_logo_worker_ready"));
    expect(reports).toHaveLength(1); expect(JSON.parse(reports[0]![0].values[1] as string)).toEqual(union);
    expect(f.events.filter(event => event === "claim")).toHaveLength(1); expect(concepts.authorization!.close).not.toHaveBeenCalled(); expect(f.pool.end).not.toHaveBeenCalled();
  });
  it.each(["concepts", "refinements"] as const)("allows an image-only %s host without constructing a zero-operation production qualifier", async operation => {
    const f = fixture(), selected = imageHostOperation(operation === "concepts" ? "identity.logo_concept" : "identity.logo_refine");
    const host = await qualified({ ...f.options, vector: null, exports: null, [operation]: selected });
    expect(host.manifest).toEqual([selected.capability]); expect(qualification.calls).toEqual([]);
    await host.close(); expect(qualification.closes).toBe(0);
  });
  it.each(["approval", "model", "rate", "budget", "authorization", "operation", "owner", "binding"])("refuses a generative %s mismatch before database I/O", async field => {
    const f = fixture(), concepts = imageHostOperation("identity.logo_concept");
    if (field === "approval") concepts.image.paidCallsApproved = false;
    if (field === "model") concepts.image.model = "other";
    if (field === "rate") concepts.image.rateVersion = "other";
    if (field === "budget") concepts.capability = { ...concepts.capability, maxCostMicrousd: 0 };
    if (field === "authorization") concepts.authorization = null;
    if (field === "operation") concepts.capability = { ...concepts.capability, operation: "identity.logo_refine" };
    if (field === "owner") concepts.authorization = { ...concepts.authorization!, ownerId: "d0000000-0000-4000-8000-000000000002" };
    if (field === "binding") concepts.authorization = { ...concepts.authorization!, capability: { ...concepts.capability, policyIdentity: "d".repeat(64) } };
    expect((await startLogoProductionHost({ ...f.options, concepts })).status).toBe("unavailable");
    expect(f.pool.connect).not.toHaveBeenCalled(); expect(qualification.calls).toEqual([]); expect(concepts.transport!.createImage).not.toHaveBeenCalled();
  });
});

import { subscriptionPolicy } from "../features/identity-directions/subscription-fixtures";
import type { LogoProductionDirectionsHostOperation } from "../../worker/logo-production-host";
function directionsHostOperation(): LogoProductionDirectionsHostOperation {
  const policy = subscriptionPolicy(), capability: LogoWorkerCapability = { operation: "identity.logo_directions", policyIdentity: "d".repeat(64), handlerVersion: policy.handlerVersion,
    provider: "openai", model: policy.model, engine: null, maxCostMicrousd: 0, billingMode: "chatgpt_subscription", policy };
  const denied = vi.fn(async (): Promise<never> => { throw Error("No fixture direction bytes expected"); });
  return { capability, expectedAccountId: policy.registrationId, transport: { listModels: vi.fn(), streamResponse: vi.fn() },
    authorization: { ownerId: binding.ownerId, capability, assertAvailable: vi.fn(async () => {}), authorizeRead: denied, close: vi.fn() } };
}
describe("five-lane host with explicit subscription transport", () => {
  it("uses one run/union readiness and keeps directions Storage/model checks job-bound", async () => {
    const f = fixture(), concepts = imageHostOperation("identity.logo_concept"), refinements = imageHostOperation("identity.logo_refine"), directions = directionsHostOperation();
    const host = await qualified({ ...f.options, concepts, refinements, directions });
    expect(host.manifest).toEqual([concepts.capability, refinements.capability, vector(), directions.capability, exports()]);
    const signal = new AbortController(), running = host.run(signal.signal); expect(host.run(signal.signal)).toBe(running); await f.claims.promise; signal.abort(); await running;
    const reports = f.c.query.mock.calls.filter(([q]) => q.text.includes("report_logo_worker_ready")); expect(reports).toHaveLength(1);
    expect(JSON.parse(reports[0]![0].values[1] as string)).toEqual(host.manifest); expect(f.events.filter(event => event === "claim")).toHaveLength(1);
    expect(directions.authorization!.assertAvailable).not.toHaveBeenCalled(); expect(directions.transport!.listModels).not.toHaveBeenCalled(); expect(directions.authorization!.close).not.toHaveBeenCalled();
  });
  it("permits a directions-only host without local converter qualification or API inputs", async () => {
    const f = fixture(), directions = directionsHostOperation(), host = await qualified({ ...f.options, vector: null, exports: null, directions });
    expect(host.manifest).toEqual([directions.capability]); expect(qualification.calls).toEqual([]); await host.close(); expect(qualification.closes).toBe(0);
  });
  it.each(["owner", "capability", "authorization", "transport", "account", "cost"])("fails selected directions %s before I/O", async field => {
    const f = fixture(), directions = directionsHostOperation();
    if (field === "owner") directions.authorization = { ...directions.authorization!, ownerId: "d0000000-0000-4000-8000-000000000002" };
    if (field === "capability") directions.authorization = { ...directions.authorization!, capability: { ...directions.capability, policyIdentity: "e".repeat(64) } };
    if (field === "authorization") directions.authorization = null;
    if (field === "transport") directions.transport = null;
    if (field === "account") directions.expectedAccountId = "wrong-account";
    if (field === "cost") directions.capability = { ...directions.capability, maxCostMicrousd: 1 };
    expect((await startLogoProductionHost({ ...f.options, directions })).status).toBe("unavailable"); expect(f.pool.connect).not.toHaveBeenCalled();
  });
});
