import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { IdentityAssetStore } from "../../src/server/data/identity-asset-store";
import type { LogoWorkerConnection } from "../../src/server/data/logo-jobs";
import { QUALIFIED_VTRACER } from "../../worker/logo-vector/engine";
import { LOGO_EXPORT_HANDLER_VERSION, LOGO_EXPORT_POLICY_IDENTITY } from "../../worker/handlers/logo-exports";
import { startLogoProductionWorker, type LogoProductionStartupOptions } from "../../worker/logo-production-startup";
import { logoFixtureId as id } from "../fixtures/logo-creation";

const vectorCapability = () => ({ operation: "identity.logo_vectorize" as const, policyIdentity: "b".repeat(64), handlerVersion: "1",
  provider: null, model: null, engine: { id: "vtracer", version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm }, maxCostMicrousd: 0 });
const exportCapability = () => ({ operation: "identity.logo_export" as const, policyIdentity: LOGO_EXPORT_POLICY_IDENTITY,
  handlerVersion: LOGO_EXPORT_HANDLER_VERSION, provider: null, model: null, engine: null, maxCostMicrousd: 0 });
function fixture() {
  const events: string[] = [], state = { owner: id(1) as unknown, runtimeAvailable: true, report: true as unknown };
  const query = vi.fn(async (sql: string, parameters: unknown[] = []): Promise<{ rows: unknown[] }> => {
    if (sql.includes("logo_worker_owner()")) { events.push("owner"); return { rows: [{ owner_id: state.owner }] }; }
    if (sql.includes("report_logo_worker_ready")) { events.push("report"); return { rows: [{ value: state.report }] }; }
    if (sql.includes("expire_logo_job_leases")) { events.push("expire"); return { rows: [{ value: 0 }] }; }
    if (sql.includes("claim_logo_job")) { events.push("claim"); return { rows: [] }; }
    throw Error(`Unexpected synthetic SQL with ${parameters.length} arguments`);
  });
  const denied = vi.fn(async (): Promise<never> => { throw Error("No synthetic job should read or publish"); });
  const assets: IdentityAssetStore = { stageOwnedAsset: denied, publishOwnedUpload: denied, readOwnedAsset: denied,
    readLeasedAsset: denied, publishLeasedAsset: denied };
  const assertRuntimeAvailable = vi.fn(async ({ capability }: { capability: { operation: string } }) => {
    events.push(`qualify:${capability.operation}`); if (!state.runtimeAvailable) throw Error("Synthetic private diagnostic");
  });
  const assertAvailable = vi.fn(async () => { events.push("leased-availability"); });
  const options: Extract<LogoProductionStartupOptions, { enabled: true }> = { enabled: true, ownerId: id(1), workerId: "synthetic-production",
    connection: { query } as LogoWorkerConnection,
    vector: { capability: vectorCapability(), assets, assertRuntimeAvailable, assertAvailable },
    exports: { capability: exportCapability(), assets, assertRuntimeAvailable, assertAvailable } };
  return { options, events, state, query, assets, assertRuntimeAvailable, assertAvailable };
}
const close: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(close.splice(0).map(stop => stop())); vi.unstubAllEnvs(); });
async function ready(options: LogoProductionStartupOptions) {
  const started = await startLogoProductionWorker(options); close.push(started.close);
  expect(started.status).toBe("ready"); if (started.status !== "ready") throw Error("Expected local constructed runtime");
  return started;
}

