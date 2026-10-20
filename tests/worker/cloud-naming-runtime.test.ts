import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { TLSSocket, type PeerCertificate } from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolConfig } from "pg";
import type { CloudNamingConfiguration, CloudNamingMode } from "../../worker/cloud-naming-configuration";
vi.mock("server-only", () => ({}));
const fixture = vi.hoisted(() => ({ pools: [] as EventEmitter[], poolOptions: [] as PoolConfig[], connect: vi.fn(), query: vi.fn(), release: vi.fn(), end: vi.fn(),
  attest: vi.fn(), reportReady: vi.fn(), expire: vi.fn(), handlers: vi.fn(), run: vi.fn(), deployments: [] as string[] }));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  return { Pool: class extends EventEmitter {
    constructor(options: PoolConfig) { super(); fixture.pools.push(this); fixture.poolOptions.push(options); }
    connect = fixture.connect; end = fixture.end;
  } };
});
vi.mock("../../worker/naming-brain-store", () => ({ NamingBrainJobStore: class {
  constructor(_pool: unknown, deployment: string) { fixture.deployments.push(deployment); }
  attestPendingPreferences = fixture.attest; reportReady = fixture.reportReady; expireLeases = fixture.expire;
} }));
vi.mock("../../worker/handlers/naming-brain", () => ({ createNamingBrainHandlers: fixture.handlers }));
vi.mock("../../worker/runner", () => ({ runOneJob: fixture.run }));
import { runCloudNamingWorker, verifyCloudNamingDatabase } from "../../services/naming-worker/runtime";
import { createNamingBrainPolicy } from "../../src/server/ai/naming-brain/policy";
import { Pool } from "pg";

const hostname = "aws-0-us-east-1.pooler.supabase.com";
let socket: TLSSocket;
const identity = () => ({ session_user: "fluid_naming_brain_worker", current_user: "fluid_naming_brain_worker", role_oid: 23033,
  rolcanlogin: true, rolinherit: false, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false,
  rolconnlimit: 4, has_memberships: false, owns_objects: false });
function configuration(): CloudNamingConfiguration {
  return { apiKey: "synthetic-private-provider-key", databaseUrl: "postgresql://synthetic-private-database-url", deploymentId: "synthetic-bound-deployment", paidDispatchEnabled: true,
    policy: createNamingBrainPolicy("gpt-6-luna"), sourceRevision: "a".repeat(40), projectId: "prj_SyntheticNamingWorker", vercelDeploymentId: "dpl_SyntheticNamingDeployment",
    poolOptions: { host: hostname, max: 2, password: "synthetic-private-password" } };
}
function run(controller: AbortController, mode: CloudNamingMode = "run") {
  return runCloudNamingWorker({ configuration: configuration(), mode, signal: controller.signal });
}
beforeEach(() => {
  socket = new TLSSocket(new PassThrough()); socket.authorized = true;
  vi.spyOn(socket, "getProtocol").mockReturnValue("TLSv1.3");
  vi.spyOn(socket, "getPeerCertificate").mockReturnValue({ subjectaltname: `DNS:${hostname}` } as PeerCertificate);
  fixture.connect.mockResolvedValue({ connection: { stream: socket }, query: fixture.query, release: fixture.release });
  fixture.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith("select session_user") ? [identity()] : [] }));
  fixture.end.mockResolvedValue(undefined); fixture.attest.mockResolvedValue(0); fixture.reportReady.mockResolvedValue(true); fixture.expire.mockResolvedValue(0);
  fixture.handlers.mockReturnValue(new Map([["naming.generate", {}]]));
  vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  socket.destroy(); vi.restoreAllMocks(); vi.useRealTimers();
  fixture.pools.length = 0; fixture.poolOptions.length = 0; fixture.deployments.length = 0;
  for (const value of Object.values(fixture)) if (vi.isMockFunction(value)) value.mockReset();
});

