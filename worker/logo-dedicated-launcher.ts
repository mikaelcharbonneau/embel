import "server-only";
import { readFile } from "node:fs/promises";
import type { PoolConfig } from "pg";
import { createLogoDedicatedPool } from "./logo-dedicated-pool";
import { getLogoDedicatedConfiguration, logoDedicatedPoolOptions, type LogoDedicatedConfiguration } from "./logo-dedicated-config";
import { startLogoProductionHost, type LogoProductionHost, type LogoProductionHostOptions } from "./logo-production-host";
import { createLogoGenerativeStorageAuthorization } from "./logo-generative-storage-authorization";
import { createLogoProductionStorageAuthorization } from "./logo-production-storage-authorization";
import type { IdentityPoolPort } from "../src/server/runtime/identity-pool";

export type LogoDedicatedEvent = "disabled" | "unavailable" | "running" | "stop_requested" | "drain_complete" | "drain_unconfirmed" | "disposal_unconfirmed";
export type LogoDedicatedResult = Readonly<{ status: "disabled"; exitCode: 0 } | { status: "unavailable" | "drain_unconfirmed" | "disposal_unconfirmed"; exitCode: 2 }
  | { status: "drained"; reason: "signal" | "idle_pool_error" | "runtime_failure"; exitCode: 0 | 1 }>;
export interface LogoDedicatedPool extends IdentityPoolPort {
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  end(): Promise<void>;
}
export type LogoDedicatedDependencies = {
  createPool(options: PoolConfig): LogoDedicatedPool;
  startHost(options: LogoProductionHostOptions): Promise<LogoProductionHost>;
  signals: { on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown; removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown };
  emit(event: LogoDedicatedEvent): void;
};
const defaults: LogoDedicatedDependencies = {
  createPool: createLogoDedicatedPool, startHost: startLogoProductionHost, signals: process,
  emit(event) { const message = JSON.stringify({ event: `logo_worker_${event}` });
    if (event === "unavailable" || event.endsWith("unconfirmed")) console.error(message); else console.info(message); },
};

/** One manually invoked process owner. Uses real brokers and host by default;
 * injected pool/host/event ports are for synthetic lifecycle checks only.
 * No environment/credential discovery, grant, refresh, retry or restart.
 * A resolved close proves tracked host drain, not OS/HTTP cessation. */
