import { attachDatabasePool } from "@vercel/functions";
import { Pool } from "pg";
import { diagnose } from "../../worker/hosting/diagnostics";
import { QueueClient } from "@vercel/queue";
import { readWorkerIdentity, workerPoolOptions } from "../../worker/hosting/config";
import type { PublicationDependencies } from "../../worker/hosting/publication";
import { apiTextBackgroundRecoveryEnabled } from "../../worker/api-text-background-config";
import { multiAccountApiTextEnabled } from "../../worker/api-text-multi-account";

let pool: Pool | undefined;
export function workerDatabase(): Pool {
  readWorkerIdentity();
  if (!pool) {
    const created = new Pool(workerPoolOptions(process.env.FLUID_WORKER_DATABASE_URL, process.env.FLUID_WORKER_DATABASE_PASSWORD));
    attachDatabasePool(created);
    // Idle connection errors must not crash unrelated concurrent deliveries.
    created.on("error", () => { diagnose("database_idle", "error", Date.now(), "database"); });
    pool = created;
  }
  return pool;
}
export function queueClient(): QueueClient {
  const { deploymentId } = readWorkerIdentity();
  return new QueueClient({ region: "iad1", deploymentId, telemetry: { isEnabled: false } });
}
export function publicationDependencies(signal: AbortSignal): PublicationDependencies {
  const { deploymentId } = readWorkerIdentity();
  return { database: workerDatabase(), send: queueClient().send, deploymentId, signal, multiAccount: multiAccountApiTextEnabled(), backgroundRecovery: apiTextBackgroundRecoveryEnabled() };
}