describe("cloud Naming read-only native preflight", () => {
  it("checks the actual TLS socket and database identity in a rolled-back read-only transaction", async () => {
    await run(new AbortController(), "preflight");
    expect(fixture.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN READ ONLY", expect.stringContaining("from pg_catalog.pg_roles"), "ROLLBACK"]);
    expect(fixture.release).toHaveBeenCalledWith(undefined); expect(fixture.end).toHaveBeenCalledOnce();
    for (const method of [fixture.attest, fixture.reportReady, fixture.expire, fixture.handlers, fixture.run]) expect(method).not.toHaveBeenCalled();
    expect(fixture.deployments).toEqual([]);
    const log = JSON.parse(vi.mocked(console.info).mock.calls[0]![0] as string);
    expect(log).toEqual({ event: "cloud_naming_preflight_verified", projectId: "prj_SyntheticNamingWorker", vercelDeploymentId: "dpl_SyntheticNamingDeployment", daemon: "naming-worker", sourceRevision: "a".repeat(40),
      restrictedRoleVerified: true, tlsVerified: true, runtimeVerified: true, runtime: { node: "22.22.2", icu: "78.2", unicode: "17.0" }, jobMutations: false, providerCalls: false });
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("synthetic-private");
  });
  it.each([
    ["session_user", "postgres"], ["current_user", "postgres"], ["role_oid", 1], ["rolcanlogin", false], ["rolinherit", true],
    ["rolsuper", true], ["rolbypassrls", true], ["rolcreatedb", true], ["rolcreaterole", true], ["rolreplication", true],
    ["rolconnlimit", -1], ["has_memberships", true], ["owns_objects", true],
  ])("rejects an unqualified database identity (%s)", async (key, value) => {
    fixture.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith("select session_user") ? [{ ...identity(), [key as string]: value }] : [] }));
    await expect(run(new AbortController(), "preflight")).rejects.toThrow("cloud_naming_database_identity_unavailable");
    expect(fixture.query).toHaveBeenLastCalledWith("ROLLBACK"); expect(fixture.release).toHaveBeenCalledWith(expect.any(Error));
    expect(fixture.end).toHaveBeenCalledOnce(); expect(fixture.attest).not.toHaveBeenCalled(); expect(console.info).not.toHaveBeenCalled();
  });
  it.each([{ rows: [] }, { rows: [identity(), identity()] }])("requires exactly one native role row", async ({ rows }) => {
    fixture.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith("select session_user") ? rows : [] }));
    await expect(run(new AbortController(), "preflight")).rejects.toThrow("cloud_naming_database_identity_unavailable");
  });
  it.each(["plain", "unverified", "wrong-host", "obsolete-tls", "authorization-error"])("rejects the actual unsafe TLS connection (%s) before SQL", async invalid => {
    if (invalid === "plain") fixture.connect.mockResolvedValue({ connection: { stream: new PassThrough() }, query: fixture.query, release: fixture.release });
    if (invalid === "unverified") socket.authorized = false;
    if (invalid === "wrong-host") vi.mocked(socket.getPeerCertificate).mockReturnValue({ subjectaltname: "DNS:unapproved.example.invalid" } as PeerCertificate);
    if (invalid === "obsolete-tls") vi.mocked(socket.getProtocol).mockReturnValue("TLSv1.1");
    if (invalid === "authorization-error") socket.authorizationError = new Error("synthetic-private-tls-diagnostic");
    await expect(run(new AbortController(), "preflight")).rejects.toThrow("cloud_naming_database_identity_unavailable");
    expect(fixture.query).not.toHaveBeenCalled(); expect(fixture.end).toHaveBeenCalledOnce(); expect(fixture.attest).not.toHaveBeenCalled();
  });
  it("destroys a client when rollback fails and never reports preflight success", async () => {
    fixture.query.mockImplementation(async (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("synthetic-private-query-diagnostic");
      return { rows: sql.startsWith("select session_user") ? [identity()] : [] };
    });
    await expect(run(new AbortController(), "preflight")).rejects.toThrow("cloud_naming_database_identity_unavailable");
    expect(fixture.release).toHaveBeenCalledWith(expect.any(Error)); expect(console.info).not.toHaveBeenCalled();
  });
  it("redacts connection failures without retaining a private error cause", async () => {
    fixture.connect.mockRejectedValue(Object.assign(new Error("synthetic-private-connect-diagnostic"), { client: { password: "synthetic-private-password" } }));
    const pool = new Pool();
    await expect(verifyCloudNamingDatabase(pool, hostname)).rejects.toThrow(/^cloud_naming_database_identity_unavailable$/u);
    expect(fixture.query).not.toHaveBeenCalled(); expect(fixture.release).not.toHaveBeenCalled();
  });
});

