import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("node:fs/promises", async importOriginal => { const actual = await importOriginal<typeof import("node:fs/promises")>(); return { ...actual, open: vi.fn(actual.open) }; });
import { createLogoProductionRuntimeQualification } from "../../worker/logo-production-qualification";
import { QUALIFIED_VTRACER } from "../../src/server/image-process/engine";
const ownerId = "10000000-0000-4000-8000-000000000001", workerId = "qualification-test";
const capability = () => ({ operation: "identity.logo_vectorize" as const, policyIdentity: "b".repeat(64), handlerVersion: "1", provider: null, model: null, engine: { id: "vtracer", version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm }, maxCostMicrousd: 0 });
const closing: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(closing.splice(0).map(close => close())); vi.useRealTimers(); vi.restoreAllMocks(); });
function qualifier() { const result = createLogoProductionRuntimeQualification({ ownerId, workerId, capabilities: [capability()] }); closing.push(result.close); return result; }
describe("independent non-generative production qualification", () => {
  it("rejects altered capabilities rather than qualifying package presence", () => {
    expect(() => createLogoProductionRuntimeQualification({ ownerId, workerId, capabilities: [{ ...capability(), maxCostMicrousd: 1 }] })).toThrow(/qualification/i);
  });
  it("fences mismatched scope and closure before runtime I/O", async () => {
    const q = qualifier();
    await expect(q.assertRuntimeAvailable({ ownerId, workerId: "another-worker", capability: capability() })).rejects.toThrow(/qualification/i);
    await q.close();
    await expect(q.assertRuntimeAvailable({ ownerId, workerId, capability: capability() })).rejects.toThrow(/qualification/i);
  });
  it("rejects already aborted qualification without child execution", async () => {
    const q = qualifier(), controller = new AbortController(); controller.abort();
    await expect(q.assertRuntimeAvailable({ ownerId, workerId, capability: capability() }, controller.signal)).rejects.toThrow(/qualification/i);
  });
});

import * as sentinel from "../../worker/logo-production-sentinels";
import * as files from "node:fs/promises";
import * as vectorProcess from "../../src/server/image-process/process";
import * as renderProcess from "../../src/features/identity-deliverables/server/process";
import { LOGO_EXPORT_HANDLER_VERSION, LOGO_EXPORT_POLICY_IDENTITY } from "../../worker/handlers/logo-exports";
import { LOGO_QUALIFICATION_DEADLINE_MS, LOGO_QUALIFICATION_PROOF_TTL_MS, LOGO_QUALIFICATION_DRAIN_MS } from "../../worker/logo-production-qualification";
const exportCapability = () => ({ operation: "identity.logo_export" as const, policyIdentity: LOGO_EXPORT_POLICY_IDENTITY, handlerVersion: LOGO_EXPORT_HANDLER_VERSION, provider: null, model: null, engine: null, maxCostMicrousd: 0 });
const scope = () => ({ ownerId, workerId, capability: capability() });

describe("fixed reviewed installation and proof lifecycle", () => {
  it("constructs without filesystem or child I/O and rejects path/launcher injection", () => {
    const read = vi.spyOn(files, "open"), vector = vi.spyOn(vectorProcess, "runLogoVectorProcess"), render = vi.spyOn(renderProcess, "runLogoProcess");
    qualifier(); expect(read).not.toHaveBeenCalled(); expect(vector).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
    for (const extra of [{ root: "/tmp/other" }, { launch: () => undefined }, { execPath: "/bin/sh" }]) {
      expect(() => createLogoProductionRuntimeQualification({ ownerId, workerId, capabilities: [capability()], ...extra })).toThrow(/qualification/i);
    }
  });
  it("rejects missing or tampered pinned files before any sentinel", async () => {
    const original = (await vi.importActual<typeof files>("node:fs/promises")).open, vector = vi.spyOn(vectorProcess, "runLogoVectorProcess");
    for (const mode of ["missing", "tampered"] as const) {
      vi.spyOn(files, "open").mockImplementation(async (...args) => {
        if (String(args[0]).endsWith("worker/logo-vector/process.ts")) {
          if (mode === "missing") throw Error("missing private diagnostic");
          const handle = await original(...args);
          const read = handle.read.bind(handle);
          handle.read = (async (...args: Parameters<typeof read>) => { const result = await read(...args); const buffer = result.buffer as Uint8Array; buffer[0] = buffer[0]! ^ 1; return result; }) as typeof handle.read;
          return handle;
        }
        return original(...args);
      });
      const q = qualifier();
      await expect(q.assertRuntimeAvailable(scope())).rejects.toThrow(/^Logo production runtime qualification failed\.$/);
      await q.close(); vi.mocked(files.open).mockRestore();
    }
    expect(vector).not.toHaveBeenCalled();
  });
  it("bounds deadline and closure even when a dependency ignores abort, fencing extra launches", async () => {
    let entered!: () => void, settle!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { settle = resolve; });
    vi.spyOn(sentinel, "qualifyVectorSentinel").mockImplementation(async () => { entered(); await held; });
    const q = qualifier(), work = q.assertRuntimeAvailable(scope());
    const rejected = expect(work).rejects.toThrow(/qualification/i);
    await reached;
    await expect(q.assertRuntimeAvailable(scope())).rejects.toThrow(/qualification/i);
    const closing = q.close(); await rejected;
    let drained = false; void closing.then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false); settle(); await closing;
    await expect(q.assertRuntimeAvailable(scope())).rejects.toThrow(/qualification/i);
    expect(sentinel.qualifyVectorSentinel).toHaveBeenCalledTimes(1);
  });
  it("expires actual execution proofs and does not extend TTL on cache hits", async () => {
    const run = vi.spyOn(sentinel, "qualifyVectorSentinel").mockResolvedValue();
    let now = 10; vi.spyOn(performance, "now").mockImplementation(() => now);
    const q = qualifier();
    await q.assertRuntimeAvailable(scope()); expect(run).toHaveBeenCalledTimes(1);
    now += LOGO_QUALIFICATION_PROOF_TTL_MS - 1;
    await q.assertRuntimeAvailable(scope()); expect(run).toHaveBeenCalledTimes(1);
    now += 2;
    await q.assertRuntimeAvailable(scope()); expect(run).toHaveBeenCalledTimes(2);
    q.invalidate(); await q.assertRuntimeAvailable(scope()); expect(run).toHaveBeenCalledTimes(3);
  });
  it("runs the configured deadline with no delayed success after abort", async () => {
    let entered!: () => void, settle!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { settle = resolve; });
    vi.spyOn(sentinel, "qualifyVectorSentinel").mockImplementation(async () => { entered(); await held; });
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const q = qualifier(), controller = new AbortController(), work = q.assertRuntimeAvailable(scope(), controller.signal);
    const rejected = expect(work).rejects.toThrow(/qualification/i);
    await reached; expect(timeout.mock.calls.some(call => call[1] === LOGO_QUALIFICATION_DEADLINE_MS)).toBe(true);
    controller.abort(); await rejected; settle(); await q.close();
  });
});

