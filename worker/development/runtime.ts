import "server-only";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { PoolConfig } from "pg";
import type { IdentityPoolPort } from "../../src/server/runtime/identity-pool";
import type { DevelopmentLogoConfiguration } from "./logo";
import {
  readDevelopmentWorkerConfiguration, readDevelopmentWorkerExecution,
  type DevelopmentWorkerConfiguration, type DevelopmentWorkerEnvironment,
  type DevelopmentWorkerExecution, type DevelopmentWorkerLane, type DevelopmentWorkerMode,
} from "./config";

export type DevelopmentDatabaseClient = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(error?: Error): void;
};
export type DevelopmentWorkerPool = {
  identityPool?: IdentityPoolPort;
  connect(): Promise<DevelopmentDatabaseClient>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
  on(event: "error", listener: () => void): unknown;
  removeListener(event: "error", listener: () => void): unknown;
};
const requiredFunctions = Object.freeze({
  strategy: ["public.report_strategy_worker_ready(text,jsonb,integer)", "public.claim_job(text,integer)",
    "public.expire_job_leases()", "public.local_strategy_job_action(uuid,text,jsonb)", "public.read_local_strategy_steps(uuid,uuid,uuid,text)"],
  logo: ["public.report_logo_worker_ready(text,jsonb,integer)", "public.claim_logo_job(text,integer)", "public.expire_logo_job_leases()"],
});
const unavailable = () => new Error("development_worker_unavailable");

/** SELECT-only qualification. It never reports readiness, takes a lease or calls a provider. */
export async function verifyDevelopmentWorkerDatabase(pool: DevelopmentWorkerPool, config: DevelopmentWorkerConfiguration): Promise<{ roleOid: number }> {
  let client: DevelopmentDatabaseClient | undefined, transaction = false, failure: Error | undefined;
  let roleOid = 0;
  try {
    client = await pool.connect();
    await client.query("BEGIN READ ONLY"); transaction = true;
    const identity = await client.query(`select session_user,current_user,current_database() database,r.oid::integer role_oid,
      r.rolcanlogin,r.rolinherit,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,
      exists(select 1 from pg_catalog.pg_auth_members where member=r.oid) has_memberships,
      exists(select 1 from pg_catalog.pg_shdepend where refclassid='pg_catalog.pg_authid'::regclass and refobjid=r.oid and deptype='o') owns_objects
      from pg_catalog.pg_roles r where r.rolname=session_user`);
    const row = identity.rows[0];
    if (identity.rows.length !== 1 || !row || row.session_user !== config.role || row.current_user !== config.role
      || row.database !== "postgres" || row.rolcanlogin !== true || !Number.isSafeInteger(row.role_oid) || Number(row.role_oid) < 1
      || [row.rolinherit, row.rolsuper, row.rolbypassrls, row.rolcreatedb, row.rolcreaterole,
        row.rolreplication, row.has_memberships, row.owns_objects].some(value => value !== false)) throw unavailable();
    roleOid = Number(row.role_oid);
    // Narrow SECURITY DEFINER proof only; restricted logins must never receive
    // SELECT on private capability tables to perform a read-only preflight.
    const owner = await client.query("select public.check_development_worker_binding($1,$2,$3)::text owner_id",
      [config.lane, config.ownerId, config.deploymentId]);
    if (owner.rows.length !== 1 || owner.rows[0]?.owner_id !== config.ownerId) throw unavailable();
    const functions = requiredFunctions[config.lane];
    const permissions = await client.query(`select count(*)::integer found,
      coalesce(bool_and(has_function_privilege(current_user,p.oid,'EXECUTE')),false) available
      from unnest($1::text[]) signature join pg_catalog.pg_proc p on p.oid=to_regprocedure(signature)`, [functions]);
    if (permissions.rows.length !== 1 || permissions.rows[0]?.found !== functions.length || permissions.rows[0]?.available !== true) throw unavailable();
  } catch { failure = unavailable(); }
  finally {
    if (transaction) try { await client!.query("ROLLBACK"); } catch { failure = unavailable(); }
    client?.release(failure);
  }
  if (failure) throw failure;
  return { roleOid };
}

function createPool(options: PoolConfig): DevelopmentWorkerPool {
  const require = createRequire(import.meta.url);
  const Client = require("pg/lib/client.js") as typeof import("pg").Client;
  const requireFromPg = createRequire(require.resolve("pg/package.json"));
  const Pool = requireFromPg("pg-pool") as typeof import("pg").Pool;
  const pool = new Pool({ ...options, Client });
  return Object.assign(pool, { identityPool: pool });
}