describe("explicit injected non-generative logo startup", () => {
  it("stays disabled without opt-in even when unrelated credentials are present", async () => {
    vi.stubEnv("FLUID_LOGO_OPENAI_API_KEY", "synthetic-unused"); vi.stubEnv("FLUID_LOGO_WORKER_DATABASE_URL", "synthetic-unused");
    const f = fixture();
    expect((await startLogoProductionWorker()).status).toBe("disabled");
    expect((await startLogoProductionWorker(null)).status).toBe("disabled");
    expect((await startLogoProductionWorker({ ...f.options, enabled: false })).status).toBe("disabled");
    expect(f.query).not.toHaveBeenCalled(); expect(f.assertRuntimeAvailable).not.toHaveBeenCalled();
  });
  it("requires a real connection, asset methods and both independent availability checks before I/O", async () => {
    const f = fixture();
    for (const patch of [{ connection: null }, { vector: null, exports: null }, { ownerId: "bad" }, { workerId: "" },
      { vector: { ...f.options.vector!, assets: null } },
      { vector: { ...f.options.vector!, assertRuntimeAvailable: null } }, { exports: { ...f.options.exports!, assertAvailable: null } }]) {
      const started = await startLogoProductionWorker({ ...f.options, ...patch });
      expect(started).toMatchObject({ status: "unavailable", reason: "configuration" }); await started.close();
    }
    expect(f.query).not.toHaveBeenCalled(); expect(f.assertRuntimeAvailable).not.toHaveBeenCalled();
  });
  it.each(["operation", "policy", "handler", "engine", "provider", "cost"])("rejects a mismatched %s capability before I/O", async field => {
    const f = fixture(), vector = vectorCapability(), exports = exportCapability();
    if (field === "operation") vector.operation = "identity.logo_export" as typeof vector.operation;
    if (field === "policy") exports.policyIdentity = "c".repeat(64);
    if (field === "handler") vector.handlerVersion = "other";
    if (field === "engine") Object.assign(vector.engine, { artifactHash: "d".repeat(64) });
    if (field === "provider") Object.assign(vector, { provider: "openai", model: "unwanted" });
    if (field === "cost") vector.maxCostMicrousd = 1;
    const started = await startLogoProductionWorker({ ...f.options, vector: { ...f.options.vector!, capability: vector }, exports: { ...f.options.exports!, capability: exports } });
    expect(started).toMatchObject({ status: "unavailable", reason: "configuration" }); expect(f.query).not.toHaveBeenCalled();
  });
  it("qualifies the exact owner and both runtimes without reporting, claiming or touching assets", async () => {
    const f = fixture(), started = await ready(f.options);
    expect(started.runtime.manifest).toEqual([vectorCapability(), exportCapability()]);
    expect(f.events).toEqual(["owner", "qualify:identity.logo_vectorize", "qualify:identity.logo_export"]);
    expect(f.assertRuntimeAvailable.mock.calls[0]?.[0]).toEqual({ ownerId: id(1), workerId: "synthetic-production", capability: vectorCapability() });
    expect(f.assertAvailable).not.toHaveBeenCalled(); expect(f.assets.readLeasedAsset).not.toHaveBeenCalled();
    expect(Object.entries(started.runtime.capabilities).filter(([, value]) => value.status === "available").map(([operation]) => operation))
      .toEqual(["identity.logo_vectorize", "identity.logo_export"]);
  });
  it.each(["vector", "exports"] as const)("allows an explicitly selected %s operation alone", async operation => {
    const f = fixture(), started = await ready({ ...f.options, vector: null, exports: null, [operation]: f.options[operation] });
    expect(started.runtime.manifest).toEqual([operation === "vector" ? vectorCapability() : exportCapability()]);
    expect(await started.runtime.tick()).toBe("idle"); expect(f.events.at(-1)).toBe("claim");
  });
  it.each([null, id(2), "true"])("refuses an absent or foreign actual worker owner %s", async owner => {
    const f = fixture(); f.state.owner = owner;
    expect(await startLogoProductionWorker(f.options)).toMatchObject({ status: "unavailable", reason: "dependency_validation" });
    expect(f.assertRuntimeAvailable).not.toHaveBeenCalled(); expect(f.events).toEqual(["owner"]);
  });
  it("returns a fixed unavailable state if independently checked runtime qualification fails", async () => {
    const f = fixture(); f.state.runtimeAvailable = false;
    const started = await startLogoProductionWorker(f.options);
    expect(started).toMatchObject({ status: "unavailable", reason: "dependency_validation" });
    expect(JSON.stringify(started)).not.toContain("Synthetic private diagnostic"); expect(f.events).not.toContain("report");
  });
  it("rechecks actual owner/runtime before every readiness report and blocks claim on revocation", async () => {
    const f = fixture(), started = await ready(f.options); f.events.length = 0;
    expect(await started.runtime.tick()).toBe("idle");
    expect(f.events).toEqual(["owner", "qualify:identity.logo_vectorize", "qualify:identity.logo_export", "report", "expire", "claim"]);
    f.events.length = 0; f.state.runtimeAvailable = false;
    expect(await started.runtime.tick()).toBe("idle"); expect(f.events).toEqual(["owner", "qualify:identity.logo_vectorize"]);
    f.events.length = 0; f.state.runtimeAvailable = true; f.state.owner = id(2);
    expect(await started.runtime.refreshReadiness()).toBe(false); expect(f.events).toEqual(["owner"]);
  });
  it.each([false, "true", null])("requires exact SQL readiness acknowledgement %s", async report => {
    const f = fixture(), started = await ready(f.options); f.events.length = 0; f.state.report = report;
    expect(await started.runtime.tick()).toBe("idle"); expect(f.events).toContain("report"); expect(f.events).not.toContain("claim");
  });
  it("captures injected descriptors, methods and callbacks rather than mutable caller configuration", async () => {
    const f = fixture(), started = await ready(f.options);
    f.options.vector!.capability = { ...vectorCapability(), policyIdentity: "e".repeat(64) };
    f.options.vector!.assertRuntimeAvailable = async () => { throw Error("Changed caller callback"); };
    f.options.connection!.query = async () => { throw Error("Changed caller connection"); };
    expect(await started.runtime.refreshReadiness()).toBe(true);
    expect(started.runtime.manifest).toEqual([vectorCapability(), exportCapability()]);
  });
  it("drains an already-started tick before the caller can release its injected resources", async () => {
    const f = fixture(), started = await ready(f.options), previous = f.query.getMockImplementation()!;
    let finish!: (value: { rows: unknown[] }) => void, begin!: () => void;
    const begun = new Promise<void>(resolve => { begin = resolve; });
    f.query.mockImplementation((sql, parameters) => {
      if (sql.includes("claim_logo_job")) { begin(); return new Promise(resolve => { finish = resolve; }); }
      return previous(sql, parameters);
    });
    const tick = started.runtime.tick(); await begun;
    let drained = false; const closing = started.runtime.close().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false); expect(await started.runtime.tick()).toBe("idle");
    finish({ rows: [] }); expect(await tick).toBe("idle"); await closing; expect(drained).toBe(true);
  });
  it("does no readiness or asset work for an already-cancelled tick", async () => {
    const f = fixture(), started = await ready(f.options), controller = new AbortController();
    f.events.length = 0; controller.abort();
    expect(await started.runtime.tick(controller.signal)).toBe("idle"); expect(f.events).toEqual([]);
    expect(f.assets.publishLeasedAsset).not.toHaveBeenCalled();
  });
  it("fences closing immediately and drains a pending qualification without publishing a late report", async () => {
    const f = fixture(), started = await ready(f.options);
    let finish!: () => void, begin!: () => void;
    const begun = new Promise<void>(resolve => { begin = resolve; });
    f.assertRuntimeAvailable.mockImplementationOnce(async () => { begin(); await new Promise<void>(resolve => { finish = resolve; }); });
    f.events.length = 0;
    const pending = started.runtime.refreshReadiness(); await begun;
    let drained = false; const closing = started.close().then(() => { drained = true; });
    expect(await started.runtime.tick()).toBe("idle"); expect(drained).toBe(false);
    finish(); expect(await pending).toBe(false); await closing;
    expect(f.events).not.toContain("report"); expect(f.events).not.toContain("claim");
    expect(await started.runtime.refreshReadiness()).toBe(false); await started.runtime.close();
  });
});

