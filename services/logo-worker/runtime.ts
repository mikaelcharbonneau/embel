import { checkServerIdentity, TLSSocket } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool, PoolConfig } from "pg";
import JavaScriptClient from "pg/lib/client.js";
import JavaScriptPool from "pg-pool";
import { z } from "zod";
import { CLOUD_LOGO_BINDING, CLOUD_LOGO_DAEMON_NAME, CLOUD_LOGO_RUNTIME, cloudLogoPoolOptions, getCloudLogoConfiguration,
  type CloudLogoConfiguration, type CloudLogoMode } from "../../worker/cloud-logo-configuration";
import { getLogoDedicatedConfiguration, parseLogoDedicatedConfiguration } from "../../worker/logo-dedicated-config";
import { createLocalLogoStorageSession, verifyLocalLogoStorageSession } from "../../worker/logo-local-storage-session";
import { createLogoGenerativeStorageAuthorization, type LogoGenerativeStorageAuthorization } from "../../worker/logo-generative-storage-authorization";
import { startLogoProductionHost, type LogoProductionHost, type LogoProductionHostOptions } from "../../worker/logo-production-host";
import { qualifyCloudLogoRaster } from "./raster-qualification";

const unavailable = () => new Error("cloud_logo_runtime_unavailable");
const identitySchema = z.strictObject({ session_user: z.literal(CLOUD_LOGO_BINDING.roleName), current_user: z.literal(CLOUD_LOGO_BINDING.roleName),
  role_oid: z.literal(CLOUD_LOGO_BINDING.roleOid), owner_id: z.literal(CLOUD_LOGO_BINDING.ownerId), rolcanlogin: z.literal(true),
  rolinherit: z.literal(false), rolsuper: z.literal(false), rolbypassrls: z.literal(false), rolcreatedb: z.literal(false),
  rolcreaterole: z.literal(false), rolreplication: z.literal(false), rolconnlimit: z.literal(-1), has_memberships: z.literal(false), owns_objects: z.literal(false) });

/** Actual native TLS/login/owner proof, read only and rolled back. No readiness,
 * claim, expiration, asset authorization or provider operation is called. */
export async function verifyCloudLogoDatabase(pool: Pool, hostname: string): Promise<void> {
  let client;
  try { client = await pool.connect(); } catch { throw new Error("cloud_logo_database_identity_unavailable"); }
  let transaction = false, failure: Error | undefined;
  try {
    const socket = client.connection.stream;
    if (!(socket instanceof TLSSocket) || !socket.encrypted || !socket.authorized || socket.authorizationError
      || !["TLSv1.2", "TLSv1.3"].includes(socket.getProtocol() ?? "") || checkServerIdentity(hostname, socket.getPeerCertificate())) throw new Error();
    await client.query("BEGIN READ ONLY"); transaction = true;
    const result = await client.query(`select session_user, current_user, r.oid::integer as role_oid,
      fluid_private.logo_worker_owner()::text as owner_id,
      r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolconnlimit,
      exists(select 1 from pg_catalog.pg_auth_members m where m.member = r.oid) as has_memberships,
      exists(select 1 from pg_catalog.pg_shdepend d where d.refclassid = 'pg_catalog.pg_authid'::regclass
        and d.refobjid = r.oid and d.deptype = 'o') as owns_objects
      from pg_catalog.pg_roles r where r.rolname = session_user`);
    if (result.rows.length !== 1) throw new Error(); identitySchema.parse(result.rows[0]);
  } catch { failure = new Error("cloud_logo_database_identity_unavailable"); }
  finally {
    if (transaction) try { await client.query("ROLLBACK"); } catch { failure = new Error("cloud_logo_database_identity_unavailable"); }
    client.release(failure);
  }
  if (failure) throw failure;
}

type Phase = "raster_qualification" | "database_qualification" | "storage_sign_in" | "storage_configuration" | "storage_session_verification"
  | "host_construction" | "host_run" | "host_drain" | "pool_disposal" | "storage_session_disposal" | "standby";
type FailureReason = "raster_qualification_failed" | "database_qualification_failed" | "storage_sign_in_failed" | "storage_configuration_failed"
  | "storage_session_verification_failed" | "host_construction_failed" | "host_unavailable" | "host_run_failed" | "host_returned_without_shutdown"
  | "host_drain_unconfirmed" | "pool_disposal_unconfirmed" | "storage_session_disposal_unconfirmed" | "standby_wait_failed";
