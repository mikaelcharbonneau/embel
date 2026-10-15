import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { localWorkerDatabaseConfiguration } from "../scripts/local-environment.mjs";
import { createLocalChatGPTRuntime, readLocalRuntimeConfiguration } from "./local-chatgpt";
import { runLocalRuntimeHost } from "./local-runtime-host";
import { readProtectedLogoConceptConfiguration, startLogoConceptWorker, type LogoConceptStartup, type LogoConceptStorageAuthorization } from "./logo-concept-startup";

/** The CLI composes its dedicated short-lived Storage session only from the
 * protected logo file. A trusted embedding caller may still supply an adapter. */
export async function runLocalRuntime(options: { logoStorage?: LogoConceptStorageAuthorization } = {}) {
  const configuration = readLocalRuntimeConfiguration();
  const pool = process.env.FLUID_WORKER_DATABASE_URL ? new Pool({ ...localWorkerDatabaseConfiguration(process.env.FLUID_WORKER_DATABASE_URL),
    max: 3, connectionTimeoutMillis: 10_000, statement_timeout: 15_000, query_timeout: 15_000 }) : undefined;
  const controller = new AbortController(), stop = () => controller.abort();
  const databaseUnavailable = () => { console.error("Embel local database connection became unavailable."); stop(); };
  pool?.on("error", databaseUnavailable);
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let logo: LogoConceptStartup | undefined;
  try {
    logo = await startLogoConceptWorker({ configuration: await readProtectedLogoConceptConfiguration(process.cwd()), storage: options.logoStorage });
    if (logo.status === "unavailable") console.warn("Embel logo concepts unavailable:", logo.reason);
    const runtime = createLocalChatGPTRuntime({ configuration, database: pool,
      onReadinessFailure: failure => console.warn("Embel worker readiness unavailable.", failure),
      onSignInFailure: failure => console.warn("Embel ChatGPT sign-in unavailable.", failure) });
    await runLocalRuntimeHost({ runtime, logoRuntime: logo.status === "ready" ? logo.runtime : undefined, signal: controller.signal,
      onListening: () => console.info("Embel local worker listening on 127.0.0.1:3107. Live work requires an approved connection and database setup.") });
  } finally {
    stop();
    try { await logo?.close(); }
    finally {
      try { await pool?.end(); }
      finally {
        pool?.removeListener("error", databaseUnavailable);
        process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
      }
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) runLocalRuntime().catch(() => { console.error("Embel local worker could not start. Check its local configuration."); process.exitCode = 1; });
