import { readCloudLogoConfiguration, readCloudLogoMode } from "../../worker/cloud-logo-configuration";
import { runCloudLogoWorker } from "./runtime";

declare const __EMBEL_LOGO_BUILD_REVISION__: string;
declare const __EMBEL_LOGO_BUILD_PROJECT_ID__: string;

async function main() {
  const mode = readCloudLogoMode(process.argv.slice(2));
  const configuration = readCloudLogoConfiguration({ mode,
    sourceRevision: typeof __EMBEL_LOGO_BUILD_REVISION__ === "string" ? __EMBEL_LOGO_BUILD_REVISION__ : "",
    expectedProjectId: typeof __EMBEL_LOGO_BUILD_PROJECT_ID__ === "string" ? __EMBEL_LOGO_BUILD_PROJECT_ID__ : "" });
  const controller = new AbortController(), stop = () => controller.abort();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try { await runCloudLogoWorker({ configuration, mode, signal: controller.signal }); }
  finally { stop(); process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
}

main().catch(() => {
  console.error(JSON.stringify({ event: "cloud_logo_worker_stopped", reason: "configuration_or_runtime_failure" }));
  process.exitCode = 1;
});