const phaseFailure: Readonly<Record<Phase, FailureReason>> = Object.freeze({
  raster_qualification: "raster_qualification_failed", database_qualification: "database_qualification_failed", storage_sign_in: "storage_sign_in_failed",
  storage_configuration: "storage_configuration_failed", storage_session_verification: "storage_session_verification_failed",
  host_construction: "host_construction_failed", host_run: "host_run_failed", host_drain: "host_drain_unconfirmed", pool_disposal: "pool_disposal_unconfirmed",
  storage_session_disposal: "storage_session_disposal_unconfirmed", standby: "standby_wait_failed",
});
type Event = { event: "cloud_logo_preflight_verified" | "cloud_logo_standby_verified" | "cloud_logo_worker_started" | "cloud_logo_drain_complete"
    | "cloud_logo_database_idle_client_removed" | "cloud_logo_runtime_failure";
  projectId: string; vercelDeploymentId: string; daemon: string; sourceRevision: string;
  phase?: Phase; reason?: FailureReason;
  restrictedRoleVerified?: boolean; tlsVerified?: boolean; storageSessionVerified?: boolean; rasterVerified?: boolean; jobMutations?: boolean; providerCalls?: boolean };
export type CloudLogoDependencies = {
  createPool(options: PoolConfig): Pool; verifyDatabase: typeof verifyCloudLogoDatabase;
  createSession: typeof createLocalLogoStorageSession; verifySession: typeof verifyLocalLogoStorageSession;
  startHost(options: LogoProductionHostOptions): Promise<LogoProductionHost>; qualifyRaster(signal: AbortSignal): Promise<void>;
  emit(event: Event): void;
};
const defaults: CloudLogoDependencies = {
  // Direct JS subpaths avoid pg's eager NODE_PG_FORCE_NATIVE selection before
  // qualification; explicit Client also prevents pg-pool's root-import fallback.
  createPool: options => new JavaScriptPool({ ...options, Client: JavaScriptClient }), verifyDatabase: verifyCloudLogoDatabase,
  createSession: createLocalLogoStorageSession, verifySession: verifyLocalLogoStorageSession,
  startHost: startLogoProductionHost, qualifyRaster: qualifyCloudLogoRaster,
  emit: event => (event.event === "cloud_logo_runtime_failure" ? console.error : console.info)(JSON.stringify({ ...event, runtime: CLOUD_LOGO_RUNTIME })),
};