/** Reuses the existing durable runners; no replacement queue or synthetic output. */
async function runText(pool: DevelopmentWorkerPool, config: DevelopmentWorkerConfiguration, execution: DevelopmentWorkerExecution, signal: AbortSignal) {
  const { runOneJob } = await import("../runner");
  const workerId = `embel-dev-${config.lane}-${randomUUID()}`;
  if (config.lane !== "strategy") throw unavailable();
  const [{ PostgresJobStore }, { createStrategyReadiness }, { createOpenAIStrategyHandlers }, { guidedStrategyPolicy }] = await Promise.all([
    import("../postgres-store"), import("../handlers/openai-readiness"), import("../handlers/openai-strategy"), import("../../src/server/ai/config"),
  ]);
  const policies = new Map((["strategy.reformulate", "strategy.competitors", "strategy.audience", "strategy.positioning", "strategy.personality", "strategy.slogan"] as const)
    .map(operation => [operation, guidedStrategyPolicy(operation, "gpt-6-luna")] as const));
  const readiness = createStrategyReadiness(pool, policies, () => {});
  const store = new PostgresJobStore(pool, { localPrototype: true });
  const handlers = createOpenAIStrategyHandlers({ apiKey: execution.apiKey, policies }, undefined, readiness.assertPolicyReady);
  while (!signal.aborted) {
    // SQL proves the restricted role's exact local policy before every claim
    // and again before provider dispatch; no generic service-role grants.
    await readiness.reportReadiness();
    await store.expireLeases();
    const state = await runOneJob({ store, handlers, workerId, localPrototype: true, signal });
    if (state === "idle") await delay(5_000, undefined, { signal }).catch(() => { if (!signal.aborted) throw unavailable(); });
  }
}

export type DevelopmentWorkerDependencies = {
  createPool(options: PoolConfig): DevelopmentWorkerPool;
  runText(pool: DevelopmentWorkerPool, config: DevelopmentWorkerConfiguration, execution: DevelopmentWorkerExecution, signal: AbortSignal): Promise<void>;
};
const defaults: DevelopmentWorkerDependencies = { createPool, runText };

export async function runDevelopmentWorker(options: {
  lane: DevelopmentWorkerLane; mode: DevelopmentWorkerMode; signal: AbortSignal;
  env?: DevelopmentWorkerEnvironment;
}, dependencies: DevelopmentWorkerDependencies = defaults): Promise<{ status: "preflight_passed" | "stopped"; lane: DevelopmentWorkerLane; executionSupported: boolean }> {
  const env = options.env ?? process.env, config = readDevelopmentWorkerConfiguration(options.lane, env);
  if (!config || !["preflight", "run"].includes(options.mode)) throw unavailable();
  // Check authorization before pool construction, mutation or provider import.
  const execution = options.mode === "run" && options.lane !== "logo" ? readDevelopmentWorkerExecution(options.lane, env) : null;
  let logo: DevelopmentLogoConfiguration | null = null;
  if (options.mode === "run") {
    if (options.lane === "logo") {
      if (env.EMBEL_DEVELOPMENT_DISPATCH_APPROVED !== "true") throw unavailable();
      logo = (await import("./logo")).readDevelopmentLogoConfiguration(env);
      if (!logo) throw unavailable();
    } else if (!execution) throw unavailable();
  }
  if (options.signal.aborted) return { status: "stopped", lane: config.lane, executionSupported: true };
  const pool = dependencies.createPool(config.poolOptions), controller = new AbortController();
  let logoDrainUnconfirmed = false;
  const stop = () => controller.abort();
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  pool.on("error", stop);
  try {
    const proof = await verifyDevelopmentWorkerDatabase(pool, config);
    if (controller.signal.aborted) throw unavailable();
    if (options.mode === "preflight") return { status: "preflight_passed", lane: config.lane, executionSupported: true };
    if (logo) {
      if (!pool.identityPool) throw unavailable();
      await (await import("./logo")).runDevelopmentLogo({ configuration: config, logo, roleOid: proof.roleOid, pool: pool.identityPool, signal: controller.signal });
    } else await dependencies.runText(pool, config, execution!, controller.signal);
    return { status: "stopped", lane: config.lane, executionSupported: true };
  } catch (error) {
    if (logo && error instanceof (await import("./logo")).DevelopmentLogoDrainUnconfirmedError) logoDrainUnconfirmed = true;
    throw error;
  } finally {
    controller.abort(); options.signal.removeEventListener("abort", stop);
    // Do not dispose resources beneath an unconfirmed Logo host drain. Keep
    // idle-error coverage and the fixed failure event for operator diagnosis.
    if (!logoDrainUnconfirmed) {
      try { await pool.end(); } catch { throw unavailable(); }
      finally { pool.removeListener("error", stop); }
    }
  }
}
