import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const cliVersion = "2.122.0";
export const defaults = Object.freeze({ webPort: 3105, apiPort: 54321, dbPort: 54322, shadowPort: 54320, mailPort: 54324 });
export const digest = value => createHash("sha256").update(value).digest("hex");

export class DevelopmentError extends Error {}

export async function readOptional(file) {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function validateSettings(value) {
  if (!value || value.version !== 1 || !/^embel-dev-[a-f0-9]{12}$/.test(value.projectId ?? "")) {
    throw new DevelopmentError("Invalid development settings. Run npm run dev:setup.");
  }
  const ports = Object.keys(defaults).map(key => value[key]);
  if (ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535) || new Set(ports).size !== ports.length) {
    throw new DevelopmentError("Development ports must be distinct integers between 1024 and 65535.");
  }
  return Object.fromEntries([...["version", "projectId"].map(key => [key, value[key]]), ...Object.keys(defaults).map(key => [key, value[key]])]);
}

export async function settingsFor(root, overrides = {}) {
  const saved = await readOptional(path.join(root, ".embel-dev/settings.json"));
  const original = saved ? validateSettings(JSON.parse(saved)) : { version: 1, projectId: "embel-dev-" + digest(await realpath(root)).slice(0, 12), ...defaults };
  for (const key of Object.keys(overrides)) if (!Object.hasOwn(defaults, key)) throw new DevelopmentError("Unknown development setting.");
  return validateSettings({ ...original, ...overrides });
}

export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new DevelopmentError("Development state must be a real directory.");
  await chmod(directory, 0o700);
}

export async function writeState(file, value) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new DevelopmentError("Development state cannot replace a link or non-file.");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await writeFile(file, value, { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function migrationSources(root) {
  const directory = path.join(root, "supabase/migrations");
  const entries = (await readdir(directory)).filter(name => name.endsWith(".sql")).map(source => ({ source, staged: source.replace(/^local/, "") }));
  const seen = new Set();
  for (const entry of entries) {
    if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(entry.staged) || seen.has(entry.staged.slice(0, 14))) {
      throw new DevelopmentError("Migration filenames have an invalid or duplicate version.");
    }
    seen.add(entry.staged.slice(0, 14));
  }
  entries.sort((a, b) => a.staged.localeCompare(b.staged));
  if (!entries.length) throw new DevelopmentError("No baseline migrations found.");
  return Promise.all(entries.map(async entry => {
    const bytes = await readFile(path.join(directory, entry.source));
    return { ...entry, bytes, sha256: digest(bytes) };
  }));
}

export async function prepare(root, overrides = {}) {
  const settings = await settingsFor(root, overrides);
  const state = path.join(root, ".embel-dev");
  await privateDirectory(state);
  await privateDirectory(path.join(state, "supabase"));
  await privateDirectory(path.join(state, "supabase/migrations"));
  const migrations = await migrationSources(root);
  const target = path.join(state, "supabase/migrations");
  const names = new Set(migrations.map(entry => entry.staged));
  if ((await readdir(target)).some(name => name.endsWith(".sql") && !names.has(name))) {
    throw new DevelopmentError("The local database belongs to a newer/different migration history. Use a separate checkout for that history.");
  }
  for (const entry of migrations) {
    const destination = path.join(target, entry.staged);
    const existing = await readOptional(destination);
    if (existing !== null && digest(Buffer.from(existing)) !== entry.sha256) {
      throw new DevelopmentError("A staged migration differs from this checkout. Use a separate checkout instead of changing applied history.");
    }
    if (existing === null) await writeState(destination, entry.bytes);
  }
  const template = await readFile(path.join(root, "config/development/supabase.toml"), "utf8");
  const config = template.replace(/\{\{([A-Za-z]+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(settings, key)) throw new DevelopmentError("Unknown Supabase configuration placeholder.");
    return String(settings[key]);
  });
  await writeState(path.join(state, "supabase/config.toml"), config);
  await writeState(path.join(state, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
  await writeState(path.join(state, "migration-manifest.json"), JSON.stringify(migrations.map(({ source, staged, sha256 }) => ({ source, staged, sha256 })), null, 2) + "\n");
  return { settings, state, migrations };
}

export function publicEnvironment(settings, status = null) {
  if (status && (status.API_URL !== "http://127.0.0.1:" + settings.apiPort || typeof status.PUBLISHABLE_KEY !== "string" || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(status.PUBLISHABLE_KEY))) {
    throw new DevelopmentError("Supabase returned an unexpected local URL or publishable key.");
  }
  // Deliberately allowlist fields; CLI output also contains private bootstrap keys.
  return "# Generated by Embel development setup; local public web settings only.\n" +
    "EMBEL_DEVELOPMENT_ENABLED=" + (status ? "true" : "false") + "\n" +
    "APP_ORIGIN=http://127.0.0.1:" + settings.webPort + "\n" +
    "NEXT_PUBLIC_SUPABASE_URL=" + (status ? status.API_URL : "") + "\n" +
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=" + (status ? status.PUBLISHABLE_KEY : "") + "\n" +
    "FLUID_PAID_CALLS_APPROVED=false\nNEXT_TELEMETRY_DISABLED=1\n";
}

export function localDockerEnvironment(endpoint, environment = process.env) {
  const unix = /^unix:\/\/\/[^\r\n\0]+$/.test(endpoint);
  const pipe = typeof endpoint === "string" && endpoint.startsWith("npipe:////./pipe/") && /^[A-Za-z0-9_.-]+$/.test(endpoint.slice("npipe:////./pipe/".length));
  if (!unix && !pipe) throw new DevelopmentError("Select a local Docker Desktop/Engine context; remote Docker endpoints are not supported for local development.");
  const result = { ...environment, DOCKER_HOST: endpoint };
  for (const key of ["DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) delete result[key];
  return result;
}