export async function runLogoDedicatedWorker(configuration: LogoDedicatedConfiguration, dependencies: LogoDedicatedDependencies = defaults): Promise<LogoDedicatedResult> {
  // Diagnostics are best effort and must never bypass a shutdown fence.
  const emit = (event: LogoDedicatedEvent) => { try { dependencies.emit(event); } catch { /* No private logger error may escape. */ } };
  if (configuration.status === "disabled") { emit("disabled"); return Object.freeze({ status: "disabled", exitCode: 0 }); }
  const c = getLogoDedicatedConfiguration(configuration);
  if (!c) { emit("unavailable"); return Object.freeze({ status: "unavailable", exitCode: 2 }); }
  const lifetime = new AbortController(), authorizations: { close(): void }[] = [];
  let pool: LogoDedicatedPool | undefined, host: LogoProductionHost | undefined, closing: Promise<void> | undefined;
  let hostInvoked = false, reason: "signal" | "idle_pool_error" | "runtime_failure" | undefined;
  function closeHost(): Promise<void> {
    if (closing) return closing;
    if (!host) return Promise.resolve();
    try { closing = Promise.resolve(host.close()); } catch { closing = Promise.reject(new Error("Logo dedicated drain is unconfirmed.")); }
    // A signal may start this promise before the main flow awaits it.
    void closing.catch(() => {}); return closing;
  }
  function stop(cause: "signal" | "idle_pool_error" | "runtime_failure") {
    // A later actual failure must not be masked by an earlier ordinary signal.
    if (!reason || reason === "signal" && cause !== "signal") reason = cause;
    if (!lifetime.signal.aborted) { lifetime.abort(); emit("stop_requested"); }
    if (host) void closeHost().catch(() => {});
  }
  const onSignal = () => stop("signal"), onPoolError = () => stop("idle_pool_error");
  const removeSignals = () => { dependencies.signals.removeListener("SIGINT", onSignal); dependencies.signals.removeListener("SIGTERM", onSignal); };
  dependencies.signals.on("SIGINT", onSignal); dependencies.signals.on("SIGTERM", onSignal);
  try {
    const brokerConfiguration = { ownerId: c.binding.ownerId, authUserId: c.storage.authUserId, workerRoleName: c.binding.roleName,
      workerRoleOid: c.binding.roleOid, workerId: c.workerId, publishableKey: c.storage.publishableKey, accessToken: c.storage.accessToken };
    const selected: Pick<Extract<LogoProductionHostOptions, { enabled: true }>, "concepts" | "refinements" | "vector" | "exports"> = {};
    for (const lane of ["concepts", "refinements"] as const) {
      const capability = c.operations[lane]; if (!capability) continue;
      const authorization = createLogoGenerativeStorageAuthorization({ ...brokerConfiguration, capability });
      if (!authorization || !c.image) throw new Error("Logo dedicated configuration is unavailable.");
      authorizations.push(authorization); selected[lane] = { capability, authorization, image: c.image };
    }
    for (const lane of ["vector", "exports"] as const) {
      const capability = c.operations[lane]; if (!capability) continue;
      const authorization = createLogoProductionStorageAuthorization({ ...brokerConfiguration, capability });
      if (!authorization) throw new Error("Logo dedicated configuration is unavailable.");
      authorizations.push(authorization); selected[lane] = { capability, authorization };
    }
    const certificate = await readFile(new URL("../scripts/certs/supabase-prod-ca-2021.crt", import.meta.url), "utf8");
    if (lifetime.signal.aborted) {
      for (const authorization of authorizations) authorization.close(); removeSignals(); emit("drain_complete");
      return Object.freeze({ status: "drained", reason: reason ?? "signal", exitCode: reason === "idle_pool_error" || reason === "runtime_failure" ? 1 : 0 });
    }
    pool = dependencies.createPool(logoDedicatedPoolOptions(configuration, certificate));
    pool.on("error", onPoolError);
    hostInvoked = true;
    host = await dependencies.startHost({ enabled: true, binding: c.binding, workerId: c.workerId, pool, signal: lifetime.signal, ...selected });
    if (host.status === "qualified" && !lifetime.signal.aborted) {
      emit("running");
      try { await host.run(lifetime.signal); } catch { stop("runtime_failure"); }
    }
    // A late construction result is closed even when its lifetime was already
    // aborted. Keep brokers and pool alive until BOTH run and close have settled.
    await closeHost();
  } catch {
    if (hostInvoked) {
      stop("runtime_failure");
      // Constructor may throw precisely because its internal close rejected.
      // Without a returned handle there is no additional safe drain proof.
      emit("drain_unconfirmed"); return Object.freeze({ status: "drain_unconfirmed", exitCode: 2 });
    }
    // No host received these resources, so no checked-out or leased work exists.
    for (const authorization of authorizations) authorization.close();
    if (pool) {
      try { await pool.end(); pool.removeListener("error", onPoolError); }
      catch { emit("disposal_unconfirmed"); return Object.freeze({ status: "disposal_unconfirmed", exitCode: 2 }); }
    }
    removeSignals(); emit("unavailable"); return Object.freeze({ status: "unavailable", exitCode: 2 });
  }
  // This is intentionally unreachable after unconfirmed host drain. No forced
  // exit or deadline is substituted for either host or driver confirmation.
  for (const authorization of authorizations) authorization.close();
  try { await pool!.end(); }
  catch { emit("disposal_unconfirmed"); return Object.freeze({ status: "disposal_unconfirmed", exitCode: 2 }); }
  pool!.removeListener("error", onPoolError); removeSignals();
  if (host!.status !== "qualified") { emit("unavailable"); return Object.freeze({ status: "unavailable", exitCode: 2 }); }
  emit("drain_complete");
  return Object.freeze({ status: "drained", reason: reason ?? "runtime_failure", exitCode: reason === "signal" ? 0 : 1 });
}
