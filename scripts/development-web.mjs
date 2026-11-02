#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { parseEnv } from "node:util";
import { readOptional, repositoryRoot, settingsFor } from "./development/config.mjs";

const configured = await readOptional(path.join(repositoryRoot, ".embel-dev/web.env"));
const settings = await settingsFor(repositoryRoot);
const args = process.argv.slice(2);
if (args.some(arg => /^(?:--port(?:=|$)|--hostname(?:=|$)|-p|-H)/.test(arg))) {
  console.error("Set the web port with npm run dev:setup -- --web-port PORT, then npm run dev:up. The development host is 127.0.0.1.");
  process.exitCode = 1;
} else if (configured && Object.keys(process.env).some(key => /^VERCEL(?:_|$)/.test(key))) {
  console.error("Use a local development shell without hosted Vercel markers.");
  process.exitCode = 1;
} else {
  const publicFields = ["EMBEL_DEVELOPMENT_ENABLED", "APP_ORIGIN", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "FLUID_PAID_CALLS_APPROVED", "NEXT_TELEMETRY_DISABLED"];
  const values = configured ? parseEnv(configured) : {};
  const managed = Object.fromEntries(publicFields.filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]]));
  const child = spawn(process.execPath, [path.join(repositoryRoot, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(settings.webPort), ...args], {
    cwd: repositoryRoot, env: { ...process.env, ...managed, NODE_ENV: "development" }, stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", () => { console.error("Cannot start Next.js; run npm ci first."); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1); });
}
