import { Pool } from "pg";
import { QueueClient } from "@vercel/queue";
import { readWorkerIdentity, workerPoolOptions } from "../../worker/hosting/config";
import type { PublicationDependencies } from "../../worker/hosting/publication";
import { multiAccountApiTextEnabled } from "../../worker/api-text-multi-account";

let pool: Pool | undefined;
export function workerDatabase(): Pool {
  readWorkerIdentity();
  if (!pool) {
    pool = new Pool(workerPoolOptions(process.env.FLUID_WORKER_DATABASE_URL, process.env.FLUID_WORKER_DATABASE_PASSWORD));
    // Idle connection errors must not crash unrelated concurrent deliveries.
    pool.on("error", () => { console.error(JSON.stringify({ event: "api_text_database_idle_error" })); });
  }
  return pool;
}
export function queueClient(): QueueClient {
  const { deploymentId } = readWorkerIdentity();
  return new QueueClient({ region: "iad1", deploymentId, telemetry: { isEnabled: false } });
}
export function publicationDependencies(signal: AbortSignal): PublicationDependencies {
  const { deploymentId } = readWorkerIdentity();
  return { database: workerDatabase(), send: queueClient().send, deploymentId, signal, multiAccount: multiAccountApiTextEnabled() };
}