export async function runCloudLogoWorker(options: { configuration: CloudLogoConfiguration; mode: CloudLogoMode; signal: AbortSignal },
  dependencies: CloudLogoDependencies = defaults): Promise<void> {
  const raw = getCloudLogoConfiguration(options.configuration);
  if (!raw || raw.mode !== options.mode || options.mode === "run" && !options.configuration.activated) throw unavailable();
  if (options.signal.aborted) return;
  const lifetime = new AbortController(), stop = () => lifetime.abort();
  options.signal.addEventListener("abort", stop, { once: true });
  const identity = { projectId: options.configuration.projectId, vercelDeploymentId: options.configuration.vercelDeploymentId,
    daemon: CLOUD_LOGO_DAEMON_NAME, sourceRevision: options.configuration.sourceRevision };
  const emit = (event: Event) => { try { dependencies.emit(event); } catch { /* Diagnostic errors never bypass cleanup. */ } };
  let pool: Pool | undefined, session: Awaited<ReturnType<typeof createLocalLogoStorageSession>> | undefined, host: LogoProductionHost | undefined;
  const authorizations: LogoGenerativeStorageAuthorization[] = [];
  let hostInvoked = false, failed = false, disposed = false;
  let phase: Phase = "raster_qualification", failureReason: FailureReason | undefined;
  // pg-pool emits this only after removing a failed IDLE client. It replaces
  // that client on demand. A pool event neither identifies an active query nor
  // proves its result was lost; aborting the whole host would unnecessarily fence
  // new work and force a drain. Checked-out errors still fail through the existing identity,
  // lease and publication gates. Never inspect/log the private Error or Client.
  const poolError = () => emit({ event: "cloud_logo_database_idle_client_removed", ...identity, phase });
  const reportFailure = (reason: FailureReason = phaseFailure[phase]) => emit({ event: "cloud_logo_runtime_failure", ...identity, phase, reason });
  async function dispose() {
    if (disposed) return;
    // Never release session/pool when a constructor cannot prove drain or a
    // returned host reports unconfirmed closure. The platform may terminate it;
    // durable leases and unknown-outcome guards then retain the ambiguity.
    phase = "host_drain";
    if (hostInvoked && !host) throw new Error("cloud_logo_drain_unconfirmed");
    try { await host?.close(); } catch { throw new Error("cloud_logo_drain_unconfirmed"); }
    for (const authorization of authorizations) authorization.close();
    phase = "pool_disposal";
    try { await pool?.end(); } catch { throw new Error("cloud_logo_disposal_unconfirmed"); }
    pool?.removeListener("error", poolError);
    phase = "storage_session_disposal";
    try { await session?.close(); } catch { throw new Error("cloud_logo_disposal_unconfirmed"); }
    disposed = true;
  }
  try {
    await dependencies.qualifyRaster(lifetime.signal); if (lifetime.signal.aborted) return;
    phase = "database_qualification";
    pool = dependencies.createPool(cloudLogoPoolOptions(options.configuration)); pool.on("error", poolError);
    await dependencies.verifyDatabase(pool, raw.configuration.database.host); if (lifetime.signal.aborted) return;
    phase = "storage_sign_in";
    session = await dependencies.createSession(raw.identity, raw.configuration); if (lifetime.signal.aborted) return;
    const accessToken = await session.tokenProvider(lifetime.signal);
    phase = "storage_configuration";
    const configuration = parseLogoDedicatedConfiguration({ ...raw.configuration, storage: { ...raw.configuration.storage, accessToken } });
    const c = getLogoDedicatedConfiguration(configuration);
    if (!c?.storage || !c.image) throw unavailable();
    phase = "storage_session_verification";
    await dependencies.verifySession(configuration, accessToken); if (lifetime.signal.aborted) return;
    phase = "storage_configuration";
    const selected: Pick<Extract<LogoProductionHostOptions, { enabled: true }>, "concepts" | "refinements"> = {};
    for (const lane of ["concepts", "refinements"] as const) {
      const capability = c.operations[lane]; if (!capability) throw unavailable();
      const authorization = createLogoGenerativeStorageAuthorization({ ownerId: c.binding.ownerId, authUserId: c.storage.authUserId,
        workerRoleName: c.binding.roleName, workerRoleOid: c.binding.roleOid, workerId: c.workerId,
        publishableKey: c.storage.publishableKey, accessToken, capability }, { fetch: globalThis.fetch, tokenProvider: session.tokenProvider });
      if (!authorization) throw unavailable(); authorizations.push(authorization); selected[lane] = { capability, authorization, image: c.image };
    }
    phase = "host_construction"; hostInvoked = true;
    host = await dependencies.startHost({ enabled: true, binding: c.binding, workerId: c.workerId, pool, signal: lifetime.signal, ...selected });
    if (lifetime.signal.aborted) return;
    if (host.status !== "qualified") { failureReason = "host_unavailable"; throw unavailable(); }
    if (options.mode !== "run") {
      await dispose(); if (lifetime.signal.aborted) return;
      emit({ event: options.mode === "standby" ? "cloud_logo_standby_verified" : "cloud_logo_preflight_verified", ...identity,
        restrictedRoleVerified: true, tlsVerified: true, storageSessionVerified: true, rasterVerified: true, jobMutations: false, providerCalls: false });
      if (options.mode === "standby") {
        phase = "standby";
        while (!lifetime.signal.aborted) await delay(60_000, undefined, { signal: lifetime.signal }).catch(error => {
          if (!lifetime.signal.aborted) throw error;
        });
      }
      return;
    }
    phase = "host_run";
    emit({ event: "cloud_logo_worker_started", ...identity });
    // Only this existing run loop publishes readiness and claims work. Its
    // storage brokers revalidate the exact renewed session and each lease.
    await host.run(lifetime.signal);
    if (!lifetime.signal.aborted) { failureReason = "host_returned_without_shutdown"; throw unavailable(); }
  } catch { failed = true; reportFailure(failureReason); }
  finally {
    stop();
    try {
      try { await dispose(); }
      catch (error) { reportFailure(); throw error; }
      if (failed) throw unavailable();
    }
    finally { options.signal.removeEventListener("abort", stop); }
  }
  if (options.mode === "run") emit({ event: "cloud_logo_drain_complete", ...identity });
}
