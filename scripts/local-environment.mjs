import { constants, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";

const WORKER_KEY = "FLUID_WORKER_DATABASE_URL";
const APPROVED_DATABASE_HOST = "db.fricsfwqibyhemknqgyf.supabase.co";
const APPROVED_POOLER_HOST = "aws-0-us-east-1.pooler.supabase.com";
const WORKER_ROLE = "fluid_local_worker";
const PROJECT_REF = "fricsfwqibyhemknqgyf";
function databaseCertificate() {
  const ca = readFileSync(new URL("./certs/supabase-prod-ca-2021.crt", import.meta.url), "utf8");
  if (createHash("sha256").update(ca).digest("hex") !== "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7")
    throw new Error("Database certificate integrity check failed.");
  return ca;
}
const NEXT_ENV_FILES = [".env", ".env.local", ".env.production", ".env.production.local"];
const MAX_ENV_BYTES = 65_536;
const PROTOTYPE_WORKER_KEYS = ["OPENAI_API_KEY", "FLUID_NAMING_BRAIN_DATABASE_URL"];
const PROTOTYPE_MODEL = "gpt-6-luna";
const PROTOTYPE_DEPLOYMENT = "embel-naming-local-b2ff6ce8bbc2-20261017";
const hostedRuntimeMarker = key => key !== "VERCEL_PROJECT_ID" && /^VERCEL(?:_|$)/u.test(key);

function ownerOnly(info, mode) {
  return (info.mode & 0o7777) === mode && typeof process.getuid === "function" && info.uid === process.getuid();
}

async function optionalStat(filename) {
  try { return await lstat(filename); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw new Error("Local configuration could not be inspected."); }
}

async function readConfiguration(filename, { ownerOnlyMode = false } = {}) {
  const before = await optionalStat(filename);
  if (!before) return undefined;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_ENV_BYTES ||
      (ownerOnlyMode && !ownerOnly(before, 0o600))) throw new Error("Local configuration must be a protected regular file.");
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 ||
        (ownerOnlyMode && !ownerOnly(opened, 0o600))) throw new Error();
    const bytes = Buffer.alloc(MAX_ENV_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_ENV_BYTES) throw new Error();
    return bytes.subarray(0, bytesRead).toString("utf8");
  } catch { throw new Error("Local configuration could not be read safely."); }
  finally { await handle?.close(); }
}

/** Explicit fields prevent pg connection-string options from replacing TLS. */
export function localWorkerDatabaseConfiguration(value) {
  const error = () => new Error("Worker database configuration requires the approved endpoint, dedicated role and sslmode=verify-full.");
  try {
    if (typeof value !== "string" || !value || value.length > 8192 || /[\s\x00-\x1f\x7f]/.test(value)) throw error();
    const url = new URL(value);
    const parameters = [...url.searchParams];
    if (!["postgres:", "postgresql:"].includes(url.protocol) || ![APPROVED_DATABASE_HOST, APPROVED_POOLER_HOST].includes(url.hostname) ||
        (url.port && url.port !== "5432") || url.pathname !== "/postgres" || url.hash || !url.username || !url.password ||
        parameters.length !== 1 || parameters[0][0] !== "sslmode" || parameters[0][1] !== "verify-full") throw error();
    const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
    const expectedUser = url.hostname === APPROVED_POOLER_HOST ? `${WORKER_ROLE}.${PROJECT_REF}` : WORKER_ROLE;
    if (user !== expectedUser) throw error();
    if (/[\x00-\x1f\x7f]/.test(user + password)) throw error();
    return { host: url.hostname, port: 5432, database: "postgres", user, password,
      ssl: { ca: databaseCertificate(), rejectUnauthorized: true, servername: url.hostname, minVersion: "TLSv1.2" },
      sslnegotiation: "postgres" };
  } catch { throw error(); }
}

/** The prototype reuses the approved restricted Naming login. Native connection
 * files may name sslrootcert, but pg always receives our pinned CA explicitly. */