import { CAPPED_LOGO_IMAGE_MODEL } from "../../src/domain/providers";
import { SUNBURST_STANDARD_IMAGE_PRICING } from "../../src/server/logo-creation/openai-image-pricing";
import type { LogoProductionImageOperationInput } from "../../worker/logo-production-startup";
function imageOperation(f: ReturnType<typeof fixture>, operation: "identity.logo_concept" | "identity.logo_refine"): LogoProductionImageOperationInput {
  return { capability: { operation, policyIdentity: "c".repeat(64), handlerVersion: "logo-image-v1", provider: "openai", model: CAPPED_LOGO_IMAGE_MODEL, engine: null, maxCostMicrousd: 2000 },
    assets: f.assets, assertAvailable: f.assertAvailable,
    image: { apiKey: "synthetic-image-key", model: CAPPED_LOGO_IMAGE_MODEL, rateVersion: SUNBURST_STANDARD_IMAGE_PRICING.binding.rateVersion, paidCallsApproved: true },
    transport: { createImage: vi.fn(async (): Promise<never> => { throw Error("No image dispatch in idle startup test"); }) } };
}
describe("single combined logo operation startup", () => {
  it("publishes the same four-operation union on every heartbeat without a concept-only overwrite", async () => {
    const f = fixture(), concepts = imageOperation(f, "identity.logo_concept"), refinements = imageOperation(f, "identity.logo_refine");
    const started = await ready({ ...f.options, concepts, refinements });
    const union = [concepts.capability, refinements.capability, vectorCapability(), exportCapability()];
    expect(started.runtime.manifest).toEqual(union);
    expect(started.runtime.capabilities["identity.logo_directions"].status).toBe("unavailable");
    for (let n = 0; n < 3; n++) { expect(await started.runtime.refreshReadiness()).toBe(true); expect(await started.runtime.tick()).toBe("idle"); }
    const reports = f.query.mock.calls.filter(([sql]) => sql.includes("report_logo_worker_ready"));
    expect(reports).toHaveLength(6);
    for (const [, values] of reports) expect(JSON.parse(values![1] as string)).toEqual(union);
    expect(f.assertRuntimeAvailable.mock.calls.every(([scope]) => ["identity.logo_vectorize", "identity.logo_export"].includes(scope.capability.operation))).toBe(true);
    expect(f.assertAvailable).not.toHaveBeenCalled();
  });
  it.each(["concepts", "refinements"] as const)("opts into %s alone without inventing installed-runtime or pre-job Storage checks", async operation => {
    const f = fixture(), selected = imageOperation(f, operation === "concepts" ? "identity.logo_concept" : "identity.logo_refine");
    const started = await ready({ ...f.options, vector: null, exports: null, [operation]: selected });
    expect(started.runtime.manifest).toEqual([selected.capability]);
    expect(f.events).toEqual(["owner"]); expect(f.assertRuntimeAvailable).not.toHaveBeenCalled(); expect(f.assertAvailable).not.toHaveBeenCalled();
  });
  it.each(["approval", "rate", "model", "budget", "operation", "store"])("rejects a selected generative %s failure instead of silently dropping it", async field => {
    const f = fixture(), concepts = imageOperation(f, "identity.logo_concept");
    if (field === "approval") concepts.image.paidCallsApproved = false;
    if (field === "rate") concepts.image.rateVersion = "other";
    if (field === "model") concepts.image.model = "other";
    if (field === "budget") concepts.capability = { ...concepts.capability, maxCostMicrousd: 0 };
    if (field === "operation") concepts.capability = { ...concepts.capability, operation: "identity.logo_refine" };
    if (field === "store") concepts.assets = null;
    expect(await startLogoProductionWorker({ ...f.options, concepts })).toMatchObject({ status: "unavailable", reason: "configuration" });
    expect(f.query).not.toHaveBeenCalled(); expect(f.assertRuntimeAvailable).not.toHaveBeenCalled();
  });
});