describe("cloud Naming read-only standby", () => {
  it("verifies once without activation, releases the database, and stays idle until shutdown without any Naming mutations", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let settled = false;
    const pending = runCloudNamingWorker({ configuration: { ...configuration(), paidDispatchEnabled: false }, mode: "standby", signal: controller.signal })
      .then(() => { settled = true; });
    await vi.waitFor(() => expect(console.info).toHaveBeenCalledOnce());
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0]![0] as string)).toMatchObject({ event: "cloud_naming_standby_verified",
      restrictedRoleVerified: true, tlsVerified: true, runtimeVerified: true, jobMutations: false, providerCalls: false });
    expect(fixture.end).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(fixture.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN READ ONLY", expect.stringContaining("from pg_catalog.pg_roles"), "ROLLBACK"]);
    expect(fixture.deployments).toEqual([]);
    for (const method of [fixture.attest, fixture.reportReady, fixture.expire, fixture.handlers, fixture.run]) expect(method).not.toHaveBeenCalled();
    controller.abort(); await pending;
    expect(settled).toBe(true); expect(fixture.end).toHaveBeenCalledOnce();
    expect(fixture.pools[0]!.listenerCount("error")).toBe(0);
    expect(console.info).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("synthetic-private");
  });
  it("fails before idle verification when the actual database identity is unqualified", async () => {
    fixture.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith("select session_user") ? [{ ...identity(), rolsuper: true }] : [] }));
    await expect(run(new AbortController(), "standby")).rejects.toThrow("cloud_naming_database_identity_unavailable");
    expect(fixture.end).toHaveBeenCalledOnce(); expect(console.info).not.toHaveBeenCalled();
    expect(fixture.deployments).toEqual([]); expect(fixture.run).not.toHaveBeenCalled();
  });
  it("does not announce standby when shutdown arrives during the connection check", async () => {
    const controller = new AbortController();
    fixture.query.mockImplementation(async (sql: string) => {
      if (sql === "ROLLBACK") controller.abort();
      return { rows: sql.startsWith("select session_user") ? [identity()] : [] };
    });
    await run(controller, "standby");
    expect(fixture.end).toHaveBeenCalledOnce(); expect(console.info).not.toHaveBeenCalled();
    expect(fixture.deployments).toEqual([]); expect(fixture.run).not.toHaveBeenCalled();
  });
});

