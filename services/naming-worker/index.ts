import { readCloudNamingConfiguration, readCloudNamingMode } from "../../worker/cloud-naming-configuration";
import { runCloudNamingWorker } from "./runtime";

// esbuild substitutes only the public commit SHA and expected project identity.
// Credentials and the rest of the runtime environment are never embedded.
declare const __EMBEL_NAMING_BUILD_REVISION__: string;
declare const __EMBEL_NAMING_BUILD_PROJECT_ID__: string;

async function main() {
  const mode = readCloudNamingMode(process.argv.slice(2));
  const configuration = readCloudNamingConfiguration({ mode,
    sourceRevision: typeof __EMBEL_NAMING_BUILD_REVISION__ === "string" ? __EMBEL_NAMING_BUILD_REVISION__ : "",
    expectedProjectId: typeof __EMBEL_NAMING_BUILD_PROJECT_ID__ === "string" ? __EMBEL_NAMING_BUILD_PROJECT_ID__ : "" });
  const controller = new AbortController(), stop = () => controller.abort();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try { await runCloudNamingWorker({ configuration, mode, signal: controller.signal }); }
  finally { stop(); process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
}

main().catch(() => {
  // Never serialize pg errors, provider responses, environment or credentials.
  console.error(JSON.stringify({ event: "cloud_naming_worker_stopped", reason: "configuration_or_database_failure" }));
  process.exitCode = 1;
});