import { subscriptionPolicy } from "../features/identity-directions/subscription-fixtures";
import type { LogoProductionDirectionsOperationInput } from "../../worker/logo-production-startup";
function directionsOperation(f: ReturnType<typeof fixture>): LogoProductionDirectionsOperationInput {
  const policy = subscriptionPolicy();
  return { capability: { operation: "identity.logo_directions", policyIdentity: "d".repeat(64), handlerVersion: policy.handlerVersion, provider: "openai", model: policy.model,
    engine: null, maxCostMicrousd: 0, billingMode: "chatgpt_subscription", policy }, expectedAccountId: policy.registrationId,
    assets: f.assets, assertAvailable: f.assertAvailable, transport: { listModels: vi.fn(), streamResponse: vi.fn() } };
}
describe("optional fifth subscription directions lane", () => {
  it("constructs one five-operation union and repeats all descriptors without clobbering prior lanes", async () => {
    const f = fixture(), concepts = imageOperation(f, "identity.logo_concept"), refinements = imageOperation(f, "identity.logo_refine"), directions = directionsOperation(f);
    const started = await ready({ ...f.options, concepts, refinements, directions });
    const union = [concepts.capability, refinements.capability, vectorCapability(), directions.capability, exportCapability()];
    expect(started.runtime.manifest).toEqual(union); expect(started.runtime.capabilities["identity.logo_directions"].status).toBe("available");
    for (let n = 0; n < 2; n++) expect(await started.runtime.tick()).toBe("idle");
    for (const [, values] of f.query.mock.calls.filter(([sql]) => sql.includes("report_logo_worker_ready"))) expect(JSON.parse(values![1] as string)).toEqual(union);
    expect(directions.transport!.streamResponse).not.toHaveBeenCalled(); expect(f.assertAvailable).not.toHaveBeenCalled();
  });
  it("constructs directions alone without an image key or paid API approval and never probes a session", async () => {
    const f = fixture(), directions = directionsOperation(f), started = await ready({ ...f.options, vector: null, exports: null, directions });
    expect(started.runtime.manifest).toEqual([directions.capability]); expect(f.events).toEqual(["owner"]);
    expect(directions.transport!.listModels).not.toHaveBeenCalled(); expect(directions.transport!.streamResponse).not.toHaveBeenCalled();
  });
  it.each(["account", "billing", "model", "policy", "transport", "assets", "operation", "cost"])("rejects the selected directions %s mismatch before I/O", async field => {
    const f = fixture(), directions = directionsOperation(f);
    if (field === "account") directions.expectedAccountId = "wrong-account";
    if (field === "billing") directions.capability = { ...directions.capability, billingMode: undefined, policy: undefined };
    if (field === "model") directions.capability = { ...directions.capability, model: "unrequested-model" };
    if (field === "policy") directions.capability = { ...directions.capability, policy: { ...directions.capability.policy!, apiCharge: "unverified" } } as unknown as typeof directions.capability;
    if (field === "transport") directions.transport = null;
    if (field === "assets") directions.assets = null;
    if (field === "operation") directions.capability = { ...directions.capability, operation: "identity.logo_export" };
    if (field === "cost") directions.capability = { ...directions.capability, maxCostMicrousd: 1 };
    expect(await startLogoProductionWorker({ ...f.options, directions })).toMatchObject({ status: "unavailable", reason: "configuration" }); expect(f.query).not.toHaveBeenCalled();
  });
});
