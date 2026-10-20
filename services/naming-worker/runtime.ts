import { randomUUID } from "node:crypto";
import { checkServerIdentity, TLSSocket } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { z } from "zod";
import { CLOUD_NAMING_DAEMON_NAME, CLOUD_NAMING_DATABASE_ROLE, CLOUD_NAMING_DATABASE_ROLE_OID, CLOUD_NAMING_RUNTIME,
  type CloudNamingConfiguration, type CloudNamingMode } from "../../worker/cloud-naming-configuration";
import { startNamingReadiness } from "../../worker/naming-brain-configuration";
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import { createNamingBrainHandlers } from "../../worker/handlers/naming-brain";
import { runOneJob } from "../../worker/runner";

const identitySchema = z.strictObject({ session_user: z.literal(CLOUD_NAMING_DATABASE_ROLE), current_user: z.literal(CLOUD_NAMING_DATABASE_ROLE),
  role_oid: z.literal(CLOUD_NAMING_DATABASE_ROLE_OID), rolcanlogin: z.literal(true), rolinherit: z.literal(false), rolsuper: z.literal(false),
  rolbypassrls: z.literal(false), rolcreatedb: z.literal(false), rolcreaterole: z.literal(false), rolreplication: z.literal(false),
  rolconnlimit: z.literal(4), has_memberships: z.literal(false), owns_objects: z.literal(false) });

/** Read only, on the actual restricted connection. Never calls a Naming RPC.
 * The private pilot's policy/runtime binding still requires operator readback. */
export async function verifyCloudNamingDatabase(pool: Pool, hostname: string): Promise<void> {
  let client;
  try { client = await pool.connect(); }
  catch { throw new Error("cloud_naming_database_identity_unavailable"); }
  let transaction = false, failure: Error | undefined;
  try {
    const socket = client.connection.stream;
    if (!(socket instanceof TLSSocket) || !socket.encrypted || !socket.authorized || socket.authorizationError
      || !["TLSv1.2", "TLSv1.3"].includes(socket.getProtocol() ?? "")
      || checkServerIdentity(hostname, socket.getPeerCertificate())) throw new Error();
    await client.query("BEGIN READ ONLY"); transaction = true;
    const result = await client.query(`select session_user, current_user, r.oid::integer as role_oid,
      r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole,
      r.rolreplication, r.rolconnlimit,
      exists(select 1 from pg_catalog.pg_auth_members m where m.member = r.oid) as has_memberships,
      exists(select 1 from pg_catalog.pg_shdepend d where d.refclassid = 'pg_catalog.pg_authid'::regclass
        and d.refobjid = r.oid and d.deptype = 'o') as owns_objects
      from pg_catalog.pg_roles r where r.rolname = session_user`);
    if (result.rows.length !== 1) throw new Error();
    identitySchema.parse(result.rows[0]);
  } catch { failure = new Error("cloud_naming_database_identity_unavailable"); }
  finally {
    if (transaction) {
      try { await client.query("ROLLBACK"); }
      catch { failure = new Error("cloud_naming_database_identity_unavailable"); }
    }
    client.release(failure);
  }
  if (failure) throw failure;
}

export async function runCloudNamingWorker(options: {
  configuration: CloudNamingConfiguration;
  mode: CloudNamingMode;
  signal: AbortSignal;
}): Promise<void> {
  if (options.signal.aborted) return;
  const { configuration: config } = options;
  if (options.mode === "run" && !config.paidDispatchEnabled) throw new Error("cloud_naming_activation_required");
  const controller = new AbortController(), stop = () => controller.abort();
  options.signal.addEventListener("abort", stop, { once: true });
  const pool = new Pool(config.poolOptions);
  // pg removes a failed IDLE client before emitting this event, replacing it on
  // demand. This says nothing about independently checked-out work. Actual
  // identity/query, readiness, claim and heartbeat failures keep their gates.
  // Never inspect/log the Error or Client, which can contain credentials.
  const idleClientRemoved = () => {
    try { console.info(JSON.stringify({ event: "cloud_naming_database_idle_client_removed" })); }
    catch { /* A diagnostic sink cannot abort healthy work or bypass cleanup. */ }
  };
  pool.on("error", idleClientRemoved);
  let poolClosed = false;
  const closePool = async () => {
    if (poolClosed) return;
    poolClosed = true;
    await pool.end();
  };
  let readiness: Awaited<ReturnType<typeof startNamingReadiness>> | undefined;
  try {
    await verifyCloudNamingDatabase(pool, config.poolOptions.host!);
    if (controller.signal.aborted) return;
    const identity = { projectId: config.projectId, vercelDeploymentId: config.vercelDeploymentId, daemon: CLOUD_NAMING_DAEMON_NAME, sourceRevision: config.sourceRevision };
    if (options.mode === "preflight" || options.mode === "standby") {
      // Standby releases its database connection before waiting. Its ref'd
      // abortable timer keeps the container alive without polling any service.
      if (options.mode === "standby") {
        await closePool();
        if (controller.signal.aborted) return;
      }
      console.info(JSON.stringify({ event: options.mode === "standby" ? "cloud_naming_standby_verified" : "cloud_naming_preflight_verified", ...identity,
        restrictedRoleVerified: true, tlsVerified: true, runtimeVerified: true,
        runtime: CLOUD_NAMING_RUNTIME, jobMutations: false, providerCalls: false }));
      if (options.mode === "standby") {
        while (!controller.signal.aborted) await delay(60_000, undefined, { signal: controller.signal }).catch(error => {
          if (!controller.signal.aborted) throw error;
        });
      }
      return;
    }
    const store = new NamingBrainJobStore(pool, config.deploymentId), workerId = `naming-cloud-${randomUUID()}`;
    await store.attestPendingPreferences();
    if (controller.signal.aborted) return;
    readiness = await startNamingReadiness(() => controller.signal.aborted ? Promise.resolve(false) : store.reportReady(config.policy, workerId));
    const gate = readiness;
    const handlers = createNamingBrainHandlers({ store, apiKey: config.apiKey, assertReady: async () => {
      if (controller.signal.aborted) throw new Error("cloud_naming_stopping");
      await gate.assertReady();
      if (controller.signal.aborted) throw new Error("cloud_naming_stopping");
    } });
    console.info(JSON.stringify({ event: "cloud_naming_worker_started", ...identity, workerId }));
    while (!controller.signal.aborted) {
      await store.attestPendingPreferences();
      if (controller.signal.aborted) break;
      await store.expireLeases(workerId);
      if (controller.signal.aborted) break;
      // Execution authority is read from the database claim. This cloud process
      // never supplies localPrototype or invents a per-job exception.
      const state = await runOneJob({ store, handlers, workerId, signal: controller.signal, abortGraceMs: 15_000 });
      if (state !== "idle") console.info(JSON.stringify({ event: "naming_job_cycle", state }));
      if (state === "idle") await delay(5_000, undefined, { signal: controller.signal }).catch(error => {
        if (!controller.signal.aborted) throw error;
      });
    }
  } finally {
    stop();
    try { await readiness?.stop(); }
    finally {
      try { await closePool(); }
      finally { pool.removeListener("error", idleClientRemoved); options.signal.removeEventListener("abort", stop); }
    }
  }
}
