import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareLocalChildEnvironments } from "./local-environment.mjs";

// Reuse the existing owner-only credential reader and verified database TLS.
// Credentials enter only the worker environment; launch configuration is public.
const root = fileURLToPath(new URL("..", import.meta.url));
if (process.argv.length !== 2) throw new Error("The Naming worker launcher accepts no arguments.");
const { worker } = await prepareLocalChildEnvironments(root, process.env, { prototype: true });
const child = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", "worker/index.ts", "--naming-only"], {
  cwd: root, env: worker, stdio: "inherit",
});
let stopping = false;
let shutdownTimer;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
  shutdownTimer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  shutdownTimer.unref();
}
const terminate = () => stop("SIGTERM"), interrupt = () => stop("SIGINT");
process.once("SIGTERM", terminate); process.once("SIGINT", interrupt);
function cleanup() {
  clearTimeout(shutdownTimer);
  process.removeListener("SIGTERM", terminate); process.removeListener("SIGINT", interrupt);
}
child.once("error", () => { cleanup(); console.error("Embel Naming worker could not start."); process.exitCode = 1; });
child.once("exit", code => { cleanup(); process.exitCode = stopping ? 0 : code ?? 1; });
