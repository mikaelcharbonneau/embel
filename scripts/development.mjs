#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cliVersion, defaults, digest, DevelopmentError, localDockerEnvironment, migrationSources, prepare, publicEnvironment, readOptional, repositoryRoot, settingsFor, writeState } from "./development/config.mjs";

export { localDockerEnvironment } from "./development/config.mjs";

const execute = promisify(execFile);
const services = ["db", "auth", "kong", "inbucket", "rest", "storage"];
const excludes = "studio,postgres-meta,edge-runtime,realtime,logflare,vector,supavisor,imgproxy";
let dockerEnvironment;

async function command(binary, args, env = process.env, phase = "command", timeout = 600_000) {
  try { return (await execute(binary, args, { env, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true })).stdout.trim(); }
  catch (error) {
    // Supabase start/status and Docker errors may contain private bootstrap values.
    let hint = error.code === "ENOENT" ? " The command is not installed." : "";
    const output = String(error.stderr ?? "") + String(error.stdout ?? "");
    if (/Cannot connect to the Docker daemon|Is the docker daemon running|dockerDesktopLinuxEngine.*cannot find/i.test(output)) hint = " Start Docker Desktop or the local Docker Engine.";
    if (/port is already allocated|address already in use|bind: address/i.test(output)) hint = " A configured port is already in use; choose other ports with dev:setup.";
    if (/unhealthy|health check|healthcheck/i.test(output)) hint = " A service health check failed. In a managed proxy environment, try dev:up -- --proxy-health.";
    if (/migration.*fail|ERROR:.*SQLSTATE/i.test(output)) hint = " A baseline migration failed; inspect the local database with your usual database client.";
    throw new DevelopmentError(phase + " failed." + hint + " Raw command output was withheld because it can contain credentials.");
  }
}

function localEnvironment(state) {
  return { ...(dockerEnvironment ?? process.env), SUPABASE_HOME: path.join(state, "cli-home"), SUPABASE_TELEMETRY_DISABLED: "1", SUPABASE_USE_SLIM_IMAGES: "true" };
}


async function selectLocalDocker() {
  let endpoint = process.env.DOCKER_CONTEXT ? null : process.env.DOCKER_HOST;
  if (!endpoint) {
    const context = process.env.DOCKER_CONTEXT || await command("docker", ["context", "show"], process.env, "Docker context");
    endpoint = JSON.parse(await command("docker", ["context", "inspect", context, "--format", "{{json .Endpoints.docker.Host}}"], process.env, "Docker context"));
  }
  dockerEnvironment = localDockerEnvironment(endpoint);
}

async function cli(root, state, args) {
  const script = path.join(root, "node_modules/supabase/dist/supabase.js");
  await access(script).catch(() => { throw new DevelopmentError("Run npm ci to install the pinned Supabase CLI."); });
  return command(process.execPath, [script, ...args, "--workdir", state], localEnvironment(state), "Supabase " + args[0]);
}

async function docker(args) { return command("docker", args, dockerEnvironment ?? process.env, "Docker " + args[0]); }

