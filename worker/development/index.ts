import { readDevelopmentWorkerArguments } from "./config";
import { runDevelopmentWorker } from "./runtime";

const controller = new AbortController(), stop = () => controller.abort();
process.once("SIGTERM", stop); process.once("SIGINT", stop);
try {
  const selection = readDevelopmentWorkerArguments(process.argv.slice(2));
  const result = await runDevelopmentWorker({ ...selection, signal: controller.signal });
  // Fixed operational results only: never print configuration, keys or pg errors.
  console.info(JSON.stringify({ event: "development_worker_result", ...result }));
} catch {
  console.error(JSON.stringify({ event: "development_worker_unavailable" }));
  process.exitCode = 2;
} finally {
  stop(); process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
}
