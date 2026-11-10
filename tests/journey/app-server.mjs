#!/usr/bin/env node
// Starts the app for the browser journey: `next dev` on the stack's web port with the
// journey environment (tests/journey/stack.mjs), without hosted Vercel markers. The server's
// output goes to test-results/journey-app.log (kept as a CI artifact); errors also reach stderr.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { journeyStack, root } from "./stack.mjs";

const stack = journeyStack();
// Each run starts with no workflow history, so nothing from an earlier run is resumed.
rmSync(stack.appEnvironment.WORKFLOW_LOCAL_DATA_DIR, { recursive: true, force: true });
const env = { ...process.env, ...stack.appEnvironment };
for (const key of Object.keys(env)) if (/^VERCEL(?:_|$)/u.test(key)) delete env[key];
mkdirSync(path.join(root, "test-results"), { recursive: true });
const log = createWriteStream(path.join(root, "test-results/journey-app.log"));
const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(stack.settings.webPort)],
  { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.pipe(log, { end: false });
child.stderr.on("data", chunk => { log.write(chunk); process.stderr.write(chunk); });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", code => { log.end(); process.exitCode = code ?? 1; });
