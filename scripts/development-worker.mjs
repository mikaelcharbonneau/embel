import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

// Use Node directly so the same npm command works in POSIX shells and Windows.
// Resolve the checkout here, including when this launcher is called elsewhere.
const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
if ((args.length !== 2 && args.length !== 3) || args[0] !== "--lane"
  || !["strategy", "logo"].includes(args[1]) || (args.length === 3 && args[2] !== "--run")) {
  console.error("Use npm run dev:worker -- --lane strategy|logo [--run].");
  process.exit(2);
}
function optionalEnvironment(relative) {
  try { return parseEnv(readFileSync(new URL(relative, import.meta.url), "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return {}; throw error; }
}
let environment;
try {
  environment = {
    FLUID_PAID_CALLS_APPROVED: "false",
    ...optionalEnvironment("../.env.development.local"),
    ...optionalEnvironment(`../.embel-dev/${args[1]}.env`),
    ...process.env,
    NODE_ENV: "development",
  };
  const managed = optionalEnvironment("../.embel-dev/web.env");
  // A managed stack owns its public target, while worker credentials and paid
  // dispatch flags retain their explicit per-lane or inherited configuration.
  for (const name of ["EMBEL_DEVELOPMENT_ENABLED", "APP_ORIGIN", "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_TELEMETRY_DISABLED"]) {
    if (Object.hasOwn(managed, name)) environment[name] = managed[name];
  }
} catch {
  console.error("Embel development worker settings could not be loaded.");
  process.exit(2);
}
const child = spawn(process.execPath, [
  "--conditions=react-server", "--import", "tsx",
  "worker/development/index.ts", ...args,
], { cwd: root, env: environment, stdio: "inherit" });

const interrupt = () => child.kill("SIGINT");
const terminate = () => child.kill("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
function cleanup() {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
}
child.once("error", () => {
  cleanup();
  console.error("Embel development worker could not start.");
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  cleanup();
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
});
