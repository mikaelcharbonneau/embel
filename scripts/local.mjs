import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prepareLocalChildEnvironments } from "./local-environment.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const flags = new Set(process.argv.slice(2));
if ([...flags].some(flag => flag !== "--enable-connection")) throw new Error("Unknown local runtime option.");
const environments = await prepareLocalChildEnvironments(root, process.env, {
  bridgeToken: randomBytes(32).toString("base64url"), connectionApproved: flags.has("--enable-connection"),
});
await access(path.join(root, ".next/BUILD_ID")).catch(() => { throw new Error("Build Embel before starting local mode: npm run build"); });
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true; process.exitCode = code;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop());
function start(args, env) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  children.push(child);
  child.once("error", () => stop(1));
  child.once("exit", code => { if (!stopping) stop(code || 1); });
}
start(["--conditions=react-server", "--import", "tsx", "worker/local-runtime.ts"], environments.worker);
start(["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3106"], environments.web);
console.info("Embel local: http://127.0.0.1:3106 — both processes must remain running for background work.");
console.info(flags.has("--enable-connection") ? "ChatGPT connection is enabled for an explicitly approved browser sign-in." : "ChatGPT connection is locked pending its specific consent step; no credentials will be created.");
