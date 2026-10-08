import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { logoHttpFixture } from "../../fixtures/logo-http-runtime";
import type { AuthenticatedContext } from "@/server/auth/context";
import type { LogoServiceDependencies } from "@/server/runtime/logo-services";

beforeEach(() => { Reflect.deleteProperty(globalThis, Symbol.for("fluid.logo.request-services.v1")); vi.resetModules(); });
const runtime = () => import("@/server/runtime/logo-request-services");
describe("per-request logo runtime gate", () => {
  it("is unavailable by default and does no privileged I/O", async () => {
    const f = logoHttpFixture(), { resolveLogoRequestServices } = await runtime();
    const service = await resolveLogoRequestServices(f.auth, f.projectId);
    expect(service.configured).toBe(false);
    await expect(service.workspace.saveLogoEdit(f.auth, f.projectId, f.edit)).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(f.connect).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });
  it("retains the same once-only installation across independently loaded server modules", async () => {
    const f = logoHttpFixture(), first = await runtime();
    first.configureLogoRequestServices(async () => ({ ownerId: f.ownerId, projectId: f.projectId, dependencies: f.dependencies }));
    vi.resetModules(); const routeCopy = await runtime();
    expect((await routeCopy.resolveLogoRequestServices(f.auth, f.projectId)).configured).toBe(true);
    expect(() => routeCopy.configureLogoRequestServices(async () => null)).toThrow();
  });
  it("installs exactly once with zero I/O and resolves fresh services after checked ownership", async () => {
    const f = logoHttpFixture(), loadedRuntime = await runtime(), signal = new AbortController().signal;
    const resolve = vi.fn(async (auth, projectId, receivedSignal) => {
      expect(auth).toBe(f.auth); expect(projectId).toBe(f.projectId); expect(receivedSignal).toBe(signal);
      expect(f.rpcCalls.at(-1)).toMatchObject({ name: "get_logo_workspace", signal });
      return { ownerId: f.ownerId, projectId, dependencies: f.dependencies };
    });
    loadedRuntime.configureLogoRequestServices(resolve);
    expect(f.rpcCalls).toEqual([]); expect(resolve).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
    const first = await loadedRuntime.resolveLogoRequestServices(f.auth, f.projectId, signal), second = await loadedRuntime.resolveLogoRequestServices(f.auth, f.projectId, signal);
    expect(first.configured).toBe(true); expect(first).not.toBe(second); expect(first.assets).not.toBe(second.assets); expect(resolve).toHaveBeenCalledTimes(2);
    expect(f.workspace.capabilities.upload.status).toBe("unavailable");
    expect(() => loadedRuntime.configureLogoRequestServices(resolve)).toThrow(); expect(() => loadedRuntime.configureLogoRequestServices(async () => null)).toThrow();
  });
  it("keeps an explicitly unresolved project unavailable without invoking privileged ports", async () => {
    const f = logoHttpFixture(), loadedRuntime = await runtime(); loadedRuntime.configureLogoRequestServices(async () => null);
    expect((await loadedRuntime.resolveLogoRequestServices(f.auth, f.projectId)).configured).toBe(false);
    expect(f.rpcCalls).toHaveLength(1); expect(f.connect).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(["owner", "project", "malformed"])("rejects a %s workspace before resolving dependencies", async mismatch => {
    const f = logoHttpFixture(), loadedRuntime = await runtime(), resolver = vi.fn(async () => ({ ownerId: f.ownerId, projectId: f.projectId, dependencies: f.dependencies }));
    f.controls.workspace = mismatch === "malformed" ? {} : { ...f.workspace, [mismatch === "owner" ? "ownerId" : "projectId"]: crypto.randomUUID() };
    loadedRuntime.configureLogoRequestServices(resolver);
    await expect(loadedRuntime.resolveLogoRequestServices(f.auth, f.projectId)).rejects.toBeDefined(); expect(resolver).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
  });
  it.each(["owner", "project", "invalid"])("rejects a resolver %s mismatch without connecting or reading storage", async mismatch => {
    const f = logoHttpFixture(), loadedRuntime = await runtime();
    loadedRuntime.configureLogoRequestServices(async () => ({ ownerId: mismatch === "owner" ? crypto.randomUUID() : f.ownerId, projectId: mismatch === "project" ? crypto.randomUUID() : f.projectId, dependencies: mismatch === "invalid" ? {} as LogoServiceDependencies : f.dependencies }));
    await expect(loadedRuntime.resolveLogoRequestServices(f.auth, f.projectId)).rejects.toMatchObject({ code: mismatch === "invalid" ? "integration_unavailable" : "not_found" });
    expect(f.connect).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });
  it("validates UUIDs, verified-auth shape and cancellation before any resolution or I/O", async () => {
    const f = logoHttpFixture(), loadedRuntime = await runtime(), resolver = vi.fn(); loadedRuntime.configureLogoRequestServices(resolver);
    await expect(loadedRuntime.resolveLogoRequestServices({ ...f.auth, userId: "invalid" }, f.projectId)).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(loadedRuntime.resolveLogoRequestServices({ userId: f.ownerId } as AuthenticatedContext, f.projectId)).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(loadedRuntime.resolveLogoRequestServices(f.auth, "invalid")).rejects.toMatchObject({ code: "not_found" });
    const controller = new AbortController(); controller.abort();
    await expect(loadedRuntime.resolveLogoRequestServices(f.auth, f.projectId, controller.signal)).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(resolver).not.toHaveBeenCalled(); expect(f.rpcCalls).toEqual([]);
  });
  it("propagates cancellation to the awaited authenticated ownership reader", async () => {
    const f = logoHttpFixture(), loadedRuntime = await runtime(), controller = new AbortController(), resolver = vi.fn();
    loadedRuntime.configureLogoRequestServices(resolver); let started!: (signal?: AbortSignal) => void;
    const held = new Promise<AbortSignal | undefined>(resolve => { started = resolve; }); f.controls.holdRpc = () => true; f.controls.heldRpc = started;
    const result = loadedRuntime.resolveLogoRequestServices(f.auth, f.projectId, controller.signal).catch(error => error);
    expect(await held).toBe(controller.signal); controller.abort(); expect(await result).toMatchObject({ code: "integration_unavailable" }); expect(resolver).not.toHaveBeenCalled();
  });
  it("fences a late resolver result after abort without creating privileged work", async () => {
    const f = logoHttpFixture(), loadedRuntime = await runtime(), controller = new AbortController();
    loadedRuntime.configureLogoRequestServices(async () => { controller.abort(); return { ownerId: f.ownerId, projectId: f.projectId, dependencies: f.dependencies }; });
    await expect(loadedRuntime.resolveLogoRequestServices(f.auth, f.projectId, controller.signal)).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(f.connect).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });
  it("settles an aborted request even while a trusted resolver is still pending", async () => {
    const f = logoHttpFixture(), loadedRuntime = await runtime(), controller = new AbortController();
    let started!: () => void, complete!: (value: null) => void;
    const held = new Promise<void>(resolve => { started = resolve; });
    loadedRuntime.configureLogoRequestServices(() => { started(); return new Promise<null>(resolve => { complete = resolve; }); });
    const result = loadedRuntime.resolveLogoRequestServices(f.auth, f.projectId, controller.signal).then(() => "unexpected success", error => error);
    await held; controller.abort();
    try {
      const observed = await Promise.race([result, new Promise<string>(resolve => setTimeout(() => resolve("still pending after abort"), 100))]);
      expect(observed).toMatchObject({ code: "integration_unavailable" });
    } finally { complete(null); await result; }
    expect(f.connect).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });
  it("cannot inject a worker connection through structurally wider resolver data", async () => {
    const f = logoHttpFixture(), loadedRuntime = await runtime(), query = vi.fn();
    loadedRuntime.configureLogoRequestServices(async () => ({ ownerId: f.ownerId, projectId: f.projectId, dependencies: { ...f.dependencies, worker: { query } } }));
    const services = await loadedRuntime.resolveLogoRequestServices(f.auth, f.projectId);
    // HTTP resolution deliberately strips the optional worker capability.
    const { syntheticLogoJob } = await import("../../fixtures/logo-creation");
    const job = { ...syntheticLogoJob(), ownerId: f.ownerId, projectId: f.projectId };
    await expect(services.assets.readLeasedAsset(job, f.raster.reference)).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(query).not.toHaveBeenCalled(); expect(services.configured).toBe(true);
  });
});