describe("actual fixed child execution", () => {
  it("qualifies real vector, PNG/PDF verification, guidelines and ZIP; caches only unchanged runtime", async () => {
    const vector = vi.spyOn(vectorProcess, "runLogoVectorProcess"), render = vi.spyOn(renderProcess, "runLogoProcess");
    const q = createLogoProductionRuntimeQualification({ ownerId, workerId, capabilities: [capability(), exportCapability()] }); closing.push(q.close);
    await q.assertRuntimeAvailable(scope());
    await q.assertRuntimeAvailable({ ownerId, workerId, capability: exportCapability() });
    expect(vector).toHaveBeenCalledTimes(1);
    expect(render.mock.calls.map(([input]) => input.operation)).toEqual(["logo", "verify", "guidelines"]);
    const output = await vector.mock.results[0]!.value;
    expect(output.raster.rgbaContentHash).toBe("51f1ee56b003f623c3fe8768e2efac0307432ef151952fd2d0d4c0a774766ec0");
    expect(output.document.components[0].paths).toHaveLength(1);
    await q.assertRuntimeAvailable(scope()); await q.assertRuntimeAvailable({ ownerId, workerId, capability: exportCapability() });
    expect(vector).toHaveBeenCalledTimes(1); expect(render).toHaveBeenCalledTimes(3);
    q.invalidate(); await q.assertRuntimeAvailable(scope()); expect(vector).toHaveBeenCalledTimes(2);
  }, 60_000);
});

describe("failed requalification cannot retain readiness", () => {
  it("drops cached execution proof after a missing pinned file and demands execution after recovery", async () => {
    const run = vi.spyOn(sentinel, "qualifyVectorSentinel").mockResolvedValue();
    const actual = (await vi.importActual<typeof files>("node:fs/promises")).open;
    const q = qualifier(); await q.assertRuntimeAvailable(scope()); expect(run).toHaveBeenCalledTimes(1);
    const read = vi.spyOn(files, "open").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("worker/logo-vector/process.ts")) throw Error("file removed");
      return actual(...args);
    });
    await expect(q.assertRuntimeAvailable(scope())).rejects.toThrow(/qualification/i);
    await expect(q.assertRuntimeAvailable(scope())).rejects.toThrow(/qualification/i);
    read.mockRestore(); await q.assertRuntimeAvailable(scope()); expect(run).toHaveBeenCalledTimes(2);
  });
  it("reports unconfirmed drain rather than claiming stuck underlying work stopped", async () => {
    let entered!: () => void, settle!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { settle = resolve; });
    vi.spyOn(sentinel, "qualifyVectorSentinel").mockImplementation(async () => { entered(); await held; });
    const q = createLogoProductionRuntimeQualification({ ownerId, workerId, capabilities: [capability()] });
    const work = q.assertRuntimeAvailable(scope()), rejected = expect(work).rejects.toThrow(/qualification/i); await reached;
    vi.useFakeTimers();
    const close = q.close(), unconfirmed = expect(close).rejects.toThrow(/drain is unconfirmed/);
    await vi.advanceTimersByTimeAsync(LOGO_QUALIFICATION_DRAIN_MS); await unconfirmed; await rejected;
    settle(); vi.useRealTimers();
    await expect(q.assertRuntimeAvailable(scope())).rejects.toThrow(/qualification/i);
  });
  it("bounds the real deadline and aborts the underlying sentinel before any proof", async () => {
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const run = vi.spyOn(sentinel, "qualifyVectorSentinel").mockImplementation(async signal => {
      entered(); await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(Error("aborted")), { once: true }));
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const q = qualifier(), work = q.assertRuntimeAvailable(scope()), rejected = expect(work).rejects.toThrow(/qualification/i); await reached;
    await vi.advanceTimersByTimeAsync(LOGO_QUALIFICATION_DEADLINE_MS); await rejected; await q.close();
    expect(run.mock.calls[0]![0].aborted).toBe(true);
  });
});
