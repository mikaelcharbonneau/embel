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

type Event = { event: "cloud_logo_preflight_verified" | "cloud_logo_standby_verified" | "cloud_logo_worker_started" | "cloud_logo_drain_complete";
  projectId: string; vercelDeploymentId: string; daemon: string; sourceRevision: string;
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
  emit: event => console.info(JSON.stringify({ ...event, runtime: CLOUD_LOGO_RUNTIME })),
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
  const poolError = () => { failed = true; stop(); };
  async function dispose() {
    if (disposed) return;
    // Never release session/pool when a constructor cannot prove drain or a
    // returned host reports unconfirmed closure. The platform may terminate it;
    // durable leases and unknown-outcome guards then retain the ambiguity.
    if (hostInvoked && !host) throw new Error("cloud_logo_drain_unconfirmed");
    try { await host?.close(); } catch { throw new Error("cloud_logo_drain_unconfirmed"); }
    for (const authorization of authorizations) authorization.close();
    try { await pool?.end(); } catch { throw new Error("cloud_logo_disposal_unconfirmed"); }
    pool?.removeListener("error", poolError);
    try { await session?.close(); } catch { throw new Error("cloud_logo_disposal_unconfirmed"); }
    disposed = true;
  }
  try {
    await dependencies.qualifyRaster(lifetime.signal); if (lifetime.signal.aborted) return;
    pool = dependencies.createPool(cloudLogoPoolOptions(options.configuration)); pool.on("error", poolError);
    await dependencies.verifyDatabase(pool, raw.configuration.database.host); if (lifetime.signal.aborted) return;
    session = await dependencies.createSession(raw.identity, raw.configuration); if (lifetime.signal.aborted) return;
    const accessToken = await session.tokenProvider(lifetime.signal);
    const configuration = parseLogoDedicatedConfiguration({ ...raw.configuration, storage: { ...raw.configuration.storage, accessToken } });
    const c = getLogoDedicatedConfiguration(configuration);
    if (!c?.storage || !c.image) throw unavailable();
    await dependencies.verifySession(configuration, accessToken); if (lifetime.signal.aborted) return;
    const selected: Pick<Extract<LogoProductionHostOptions, { enabled: true }>, "concepts" | "refinements"> = {};
    for (const lane of ["concepts", "refinements"] as const) {
      const capability = c.operations[lane]; if (!capability) throw unavailable();
      const authorization = createLogoGenerativeStorageAuthorization({ ownerId: c.binding.ownerId, authUserId: c.storage.authUserId,
        workerRoleName: c.binding.roleName, workerRoleOid: c.binding.roleOid, workerId: c.workerId,
        publishableKey: c.storage.publishableKey, accessToken, capability }, { fetch: globalThis.fetch, tokenProvider: session.tokenProvider });
      if (!authorization) throw unavailable(); authorizations.push(authorization); selected[lane] = { capability, authorization, image: c.image };
    }
    hostInvoked = true;
    host = await dependencies.startHost({ enabled: true, binding: c.binding, workerId: c.workerId, pool, signal: lifetime.signal, ...selected });
    if (lifetime.signal.aborted) return;
    if (host.status !== "qualified") throw unavailable();
    if (options.mode !== "run") {
      await dispose(); if (lifetime.signal.aborted) return;
      emit({ event: options.mode === "standby" ? "cloud_logo_standby_verified" : "cloud_logo_preflight_verified", ...identity,
        restrictedRoleVerified: true, tlsVerified: true, storageSessionVerified: true, rasterVerified: true, jobMutations: false, providerCalls: false });
      if (options.mode === "standby") while (!lifetime.signal.aborted) await delay(60_000, undefined, { signal: lifetime.signal }).catch(error => {
        if (!lifetime.signal.aborted) throw error;
      });
      return;
    }
    emit({ event: "cloud_logo_worker_started", ...identity });
    // Only this existing run loop publishes readiness and claims work. Its
    // storage brokers revalidate the exact renewed session and each lease.
    await host.run(lifetime.signal);
    if (!lifetime.signal.aborted) throw unavailable();
  } catch { failed = true; }
  finally {
    stop();
    try { await dispose(); if (failed) throw unavailable(); }
    finally { options.signal.removeEventListener("abort", stop); }
  }
  if (options.mode === "run") emit({ event: "cloud_logo_drain_complete", ...identity });
}
