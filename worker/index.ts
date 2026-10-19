import { Pool } from "pg";
import { PostgresJobStore } from "./postgres-store";
import { runOneJob } from "./runner";
import { setTimeout as delay } from "node:timers/promises";
import { readOpenAIStrategyConfiguration } from "../src/server/ai/config";
import { createOpenAIStrategyHandlers } from "./handlers/openai-strategy";
import { createStrategyReadiness } from "./handlers/openai-readiness";
import { isLocalPrototypeRuntime } from "../src/server/api-text/config";
import { localPrototypeDatabaseConfiguration } from "../scripts/local-environment.mjs";

import { readNamingBrainConfiguration, startNamingReadiness, type NamingBrainConfiguration } from "./naming-brain-configuration";
import { NamingBrainJobStore } from "./naming-brain-store";
import { createNamingBrainHandlers } from "./handlers/naming-brain";
import { createLocalExpiryCoordinator, runLocalExpiryTransaction } from "./local-expiry-maintenance";

const configuration = readOpenAIStrategyConfiguration();
const namingConfiguration = readNamingBrainConfiguration();
const localPrototype = isLocalPrototypeRuntime();
const localExpiry = createLocalExpiryCoordinator();

type DatabaseRole = "strategy" | "naming";
type DatabaseOperation = "idle_connection" | "readiness" | "preferences" | "expire_leases" | "claim";
const reportedSqlStates = new Set(["53300", "57014", "40001", "40P01", "57P01", "57P02", "57P03", "08000", "08001", "08003", "08004", "08006", "08P01"]);
const reportedNetworkCodes = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ECONNABORTED"]);
const reportedClientMessages = new Map([
  ["timeout expired", "connection_timeout"],
  ["Connection terminated due to connection timeout", "connection_timeout"],
  ["timeout exceeded when trying to connect", "pool_acquire_timeout"],
  ["Query read timeout", "query_timeout"],
  ["Connection terminated unexpectedly", "connection_terminated"],
]);
function sqlState(error: unknown): string | null {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && reportedSqlStates.has(code) ? code : null;
}
function failureClass(error: unknown): string {
  if (sqlState(error)) return "postgres";
  if (!error || typeof error !== "object") return "unknown";
  if ("code" in error && typeof error.code === "string" && reportedNetworkCodes.has(error.code)) return error.code;
  return "message" in error && typeof error.message === "string" ? reportedClientMessages.get(error.message) ?? "unknown" : "unknown";
}
function reportLocalDatabaseFailure(role: DatabaseRole, operation: DatabaseOperation, error: unknown, retryAfterMs?: number) {
  if (!localPrototype) return;
  console.error(JSON.stringify({ event: "local_database_failure", at: new Date().toISOString(), role, operation, sqlState: sqlState(error), failureClass: failureClass(error), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }));
}
async function maintenance<T>(role: DatabaseRole, operation: DatabaseOperation, work: () => Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (!localPrototype) return work();
  let failures = 0;
  while (!signal.aborted) {
    try { return await work(); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      // These two failures precede SQL. A read timeout may leave a query running
      // on the server, so it must never authorize another maintenance attempt.
      const clientTimeout = code == null && ["connection_timeout", "pool_acquire_timeout"].includes(failureClass(error));
      if (sqlState(error) !== "53300" && sqlState(error) !== "57014" && !clientTimeout) throw error;
      const retryAfterMs = [1_000, 2_000, 4_000, 20_000][Math.min(failures++, 3)]!;
      reportLocalDatabaseFailure(role, operation, error, retryAfterMs);
      await delay(retryAfterMs, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
    }
  }
}

function watchDatabase(pool: Pool, controller: AbortController, role: DatabaseRole) {
  // pg-pool attaches its Client to idle errors. Never let EventEmitter print
  // that raw object, which can contain the private connection configuration.
  const unavailable = (error: unknown) => {
    console.error("Worker stopped after a database connection failure.");
    reportLocalDatabaseFailure(role, "idle_connection", error);
    process.exitCode = 1;
    controller.abort();
  };
  pool.on("error", unavailable);
  return () => pool.removeListener("error", unavailable);
}

async function runStrategy(controller: AbortController) {
  if (!configuration?.policies.size) {
    console.error("Worker unavailable: no validated operation handlers are configured. No jobs were claimed.");
    process.exitCode = 2;
    return;
  }
  if (!process.env.FLUID_WORKER_DATABASE_URL) {
    console.error("Worker unavailable: its dedicated database connection is not configured.");
    process.exitCode = 2;
    return;
  }
  const pool = new Pool({ ...(localPrototype ? localPrototypeDatabaseConfiguration(process.env.FLUID_WORKER_DATABASE_URL)
    : { connectionString: process.env.FLUID_WORKER_DATABASE_URL }), max: localPrototype ? 1 : 3, connectionTimeoutMillis: localPrototype ? 30_000 : 10_000, statement_timeout: 15_000, query_timeout: 15_000 });
  const unwatch = watchDatabase(pool, controller, "strategy");
  const store = new PostgresJobStore(pool, { localPrototype });
  let localReady = false, localReadyAt: number | undefined, readinessRevision = 0;
  const stop = () => {
    if (!localPrototype) controller.abort();
    else { localReady = false; localReadyAt = undefined; readinessRevision++; }
  };
  const readinessDatabase = localPrototype ? { async query(sql: string, values: unknown[]) {
    try { return await pool.query(sql, values); }
    catch (error) { reportLocalDatabaseFailure("strategy", "readiness", error); throw error; }
  } } : pool;
  const { reportReadiness, assertPolicyReady } = createStrategyReadiness(readinessDatabase, configuration.policies, stop);
  const handlers = createOpenAIStrategyHandlers(configuration, undefined, assertPolicyReady);
  const workerId = `fluid-${crypto.randomUUID()}`;
  let readinessTimer: ReturnType<typeof setInterval> | undefined;
  let reporting: Promise<void> | undefined;
  let localReporting: Promise<boolean> | undefined;
  const refresh = (force = false): Promise<boolean> => {
    if (!localPrototype) return reportReadiness().then(() => true);
    if (localReporting) return localReporting;
    const age = localReadyAt === undefined ? Infinity : Date.now() - localReadyAt;
    if (!force && localReady && age >= 0 && age < 20_000) return Promise.resolve(true);
    const startedAt = Date.now(), revision = readinessRevision;
    localReporting = reportReadiness().then(() => {
      if (revision !== readinessRevision) return false;
      localReady = true; localReadyAt = startedAt; return true;
    }).catch(() => {
      localReady = false;
      localReadyAt = undefined;
      console.error("Local Strategy readiness unavailable; retrying without stopping Naming.");
      return false;
    }).finally(() => { localReporting = undefined; });
    return localReporting;
  };
  let operation: DatabaseOperation = "readiness";
  try {
    // The web process may enqueue only while a separate correctly configured worker
    // has a fresh heartbeat and an operator has enabled the identical private policy.
    await refresh();
    readinessTimer = setInterval(() => {
      if (!reporting) reporting = refresh(true).then(() => {}).catch(() => {
        if (!localPrototype) controller.abort();
      }).finally(() => { reporting = undefined; });
    }, 20_000);
    readinessTimer.unref();
    while (!controller.signal.aborted) {
      // Never consume queued work using a policy accepted by an older heartbeat.
      if (localPrototype && !localReady) {
        await delay(20_000, undefined, { signal: controller.signal }).catch(() => {});
        if (controller.signal.aborted) break;
      }
      if (!localPrototype && !await refresh()) continue;
      operation = "expire_leases";
      if (await maintenance("strategy", operation, () => localPrototype
        ? localExpiry.run("strategy", controller.signal, () => runLocalExpiryTransaction(pool, controller.signal,
          database => new PostgresJobStore(database, { localPrototype: true }).expireLeases()))
        : store.expireLeases(), controller.signal) === undefined) break;
      operation = "claim";
      // runOneJob contains all leased execution failures; only its initial claim
      // can propagate a database error. Reuse only a recent acknowledged local
      // report; SQL claim and paid dispatch retain their own freshness checks.
      const state = await maintenance("strategy", operation, async () => {
        if (localPrototype && !await refresh()) return "idle" as const;
        return runOneJob({ store, handlers, workerId, localPrototype, signal: controller.signal });
      }, controller.signal);
      if (state === undefined) break;
      // Operational metadata only; no prompts, credentials, raw provider errors, or output bodies.
      if (state !== "idle") console.info(JSON.stringify({ event: "job_cycle", state }));
      if (state === "idle") await delay(localPrototype ? 5_000 : 1_000, undefined, { signal: controller.signal }).catch(() => {});
    }
  } catch (error) {
    reportLocalDatabaseFailure("strategy", operation, error);
    throw error;
  } finally {
    clearInterval(readinessTimer);
    await reporting;
    try { await pool.end(); } finally { unwatch(); }
  }
}

async function runNaming(config: NamingBrainConfiguration, controller: AbortController) {
  const pool = new Pool({ ...(localPrototype ? localPrototypeDatabaseConfiguration(config.databaseUrl)
    : { connectionString: config.databaseUrl }), max: localPrototype ? 2 : 4, connectionTimeoutMillis: localPrototype ? 30_000 : 10_000, statement_timeout: 15_000, query_timeout: 15_000 });
  const unwatch = watchDatabase(pool, controller, "naming");
  const store = new NamingBrainJobStore(pool, config.deploymentId), workerId = `naming-${crypto.randomUUID()}`;
  let readiness: Awaited<ReturnType<typeof startNamingReadiness>> | undefined;
  let operation: DatabaseOperation = "preferences";
  try {
    if (await maintenance("naming", operation, () => store.attestPendingPreferences(), controller.signal) === undefined) return;
    operation = "readiness";
    readiness = await startNamingReadiness(async () => {
      try { return config.paidDispatchEnabled ? await store.reportReady(config.policy, workerId) : false; }
      catch (error) { reportLocalDatabaseFailure("naming", "readiness", error); throw error; }
    });
    const handlers = createNamingBrainHandlers({ store, apiKey: config.apiKey, localPrototype, assertReady: readiness.assertReady });
    while (!controller.signal.aborted) {
      // This scoped claim permits observation after policy disable, using frozen
      // admitted model/session bindings. Readiness still gates every paid dispatch.
      operation = "preferences";
      if (await maintenance("naming", operation, () => store.attestPendingPreferences(), controller.signal) === undefined) break;
      operation = "expire_leases";
      if (await maintenance("naming", operation, () => localPrototype
        ? localExpiry.run("naming", controller.signal, () => runLocalExpiryTransaction(pool, controller.signal,
          database => new NamingBrainJobStore(database, config.deploymentId).expireLeases(workerId)))
        : store.expireLeases(workerId), controller.signal) === undefined) break;
      operation = "claim";
      const state = await maintenance("naming", operation, () => runOneJob({ store, handlers, workerId, localPrototype, signal: controller.signal, abortGraceMs: 15_000 }), controller.signal);
      if (state === undefined) break;
      if (state !== "idle") console.info(JSON.stringify({ event: "naming_job_cycle", state }));
      if (state === "idle") await delay(localPrototype ? 5_000 : 1_000, undefined, { signal: controller.signal }).catch(() => {});
    }
  } catch (error) {
    reportLocalDatabaseFailure("naming", operation, error);
    throw error;
  } finally { await readiness?.stop(); try { await pool.end(); } finally { unwatch(); } }
}
async function main() {
  if (process.env.FLUID_LOCAL_PROTOTYPE === "true" && !localPrototype)
    throw new Error("Invalid local prototype runtime");
  if (localPrototype && (!namingConfiguration || !configuration?.policies.size ||
      process.env.FLUID_WORKER_DATABASE_URL !== namingConfiguration.databaseUrl ||
      configuration.policies.size !== 4 || [...configuration.policies].some(([operation, policy]) => operation === "strategy.positioning" || policy.version !== 2)))
    throw new Error("Incomplete local prototype configuration");
  if (!configuration?.policies.size && !namingConfiguration) {
    console.error("Worker unavailable: no validated operation handlers are configured. No jobs were claimed."); process.exitCode = 2; return;
  }
  const controller = new AbortController(), stop = () => controller.abort();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try { await Promise.all([...(configuration?.policies.size ? [runStrategy(controller)] : []), ...(namingConfiguration ? [runNaming(namingConfiguration, controller)] : [])]); }
  finally { stop(); process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
}
main().catch(() => {
  console.error("Worker stopped after a database or configuration failure. Check private operational diagnostics.");
  process.exitCode = 1;
});