describe("cloud Naming loop and shutdown", () => {
  it("starts only existing Naming handlers after native qualification and never supplies process-wide authority", async () => {
    const controller = new AbortController(); fixture.run.mockImplementation(async () => { controller.abort(); return "idle"; });
    await run(controller);
    expect(fixture.deployments).toEqual(["synthetic-bound-deployment"]); expect(fixture.attest).toHaveBeenCalledTimes(2);
    expect(fixture.expire).toHaveBeenCalledOnce(); expect(fixture.run).toHaveBeenCalledOnce(); expect(fixture.reportReady).toHaveBeenCalledOnce();
    const invocation = fixture.run.mock.calls[0]![0];
    expect(invocation.workerId).toMatch(/^naming-cloud-[a-f0-9-]{36}$/u);
    expect(invocation.abortGraceMs).toBe(15_000); expect(invocation.signal.aborted).toBe(true); expect(invocation).not.toHaveProperty("localPrototype");
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0]![0] as string)).toMatchObject({ event: "cloud_naming_worker_started", workerId: invocation.workerId });
    expect(fixture.handlers.mock.calls[0]![0]).not.toHaveProperty("localPrototype");
    expect(fixture.end).toHaveBeenCalledOnce(); expect(fixture.pools[0]!.listenerCount("error")).toBe(0);
  });
  it("retains scoped observation after database readiness loss while the provider gate rejects dispatch", async () => {
    fixture.reportReady.mockResolvedValue(false);
    const controller = new AbortController();
    fixture.run.mockImplementation(async () => {
      await expect(fixture.handlers.mock.calls[0]![0].assertReady()).rejects.toThrow("naming_readiness_unavailable");
      controller.abort(); return "needs_reconciliation";
    });
    await run(controller);
    expect(fixture.run).toHaveBeenCalledOnce(); expect(fixture.end).toHaveBeenCalledOnce();
  });
  it.each(["run", "preflight", "standby"] as const)("does not connect in %s after a shutdown already requested", async mode => {
    const controller = new AbortController(); controller.abort(); await run(controller, mode);
    expect(fixture.pools).toHaveLength(0); expect(fixture.connect).not.toHaveBeenCalled();
  });
  it("refuses a direct runtime call with disabled paid dispatch before connecting", async () => {
    await expect(runCloudNamingWorker({ configuration: { ...configuration(), paidDispatchEnabled: false }, mode: "run", signal: new AbortController().signal })).rejects.toThrow("cloud_naming_activation_required");
    expect(fixture.pools).toHaveLength(0); expect(fixture.connect).not.toHaveBeenCalled();
  });
  it("stops before readiness and claims when shutdown arrives during initial preference attestation", async () => {
    const controller = new AbortController();
    fixture.attest.mockImplementation(async () => { controller.abort(); return 0; });
    await run(controller);
    expect(fixture.attest).toHaveBeenCalledOnce(); expect(fixture.reportReady).not.toHaveBeenCalled(); expect(fixture.run).not.toHaveBeenCalled(); expect(fixture.end).toHaveBeenCalledOnce();
  });
  it("fences new provider dispatch on shutdown even while an existing job settles", async () => {
    const controller = new AbortController();
    fixture.run.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
      controller.abort(); expect(signal.aborted).toBe(true);
      await expect(fixture.handlers.mock.calls[0]![0].assertReady()).rejects.toThrow("cloud_naming_stopping");
      return "needs_reconciliation";
    });
    await run(controller);
    expect(fixture.run).toHaveBeenCalledOnce(); expect(fixture.end).toHaveBeenCalledOnce();
  });
  it("closes the pool when preference attestation fails before readiness is created", async () => {
    fixture.attest.mockRejectedValue(new Error("synthetic-private-attestation-error"));
    await expect(run(new AbortController())).rejects.toThrow("synthetic-private-attestation-error");
    expect(fixture.reportReady).not.toHaveBeenCalled(); expect(fixture.run).not.toHaveBeenCalled(); expect(fixture.end).toHaveBeenCalledOnce();
    expect(fixture.pools[0]!.listenerCount("error")).toBe(0);
  });
  it("keeps a healthy job and readiness alive after repeated sanitized idle-client errors", async () => {
    const controller = new AbortController();
    fixture.run.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
      for (let i = 0; i < 3; i++) fixture.pools[0]!.emit("error", Object.assign(new Error("synthetic-private-diagnostic"), {
        cause: { token: "synthetic-private-token" }, client: { password: "synthetic-private-password" },
      }), { connectionParameters: { password: "synthetic-private-pool-client-password" } });
      expect(signal.aborted).toBe(false);
      await expect(fixture.handlers.mock.calls[0]![0].assertReady()).resolves.toBeUndefined();
      expect(signal.aborted).toBe(false);
      controller.abort(); return "succeeded";
    });
    await run(controller);
    expect(fixture.end).toHaveBeenCalledOnce(); expect(fixture.pools[0]!.listenerCount("error")).toBe(0);
    expect(fixture.run).toHaveBeenCalledOnce(); expect(fixture.reportReady).toHaveBeenCalledTimes(2);
    const events = vi.mocked(console.info).mock.calls.map(([event]) => JSON.parse(event as string));
    expect(events.filter(event => event.event === "cloud_naming_database_idle_client_removed")).toEqual(
      Array.from({ length: 3 }, () => ({ event: "cloud_naming_database_idle_client_removed" })));
    expect(events).toContainEqual({ event: "naming_job_cycle", state: "succeeded" });
    expect(console.error).not.toHaveBeenCalled();
    expect(JSON.stringify([vi.mocked(console.info).mock.calls, vi.mocked(console.error).mock.calls])).not.toContain("synthetic-private");
  });
  it("contains an idle-event logging failure without aborting the job or losing cleanup", async () => {
    const controller = new AbortController();
    fixture.run.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
      vi.mocked(console.info).mockImplementationOnce(() => { throw new Error("synthetic-diagnostic-sink-failure"); });
      expect(() => fixture.pools[0]!.emit("error", new Error("synthetic-private-pool-error"))).not.toThrow();
      expect(signal.aborted).toBe(false);
      controller.abort(); return "succeeded";
    });
    await run(controller);
    expect(fixture.run).toHaveBeenCalledOnce(); expect(fixture.end).toHaveBeenCalledOnce();
    expect(fixture.pools[0]!.listenerCount("error")).toBe(0);
  });
  it("keeps an actual readiness query failure fail-closed after an idle event", async () => {
    fixture.reportReady.mockResolvedValueOnce(true).mockRejectedValue(new Error("synthetic-private-readiness-query-error"));
    const controller = new AbortController();
    fixture.run.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
      fixture.pools[0]!.emit("error", new Error("synthetic-private-idle-error"));
      await expect(fixture.handlers.mock.calls[0]![0].assertReady()).rejects.toThrow("naming_readiness_unavailable");
      expect(signal.aborted).toBe(false);
      controller.abort(); return "needs_reconciliation";
    });
    await run(controller);
    expect(fixture.reportReady).toHaveBeenCalledTimes(2); expect(fixture.run).toHaveBeenCalledOnce(); expect(fixture.end).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("synthetic-private");
  });
  it.each(["BEGIN READ ONLY", "select session_user", "ROLLBACK"])("still rejects a checked-out qualification query failure at %s after an idle event", async failedSql => {
    fixture.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith(failedSql)) {
        fixture.pools[0]!.emit("error", new Error("synthetic-private-idle-error"));
        throw new Error("synthetic-private-active-query-error");
      }
      return { rows: sql.startsWith("select session_user") ? [identity()] : [] };
    });
    await expect(run(new AbortController(), "preflight")).rejects.toThrow("cloud_naming_database_identity_unavailable");
    expect(fixture.release).toHaveBeenCalledWith(expect.any(Error)); expect(fixture.end).toHaveBeenCalledOnce();
    expect(fixture.reportReady).not.toHaveBeenCalled(); expect(fixture.run).not.toHaveBeenCalled();
    expect(vi.mocked(console.info).mock.calls.map(([event]) => JSON.parse(event as string)))
      .toEqual([{ event: "cloud_naming_database_idle_client_removed" }]);
  });
  it("drains a manual readiness check before closing the pool during shutdown", async () => {
    let resolve!: (value: boolean) => void;
    const pendingReport = new Promise<boolean>(yes => { resolve = yes; });
    fixture.reportReady.mockResolvedValueOnce(true).mockReturnValueOnce(pendingReport);
    const controller = new AbortController();
    let assertion: Promise<void> | undefined;
    fixture.run.mockImplementation(async () => {
      assertion = fixture.handlers.mock.calls[0]![0].assertReady();
      void assertion!.catch(() => {});
      await Promise.resolve();
      controller.abort(); return "needs_reconciliation";
    });
    let stopped = false;
    const pendingWorker = run(controller).then(() => { stopped = true; });
    await vi.waitFor(() => { expect(fixture.reportReady).toHaveBeenCalledTimes(2); expect(controller.signal.aborted).toBe(true); });
    expect(stopped).toBe(false); expect(fixture.end).not.toHaveBeenCalled();
    resolve(true); await pendingWorker;
    await expect(assertion).rejects.toThrow("naming_readiness_stopped");
    expect(stopped).toBe(true); expect(fixture.end).toHaveBeenCalledOnce();
    expect(fixture.pools[0]!.listenerCount("error")).toBe(0);
  });
  it.each(["heartbeat", "provider_unknown"] as const)("preserves actual runner %s safety after an idle-client event", async failure => {
    const { runOneJob } = await vi.importActual<typeof import("../../worker/runner")>("../../worker/runner");
    const controller = new AbortController();
    const execute = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      fixture.pools[0]!.emit("error", new Error("synthetic-private-idle-error"));
      expect(signal.aborted).toBe(false);
      if (failure === "provider_unknown") throw new Error("synthetic-private-provider-acknowledgement-lost");
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "succeeded" as const, costMicrousd: 0, providerRequestId: "req_synthetic", result: {} };
    });
    const completeStep = vi.fn(async () => {}), finish = vi.fn(async () => {});
    const heartbeat = vi.fn(async () => ({ cancelled: false })).mockResolvedValueOnce({ cancelled: false });
    if (failure === "heartbeat") heartbeat.mockRejectedValue(new Error("synthetic-private-heartbeat-query-error"));
    const store = {
      claim: vi.fn(async () => ({ id: "synthetic-job", ownerId: "synthetic-owner", projectId: "synthetic-project", operation: "synthetic",
        input: {}, inputRevision: 1, leaseToken: "synthetic-lease", status: "running" as const, reservedCostMicrousd: 0, actualCostMicrousd: 0 })),
      registerPlan: vi.fn(async () => {}), heartbeat, beginStep: vi.fn(async () => "started" as const), completeStep, finish,
    };
    fixture.run.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
      const result = await runOneJob({ store, handlers: new Map([["synthetic", { steps: () => [{ key: "issued", maximumCostMicrousd: 0, execute }] }]]),
        workerId: "synthetic", signal, heartbeatMs: 5 });
      expect(result).toBe(failure === "heartbeat" ? "lease_lost" : "needs_reconciliation");
      expect(signal.aborted).toBe(false);
      controller.abort(); return result;
    });
    await run(controller);
    expect(execute).toHaveBeenCalledOnce(); expect(store.claim).toHaveBeenCalledOnce();
    expect(finish).not.toHaveBeenCalled();
    if (failure === "heartbeat") expect(completeStep).not.toHaveBeenCalled();
    else expect(completeStep).toHaveBeenCalledExactlyOnceWith(expect.anything(), "issued", {
      status: "needs_reconciliation", code: "provider_outcome_unknown", costMicrousd: 0, providerRequestId: null,
    });
    expect(fixture.end).toHaveBeenCalledOnce();
  });
  it("wakes promptly from idle delay on shutdown and does not renew readiness afterward", async () => {
    vi.useFakeTimers(); const controller = new AbortController(); fixture.run.mockResolvedValue("idle");
    const pending = run(controller);
    await vi.waitFor(() => expect(fixture.run).toHaveBeenCalledOnce());
    controller.abort(); await pending; const reports = fixture.reportReady.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.run).toHaveBeenCalledOnce(); expect(fixture.reportReady).toHaveBeenCalledTimes(reports); expect(fixture.end).toHaveBeenCalledOnce();
  });
});