async function loopbackNetwork(settings) {
  const name = settings.projectId + "-loopback";
  let found;
  try { found = JSON.parse(await docker(["network", "inspect", name])); }
  catch { await docker(["network", "create", "--driver", "bridge", "--opt", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1", name]); }
  found ??= JSON.parse(await docker(["network", "inspect", name]));
  if (found[0]?.Driver !== "bridge" || found[0]?.Options?.["com.docker.network.bridge.host_binding_ipv4"] !== "127.0.0.1") {
    throw new DevelopmentError("The development network does not bind published ports to loopback.");
  }
  return name;
}

async function inspectServices(settings) {
  const result = [];
  for (const service of services) {
    const name = "supabase_" + service + "_" + settings.projectId;
    const metadata = JSON.parse(await docker(["inspect", "--format", "{{json .State}}", name]));
    const bindings = JSON.parse(await docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", name]));
    if (Object.values(bindings ?? {}).flat().filter(Boolean).some(binding => binding.HostIp !== "127.0.0.1" && binding.HostIp !== "::1")) {
      throw new DevelopmentError("A development service exposes a port outside loopback. Stop it with npm run dev:down.");
    }
    const expected = { db: ["5432/tcp", settings.dbPort], kong: ["8000/tcp", settings.apiPort], inbucket: ["8025/tcp", settings.mailPort] }[service];
    if (expected && !bindings?.[expected[0]]?.some(binding => binding.HostPort === String(expected[1]))) {
      throw new DevelopmentError("Running service ports differ from development settings. Run npm run dev:down, then npm run dev:up.");
    }
    if (!metadata.Running || metadata.Health && metadata.Health.Status !== "healthy") throw new DevelopmentError("Local " + service + " is not healthy.");
    if (service === "auth") {
      const format = '{{range .Config.Env}}{{$parts := split . "="}}{{if eq (index $parts 0) "GOTRUE_SITE_URL"}}{{index $parts 1}}{{end}}{{end}}';
      const site = await docker(["inspect", "--format", format, name]);
      if (site !== "http://127.0.0.1:" + settings.webPort) throw new DevelopmentError("Running Auth uses a different web origin. Run npm run dev:down, then npm run dev:up.");
    }
    result.push({ service, healthy: true });
  }
  return result;
}

async function health(settings, status) {
  publicEnvironment(settings, status);
  const checks = [];
  for (const endpoint of ["/auth/v1/health", "/storage/v1/status", "/rest/v1/projects?select=id"]) {
    let response;
    try { response = await fetch(status.API_URL + endpoint, { headers: { apikey: status.PUBLISHABLE_KEY }, signal: AbortSignal.timeout(10_000), redirect: "error" }); }
    catch { throw new DevelopmentError("Local service HTTP check failed."); }
    if (endpoint.startsWith("/rest/")) {
      const body = await response.json();
      const denied = [401, 403].includes(response.status) && body?.code === "42501";
      if (!denied && !(response.status === 200 && Array.isArray(body) && body.length === 0)) throw new DevelopmentError("Anonymous project isolation check failed.");
    } else if (response.status !== 200) throw new DevelopmentError("Local service HTTP check failed.");
    checks.push({ endpoint, status: response.status });
  }
  return checks;
}

async function coreStatus(root, state, settings, migrations) {
  const status = JSON.parse(await cli(root, state, ["status", "--output", "json"]));
  const serviceChecks = await inspectServices(settings);
  const http = await health(settings, status);
  const installed = (await docker(["exec", "supabase_db_" + settings.projectId, "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", "select version from supabase_migrations.schema_migrations order by version"])).split(/\r?\n/);
  const expected = migrations.map(entry => entry.staged.slice(0, 14));
  if (JSON.stringify(installed) !== JSON.stringify(expected)) throw new DevelopmentError("The installed local migration history differs from this checkout. Run npm run dev:up.");
  return { status, report: { coreReady: true, migrations: installed.length, services: serviceChecks, http } };
}

export function parseArguments(args) {
  const [action = "help", ...rest] = args;
  if (!["setup", "up", "down", "doctor", "help"].includes(action)) throw new DevelopmentError("Unknown command. Run npm run dev:setup -- --help.");
  const options = { action, ports: {}, proxyHealth: false };
  const flags = Object.fromEntries(Object.keys(defaults).map(key => ["--" + key.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase()), key]));
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--help") return { ...options, action: "help" };
    if (rest[i] === "--proxy-health" && action === "up") { options.proxyHealth = true; continue; }
    if (!Object.hasOwn(flags, rest[i]) || !["setup", "up"].includes(action) || !/^\d+$/.test(rest[i + 1] ?? "")) throw new DevelopmentError("Invalid development command option.");
    options.ports[flags[rest[i]]] = Number(rest[++i]);
  }
  return options;
}

export async function main(args, root = repositoryRoot) {
  const options = parseArguments(args);
  if (options.action === "help") {
    console.log("Embel portable development\n  npm run dev:setup     Prepare this checkout (no Docker required)\n  npm run dev:up        Start local services and provision full shared database\n  npm run dev:doctor    Check local services and shared worker process\n  npm run dev:down      Stop this checkout's stack, retaining its data\n  npm run dev:branding Build and start the shared branding worker\n  npm run dev          Start the web interface\n\nsetup/up options: --web-port, --api-port, --db-port, --shadow-port, --mail-port\nup option: --proxy-health (exact loopback health probes in managed proxy environments)");
    return;
  }
  if (options.action === "down") {
    const settings = await settingsFor(root);
    const state = path.join(root, ".embel-dev");
    if (!await readOptional(path.join(state, "settings.json"))) throw new DevelopmentError("This checkout has no managed development stack.");
    await selectLocalDocker();
    const { stopSharedRuntime } = await import("./development/shared-runtime.mjs");
    await stopSharedRuntime(root);
    await cli(root, state, ["stop", "--project-id", settings.projectId]);
    console.log("Stopped " + settings.projectId + "; local database and file volumes retained.");
    return;
  }
  const state = path.join(root, ".embel-dev");
  const previous = await readOptional(path.join(state, "settings.json"));
  if (options.action === "doctor" && !previous) throw new DevelopmentError("Run npm run dev:setup or npm run dev:up first.");
  if (options.action !== "setup") await selectLocalDocker();
  const { settings, migrations } = options.action === "doctor"
    ? { settings: await settingsFor(root), migrations: await migrationSources(root) }
    : await prepare(root, options.ports);
  const publicFile = path.join(state, "web.env");
  if (options.action !== "doctor" && (!await readOptional(publicFile) || previous && Object.keys(defaults).some(key => JSON.parse(previous)[key] !== settings[key]))) {
    await writeState(publicFile, publicEnvironment(settings));
  }
  if (options.action === "setup") {
    console.log("Prepared " + migrations.length + " baseline migrations and checkout-relative configuration.\nRun npm run dev for UI work, or npm run dev:up for local account services.");
    return;
  }
  await docker(["info", "--format", "{{.ServerVersion}}"]);
  const actualVersion = await cli(root, state, ["--version"]);
  if (actualVersion !== cliVersion) throw new DevelopmentError("The Supabase CLI version differs from package-lock.json; run npm ci.");
  if (options.action === "up") {
    const applied = await readOptional(path.join(state, "applied-config.sha256"));
    const current = digest(await readFile(path.join(state, "supabase/config.toml")));
    if (applied && applied.trim() !== current) {
      let running = false;
      try { running = await docker(["inspect", "--format", "{{.State.Running}}", "supabase_db_" + settings.projectId]) === "true"; } catch { /* a stopped stack has no container */ }
      if (running) throw new DevelopmentError("The running stack uses older configuration. Run npm run dev:down, then npm run dev:up.");
    }
    if (options.proxyHealth) {
      const { prepareProxyHealth } = await import("./development/proxy-health.mjs");
      await prepareProxyHealth(root, state, docker);
    }
    const network = await loopbackNetwork(settings);
    console.log("Starting the isolated stack; the first run may download container images.");
    await cli(root, state, ["start", "--network-id", network, "--exclude", excludes]);
    await inspectServices(settings);
    await cli(root, state, ["migration", "up", "--local"]);
  }
  const { status, report } = await coreStatus(root, state, settings, migrations);
  if (options.action === "up") {
    await writeState(publicFile, publicEnvironment(settings, status));
    await writeState(path.join(state, "applied-config.sha256"), digest(await readFile(path.join(state, "supabase/config.toml"))) + "\n");
    const { provisionDevelopmentSchema } = await import("./development/shared-schema-install.mjs");
    const { prepareSharedWeb } = await import("./development/shared-web.mjs");
    await provisionDevelopmentSchema(root);
    await prepareSharedWeb(root, settings);
  }
  const { sharedRuntimeStatus } = await import("./development/shared-runtime.mjs");
  const worker = await sharedRuntimeStatus(root);
  const sharedHttpConfigured = Boolean(await readOptional(path.join(state, "shared-web.env")));
  const ambientHostedMarkers = Object.keys(process.env).filter(key => /^VERCEL(?:_|$)/.test(key));
  console.log(JSON.stringify({ ...report, web: "http://127.0.0.1:" + settings.webPort, email: "http://127.0.0.1:" + settings.mailPort, sharedHttpConfigured, worker, ambientHostedMarkers,
    generation: worker.ready ? "All three worker lanes qualified; this is not proof of a completed provider generation." : worker.running ? "Worker process running but not all three lanes are qualified." : "Run npm run dev:branding with the dedicated application provider key to configure and start the shared engine." }, null, 2));
  if (ambientHostedMarkers.length) throw new DevelopmentError("Hosted Vercel markers are present in this shell; use a local development shell for npm run dev.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof DevelopmentError ? error.message : "Development setup failed. Check the local configuration and installed tools; private diagnostics were not printed."); process.exitCode = 1; }
}