export function localPrototypeDatabaseConfiguration(value) {
  const error = () => new Error("Prototype database configuration requires the approved endpoint, dedicated role and verified TLS.");
  try {
    if (typeof value !== "string" || !value || value.length > 8192 || /[\s\x00-\x1f\x7f]/.test(value)) throw error();
    const url = new URL(value), parameters = [...url.searchParams];
    const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
    const expectedUser = url.hostname === APPROVED_POOLER_HOST ? `fluid_naming_brain_worker.${PROJECT_REF}` : "fluid_naming_brain_worker";
    if (!["postgres:", "postgresql:"].includes(url.protocol) || ![APPROVED_DATABASE_HOST, APPROVED_POOLER_HOST].includes(url.hostname) ||
        (url.port && url.port !== "5432") || url.pathname !== "/postgres" || url.hash || !password || user !== expectedUser ||
        /[\x00-\x1f\x7f]/.test(user + password) || url.searchParams.get("sslmode") !== "verify-full" ||
        parameters.some(([key, entry]) => !["sslmode", "sslrootcert"].includes(key) || !entry) ||
        new Set(parameters.map(([key]) => key)).size !== parameters.length) throw error();
    return { host: url.hostname, port: 5432, database: "postgres", user, password,
      ssl: { ca: databaseCertificate(), rejectUnauthorized: true, servername: url.hostname, minVersion: "TLSv1.2" },
      sslnegotiation: "postgres" };
  } catch { throw error(); }
}

async function protectedWorkerFile(root, filename) {
  const directory = path.join(root, ".local-fluid");
  const before = await optionalStat(directory);
  if (!before) return undefined;
  if (!before.isDirectory() || before.isSymbolicLink() || !ownerOnly(before, 0o700))
    throw new Error("The local worker directory must be owned by this user with mode 0700 and no symlinks.");
  const contents = await readConfiguration(path.join(directory, filename), { ownerOnlyMode: true });
  const after = await optionalStat(directory);
  if (!after || after.isSymbolicLink() || !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino || !ownerOnly(after, 0o700))
    throw new Error("The local worker directory changed while being inspected.");
  return contents;
}

