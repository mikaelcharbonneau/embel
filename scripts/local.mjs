import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prepareLocalChildEnvironments } from "./local-environment.mjs";
import { superviseLocalPrototype } from "./local-supervisor.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const flags = new Set(process.argv.slice(2));
if ([...flags].some(flag => !["--enable-connection", "--prototype"].includes(flag))) throw new Error("Unknown local runtime option.");
const prototype = flags.has("--prototype");
const environments = await prepareLocalChildEnvironments(root, process.env, {
  bridgeToken: randomBytes(32).toString("base64url"), connectionApproved: flags.has("--enable-connection"), prototype,
});
if (prototype) {
  // Refuse before rebuilding or starting a worker when another local app owns
  // the one prototype URL. Existing processes are never stopped implicitly.
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error("Embel local port 3106 is already in use. Stop its owning runtime before starting the prototype.")));
    probe.listen(3106, "127.0.0.1", () => probe.close(error => error ? reject(new Error("Embel local port could not be checked.")) : resolve()));
  });
} else await access(path.join(root, ".next/BUILD_ID")).catch(() => { throw new Error("Build Embel before starting local mode: npm run build"); });
const children = [];
let stopping = false;
let prototypeSupervisor;
function stop(code = 0, signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  if (prototypeSupervisor) prototypeSupervisor.stop(code, signal);
  else process.exitCode = code;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop(0, signal));
function start(args, env, { build = false } = {}) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  children.push(child);
  child.once("error", () => stop(1));
  if (!build) child.once("exit", code => { if (!stopping) stop(code || 1); });
  return child;
}
if (prototype) {
  console.info("Building the current Embel prototype before startup.");
  const build = start(["node_modules/next/dist/bin/next", "build", "--webpack"], environments.web, { build: true });
  const built = await new Promise(resolve => { build.once("exit", code => resolve(code === 0)); build.once("error", () => resolve(false)); });
  if (!built || stopping) stop(1);
}
if (!stopping) {
  const workerArgs = ["--conditions=react-server", "--import", "tsx", prototype ? "worker/index.ts" : "worker/local-runtime.ts"];
  const webArgs = ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3106"];
  if (prototype) prototypeSupervisor = superviseLocalPrototype({
    startWorker: () => spawn(process.execPath, workerArgs, { cwd: root, env: environments.worker, stdio: "inherit" }),
    startWeb: () => spawn(process.execPath, webArgs, { cwd: root, env: environments.web, stdio: "inherit" }),
    onEvent: event => console.info(JSON.stringify(event)), onExitCode: code => { process.exitCode = code; },
  });
  else { start(workerArgs, environments.worker); start(webArgs, environments.web); }
  console.info("Embel local: http://127.0.0.1:3106 — keep this command running for the app and background work.");
  console.info(prototype ? "The local prototype uses the approved account database and supervised Strategy and Naming worker."
    : flags.has("--enable-connection") ? "ChatGPT connection is enabled for an explicitly approved browser sign-in."
      : "ChatGPT connection is locked pending its specific consent step; no credentials will be created.");
}
