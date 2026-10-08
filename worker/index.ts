import { Pool } from "pg";
import { PostgresJobStore } from "./postgres-store";
import { runOneJob } from "./runner";
import { setTimeout as delay } from "node:timers/promises";
import { readOpenAIStrategyConfiguration } from "../src/server/ai/config";
import { createOpenAIStrategyHandlers } from "./handlers/openai-strategy";
import { createStrategyReadiness } from "./handlers/openai-readiness";

const configuration = readOpenAIStrategyConfiguration();

async function main() {
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
  const pool = new Pool({ connectionString: process.env.FLUID_WORKER_DATABASE_URL, max: 3, connectionTimeoutMillis: 10_000, statement_timeout: 15_000, query_timeout: 15_000 });
  const store = new PostgresJobStore(pool);
  const controller = new AbortController();
  const stop = () => controller.abort();
  const { reportReadiness, assertPolicyReady } = createStrategyReadiness(pool, configuration.policies, stop);
  const handlers = createOpenAIStrategyHandlers(configuration, undefined, assertPolicyReady);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const workerId = `fluid-${crypto.randomUUID()}`;
  let readinessTimer: ReturnType<typeof setInterval> | undefined;
  let reporting: Promise<void> | undefined;
  try {
    // The web process may enqueue only while a separate correctly configured worker
    // has a fresh heartbeat and an operator has enabled the identical private policy.
    await reportReadiness();
    readinessTimer = setInterval(() => {
      if (!reporting) reporting = reportReadiness().catch(() => {
        controller.abort();
      }).finally(() => { reporting = undefined; });
    }, 20_000);
    readinessTimer.unref();
    while (!controller.signal.aborted) {
      // Never consume queued work using a policy accepted by an older heartbeat.
      await reportReadiness();
      await store.expireLeases();
      const state = await runOneJob({ store, handlers, workerId, signal: controller.signal });
      // Operational metadata only; no prompts, credentials, raw provider errors, or output bodies.
      if (state !== "idle") console.info(JSON.stringify({ event: "job_cycle", state }));
      if (state === "idle") await delay(1000, undefined, { signal: controller.signal }).catch(() => {});
    }
  } finally {
    clearInterval(readinessTimer);
    await reporting;
    await pool.end();
  }
}

main().catch(() => {
  console.error("Worker stopped after a database or configuration failure. Check private operational diagnostics.");
  process.exitCode = 1;
});
