import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { TLSSocket, type PeerCertificate } from "node:tls";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { runCloudLogoWorker, verifyCloudLogoDatabase, type CloudLogoDependencies } from "../../services/logo-worker/runtime";
import { CLOUD_LOGO_BINDING, CLOUD_LOGO_STORAGE_USER_ID, CLOUD_LOGO_WORKER_ID, type CloudLogoMode } from "../../worker/cloud-logo-configuration";
import { cloudLogoConfiguration, cloudLogoEnv, cloudLogoSecret, cloudLogoToken } from "./cloud-logo-fixture";

function fixture(mode: CloudLogoMode = "run") {
  const order: string[] = [], controller = new AbortController();
  const pool = Object.assign(new EventEmitter(), { end: vi.fn(async () => { order.push("pool.close"); }) }) as unknown as Pool;
  const session = { tokenProvider: vi.fn(async () => cloudLogoToken()), close: vi.fn(async () => { order.push("session.close"); }) };
  const host = { status: "qualified" as const, manifest: [], close: vi.fn(async () => { order.push("host.close"); }),
    run: vi.fn(async () => { order.push("host.run"); controller.abort(); }) };
  const dependencies = {
    createPool: vi.fn(() => pool), verifyDatabase: vi.fn(async () => { order.push("database.verified"); }),
    createSession: vi.fn(async () => { order.push("session.created"); return session; }),
    verifySession: vi.fn(async () => { order.push("session.verified"); }),
    startHost: vi.fn<CloudLogoDependencies["startHost"]>(async () => { order.push("host.created"); return host; }),
    qualifyRaster: vi.fn(async () => { order.push("raster.verified"); }), emit: vi.fn(),
  } satisfies CloudLogoDependencies;
  return { order, controller, pool, session, host, dependencies,
    run: () => runCloudLogoWorker({ configuration: cloudLogoConfiguration(mode), mode, signal: controller.signal }, dependencies) };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("cloud Logo safe modes and actual host composition", () => {
  it("qualifies raster, native DB, Auth/session and image host before starting the existing run loop", async () => {
    const f = fixture(); await f.run();
    expect(f.order).toEqual(["raster.verified", "database.verified", "session.created", "session.verified", "host.created", "host.run", "host.close", "pool.close", "session.close"]);
    const options = f.dependencies.startHost.mock.calls[0]![0];
    if (!options.enabled) throw new Error("Synthetic cloud host was not enabled.");
    expect(options).toMatchObject({ enabled: true, binding: CLOUD_LOGO_BINDING, workerId: CLOUD_LOGO_WORKER_ID });
    expect(Object.keys(options).sort()).toEqual(["binding", "concepts", "enabled", "pool", "refinements", "signal", "workerId"]);
    expect(options.concepts?.authorization?.ownerId).toBe(CLOUD_LOGO_BINDING.ownerId);
    expect(f.dependencies.emit.mock.calls.map(([event]) => event.event)).toEqual(["cloud_logo_worker_started", "cloud_logo_drain_complete"]);
    expect(f.pool.listenerCount("error")).toBe(0);
    expect(JSON.stringify(f.dependencies.emit.mock.calls)).not.toContain(cloudLogoSecret);
  });
  it("preflight never invokes the run loop and disposes before reporting verification", async () => {
    const f = fixture("preflight");
    f.dependencies.emit.mockImplementation(() => { expect(f.order.slice(-3)).toEqual(["host.close", "pool.close", "session.close"]); });
    await f.run();
    expect(f.host.run).not.toHaveBeenCalled();
    expect(f.dependencies.emit).toHaveBeenCalledWith(expect.objectContaining({ event: "cloud_logo_preflight_verified",
      restrictedRoleVerified: true, tlsVerified: true, storageSessionVerified: true, rasterVerified: true, jobMutations: false, providerCalls: false }));
  });
  it("standby stays idle with session resources and pools disposed and does no periodic service I/O", async () => {
    vi.useFakeTimers(); const f = fixture("standby"); let finished = false;
    const pending = f.run().then(() => { finished = true; });
    await vi.waitFor(() => expect(f.dependencies.emit).toHaveBeenCalledOnce());
    expect(f.host.close).toHaveBeenCalledOnce(); expect(f.pool.end).toHaveBeenCalledOnce(); expect(f.session.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(finished).toBe(false); expect(f.dependencies.verifyDatabase).toHaveBeenCalledOnce(); expect(f.dependencies.createSession).toHaveBeenCalledOnce();
    expect(f.host.run).not.toHaveBeenCalled();
    f.controller.abort(); await pending;
    expect(finished).toBe(true); expect(f.dependencies.emit).toHaveBeenCalledOnce();
  });
  it("rejects forged handles and cross-mode activation before any runtime dependency", async () => {
    const f = fixture();
    await expect(runCloudLogoWorker({ configuration: { ...cloudLogoConfiguration() }, mode: "run", signal: f.controller.signal }, f.dependencies)).rejects.toThrow("cloud_logo_runtime_unavailable");
    const env = cloudLogoEnv(); delete env.EMBEL_LOGO_CLOUD_ACTIVATED;
    await expect(runCloudLogoWorker({ configuration: cloudLogoConfiguration("preflight", env), mode: "run", signal: f.controller.signal }, f.dependencies)).rejects.toThrow("cloud_logo_runtime_unavailable");
    expect(f.dependencies.qualifyRaster).not.toHaveBeenCalled(); expect(f.dependencies.createPool).not.toHaveBeenCalled();
  });
  it.each(["run", "preflight", "standby"] as const)("does nothing after shutdown already requested in %s", async mode => {
    const f = fixture(mode); f.controller.abort(); await f.run();
    expect(f.dependencies.qualifyRaster).not.toHaveBeenCalled(); expect(f.dependencies.createPool).not.toHaveBeenCalled();
  });
});

describe("cloud Logo shutdown and failure classification", () => {
  it.each(["verifyDatabase", "createSession", "verifySession", "startHost"] as const)("retains pool failure during %s as failure through early shutdown", async step => {
    const f = fixture("preflight"), original = f.dependencies[step].getMockImplementation()!;
    f.dependencies[step].mockImplementation((async (...args: unknown[]) => {
      f.pool.emit("error", new Error(cloudLogoSecret));
      return Reflect.apply(original, undefined, args);
    }) as never);
    await expect(f.run()).rejects.toThrow(/^cloud_logo_runtime_unavailable$/u);
    expect(f.host.run).not.toHaveBeenCalled(); expect(f.dependencies.emit).not.toHaveBeenCalled(); expect(f.pool.end).toHaveBeenCalledOnce();
  });
  it("treats a pool error during disposal as failure and never announces standby", async () => {
    const f = fixture("standby"); vi.mocked(f.pool.end).mockImplementation(async () => { f.pool.emit("error", new Error(cloudLogoSecret)); });
    await expect(f.run()).rejects.toThrow(/^cloud_logo_runtime_unavailable$/u); expect(f.dependencies.emit).not.toHaveBeenCalled();
  });
  it.each(["qualifyRaster", "verifyDatabase", "createSession", "verifySession", "startHost"] as const)("stops cleanly when a signal arrives during %s", async step => {
    const f = fixture("preflight"), original = f.dependencies[step].getMockImplementation()!;
    f.dependencies[step].mockImplementation((async (...args: unknown[]) => {
      f.controller.abort(); return Reflect.apply(original, undefined, args);
    }) as never);
    await f.run(); expect(f.host.run).not.toHaveBeenCalled(); expect(f.dependencies.emit).not.toHaveBeenCalled();
    if (step !== "qualifyRaster") expect(f.pool.end).toHaveBeenCalledOnce();
  });
  it("retains the Storage session and pool until an already dispatched host run has settled", async () => {
    const f = fixture(); let finish!: () => void;
    f.host.run.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.run(); await vi.waitFor(() => expect(f.host.run).toHaveBeenCalledOnce());
    f.controller.abort();
    expect(f.pool.end).not.toHaveBeenCalled(); expect(f.session.close).not.toHaveBeenCalled();
    finish(); await pending;
    expect(f.host.close).toHaveBeenCalledOnce(); expect(f.order.slice(-3)).toEqual(["host.close", "pool.close", "session.close"]);
  });
  it.each(["constructor", "close"])("retains resources when %s cannot prove host drain", async phase => {
    const f = fixture();
    if (phase === "constructor") f.dependencies.startHost.mockRejectedValue(new Error(cloudLogoSecret));
    else f.host.close.mockRejectedValue(new Error(cloudLogoSecret));
    await expect(f.run()).rejects.toThrow(/^cloud_logo_drain_unconfirmed$/u);
    expect(f.pool.end).not.toHaveBeenCalled(); expect(f.session.close).not.toHaveBeenCalled();
    expect(f.dependencies.emit.mock.calls.some(([event]) => event.event === "cloud_logo_drain_complete")).toBe(false);
  });
  it("keeps session resources when pool disposal is unconfirmed", async () => {
    const f = fixture(); vi.mocked(f.pool.end).mockRejectedValue(new Error(cloudLogoSecret));
    await expect(f.run()).rejects.toThrow(/^cloud_logo_disposal_unconfirmed$/u);
    expect(f.session.close).not.toHaveBeenCalled();
  });
  it("redacts startup/host failures and still disposes confirmed resources", async () => {
    const f = fixture(); f.dependencies.verifySession.mockRejectedValue(new Error(cloudLogoSecret));
    await expect(f.run()).rejects.toEqual(new Error("cloud_logo_runtime_unavailable"));
    expect(f.pool.end).toHaveBeenCalledOnce(); expect(f.session.close).toHaveBeenCalledOnce(); expect(f.host.run).not.toHaveBeenCalled();
  });
  it("does not interpret an unexpected host-loop return as clean signal shutdown", async () => {
    const f = fixture(); f.host.run.mockResolvedValue(undefined);
    await expect(f.run()).rejects.toThrow(/^cloud_logo_runtime_unavailable$/u);
    expect(f.host.close).toHaveBeenCalledOnce(); expect(f.session.close).toHaveBeenCalledOnce();
  });
});

describe("cloud Logo native database qualification", () => {
  const hostname = "aws-0-us-east-1.pooler.supabase.com";
  const row = () => ({ session_user: CLOUD_LOGO_BINDING.roleName, current_user: CLOUD_LOGO_BINDING.roleName,
    role_oid: CLOUD_LOGO_BINDING.roleOid, owner_id: CLOUD_LOGO_BINDING.ownerId, rolcanlogin: true, rolinherit: false,
    rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolconnlimit: -1,
    has_memberships: false, owns_objects: false });
  function databaseFixture() {
    const socket = new TLSSocket(new PassThrough()); socket.authorized = true;
    vi.spyOn(socket, "getProtocol").mockReturnValue("TLSv1.3");
    vi.spyOn(socket, "getPeerCertificate").mockReturnValue({ subjectaltname: `DNS:${hostname}` } as PeerCertificate);
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("select session_user") ? [row()] : [] })), release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ connection: { stream: socket }, query, release })) } as unknown as Pool;
    return { socket, query, release, pool };
  }
  it("proves native TLS, exact principal and owner in a rolled back read-only transaction", async () => {
    const f = databaseFixture();
    try { await verifyCloudLogoDatabase(f.pool, hostname); }
    finally { f.socket.destroy(); }
    expect(f.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN READ ONLY", expect.stringContaining("fluid_private.logo_worker_owner()"), "ROLLBACK"]);
    expect(f.release).toHaveBeenCalledWith(undefined);
  });
  it.each([
    ["session_user", "postgres"], ["current_user", "postgres"], ["role_oid", 1], ["owner_id", CLOUD_LOGO_STORAGE_USER_ID],
    ["rolcanlogin", false], ["rolinherit", true], ["rolsuper", true], ["rolbypassrls", true], ["rolcreatedb", true],
    ["rolcreaterole", true], ["rolreplication", true], ["rolconnlimit", 4], ["has_memberships", true], ["owns_objects", true],
  ])("rejects changed native %s and discards the connection", async (key, value) => {
    const f = databaseFixture();
    f.query.mockImplementation(async sql => ({ rows: sql.startsWith("select session_user") ? [{ ...row(), [key as string]: value }] : [] }));
    try { await expect(verifyCloudLogoDatabase(f.pool, hostname)).rejects.toThrow(/^cloud_logo_database_identity_unavailable$/u); }
    finally { f.socket.destroy(); }
    expect(f.query).toHaveBeenLastCalledWith("ROLLBACK"); expect(f.release).toHaveBeenCalledWith(expect.any(Error));
  });
  it.each(["unverified", "wrong-host", "obsolete-tls", "authorization-error"])("rejects actual unsafe TLS %s before SQL", async kind => {
    const f = databaseFixture();
    if (kind === "unverified") f.socket.authorized = false;
    if (kind === "wrong-host") vi.mocked(f.socket.getPeerCertificate).mockReturnValue({ subjectaltname: "DNS:example.invalid" } as PeerCertificate);
    if (kind === "obsolete-tls") vi.mocked(f.socket.getProtocol).mockReturnValue("TLSv1.1");
    if (kind === "authorization-error") f.socket.authorizationError = new Error(cloudLogoSecret);
    try { await expect(verifyCloudLogoDatabase(f.pool, hostname)).rejects.toThrow(/^cloud_logo_database_identity_unavailable$/u); }
    finally { f.socket.destroy(); }
    expect(f.query).not.toHaveBeenCalled();
  });
  it("rejects rollback failure without exposing driver diagnostics", async () => {
    const f = databaseFixture();
    f.query.mockImplementation(async sql => { if (sql === "ROLLBACK") throw new Error(cloudLogoSecret); return { rows: [row()] }; });
    try { await expect(verifyCloudLogoDatabase(f.pool, hostname)).rejects.toEqual(new Error("cloud_logo_database_identity_unavailable")); }
    finally { f.socket.destroy(); }
    expect(f.release).toHaveBeenCalledWith(expect.any(Error));
  });
});