async function workerDatabaseUrl(root) {
  const contents = await protectedWorkerFile(root, "worker.env");
  if (contents === undefined) return undefined;
  // One literal assignment, no shell evaluation, interpolation or duplicate keys.
  const lines = contents.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  const assignment = lines.length === 1 && /^FLUID_WORKER_DATABASE_URL[ \t]*=[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^ \t#'"\r\n]+))[ \t]*(?:#.*)?$/.exec(lines[0]);
  if (!assignment) throw new Error("The worker file must contain only one FLUID_WORKER_DATABASE_URL assignment.");
  const value = assignment[1] ?? assignment[2] ?? assignment[3];
  localWorkerDatabaseConfiguration(value);
  return value;
}

async function prototypeWorkerConfiguration(root) {
  const contents = await protectedWorkerFile(root, "naming-worker.env");
  if (contents === undefined) throw new Error("The prototype requires the existing protected Naming worker configuration.");
  const parsed = {};
  for (const line of contents.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"))) {
    const assignment = /^(OPENAI_API_KEY|FLUID_NAMING_BRAIN_DATABASE_URL)[ \t]*=[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^ \t#'"\r\n]+))[ \t]*(?:#.*)?$/.exec(line);
    if (!assignment || Object.hasOwn(parsed, assignment[1])) throw new Error("The protected Naming file must contain exactly the approved credential assignments.");
    parsed[assignment[1]] = assignment[2] ?? assignment[3] ?? assignment[4];
  }
  if (PROTOTYPE_WORKER_KEYS.some(key => !Object.hasOwn(parsed, key)) || !/^\S{16,500}$/u.test(parsed.OPENAI_API_KEY))
    throw new Error("The protected Naming worker configuration is incomplete.");
  localPrototypeDatabaseConfiguration(parsed.FLUID_NAMING_BRAIN_DATABASE_URL);
  return parsed;
}

export async function prepareLocalChildEnvironments(root, inherited, { bridgeToken, connectionApproved = false, prototype = false }) {
  if (prototype && (connectionApproved || Object.keys(inherited).some(key => hostedRuntimeMarker(key) && inherited[key] !== undefined)))
    throw new Error("The prototype requires its isolated local runtime without hosted or subscription connection options.");
  if (inherited.VERCEL) throw new Error("Embel local mode cannot run on a hosted deployment.");
  if (Object.hasOwn(inherited, WORKER_KEY)) throw new Error("Worker database credentials must be stored only in .local-fluid/worker.env.");
  if (prototype && PROTOTYPE_WORKER_KEYS.some(key => Object.hasOwn(inherited, key)))
    throw new Error("Prototype credentials must be read only from the existing protected Naming worker file.");
  if (inherited.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("Local mode requires verified TLS.");
  let publicConfiguration = {};
  for (const filename of NEXT_ENV_FILES) {
    const contents = await readConfiguration(path.join(root, filename), { ownerOnlyMode: filename === ".env.local" });
    if (contents === undefined) continue;
    const parsed = parseEnv(contents);
    // Also cover dotenv's legacy `KEY: value` syntax, which Next.js accepts.
    if (Object.hasOwn(parsed, WORKER_KEY) || /(?:^|[\r\n])\s*(?:export\s+)?FLUID_WORKER_DATABASE_URL\s*(?:=|:\s)/.test(contents))
      throw new Error("Remove the worker database credential from Next.js environment files before starting local mode.");
    if (prototype && PROTOTYPE_WORKER_KEYS.some(key => Object.hasOwn(parsed, key) ||
        new RegExp(`(?:^|[\\r\\n])\\s*(?:export\\s+)?${key}\\s*(?:=|:\\s)`, "u").test(contents)))
      throw new Error("Prototype worker credentials cannot be stored in Next.js environment files.");
    if (prototype && Object.keys(parsed).some(hostedRuntimeMarker))
      throw new Error("Remove hosted runtime markers from Next.js environment files before starting the local prototype.");
    if (filename === ".env.local") publicConfiguration = parsed;
  }
  if (prototype) {
    const credentials = await prototypeWorkerConfiguration(root);
    // Keep Next's environment public and minimal. It still reads its ordinary
    // account cookies and owner-scoped Supabase APIs; no privileged web key exists.
    const common = { NODE_ENV: "production", FLUID_RUNTIME: "local", FLUID_LOCAL_PROTOTYPE: "true",
      APP_ORIGIN: "http://127.0.0.1:3106", FLUID_LOCAL_CONNECTION_APPROVED: "false",
      FLUID_PAID_CALLS_APPROVED: "false", NEXT_TELEMETRY_DISABLED: "1" };
    for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]) {
      const value = inherited[key] ?? publicConfiguration[key];
      if (value !== undefined) common[key] = value;
    }
    const web = { ...common };
    const worker = { ...common, ...credentials, FLUID_WORKER_DATABASE_URL: credentials.FLUID_NAMING_BRAIN_DATABASE_URL,
      FLUID_NAMING_BRAIN_MODEL: PROTOTYPE_MODEL, FLUID_OPENAI_VERIFIED_MODELS: PROTOTYPE_MODEL,
      FLUID_NAMING_BRAIN_DEPLOYMENT_ID: PROTOTYPE_DEPLOYMENT, FLUID_NAMING_BRAIN_ENABLED: "true", FLUID_PAID_CALLS_APPROVED: "true",
      FLUID_GUIDED_INTERVIEW_ENABLED: "true" };
    for (const operation of ["REFORMULATE", "COMPETITORS", "AUDIENCE", "PERSONALITY"]) worker[`FLUID_TEXT_MODEL_${operation}`] = PROTOTYPE_MODEL;
    return { web, worker };
  }
  const databaseUrl = await workerDatabaseUrl(root);
  const common = { ...publicConfiguration, ...inherited, NODE_ENV: "production", FLUID_RUNTIME: "local",
    FLUID_LOCAL_PROTOTYPE: "false",
    APP_ORIGIN: "http://127.0.0.1:3106", FLUID_LOCAL_BRIDGE_TOKEN: bridgeToken,
    FLUID_LOCAL_CONNECTION_APPROVED: connectionApproved ? "true" : "false",
    FLUID_PAID_CALLS_APPROVED: "false", NEXT_TELEMETRY_DISABLED: "1" };
  // No startup hooks or generic Postgres environment fallback can reopen the
  // checked files or substitute a second credential source in either child.
  for (const key of Object.keys(common)) {
    if (/^PG/.test(key) || [WORKER_KEY, "OPENAI_API_KEY", "VERCEL", "NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED"].includes(key)) delete common[key];
  }
  const web = { ...common }, worker = { ...common };
  for (const key of ["FLUID_LOGO_WEB_DATABASE_URL", "FLUID_LOGO_WEB_OWNER_ID", "FLUID_LOGO_WEB_ROLE_NAME", "FLUID_LOGO_WEB_ROLE_OID"])
    delete worker[key];
  if (databaseUrl !== undefined) worker[WORKER_KEY] = databaseUrl;
  return { web, worker };
}
