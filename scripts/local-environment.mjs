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

async function workerDatabaseUrl(root) {
  const directory = path.join(root, ".local-fluid");
  const before = await optionalStat(directory);
  if (!before) return undefined;
  if (!before.isDirectory() || before.isSymbolicLink() || !ownerOnly(before, 0o700))
    throw new Error("The local worker directory must be owned by this user with mode 0700 and no symlinks.");
  const contents = await readConfiguration(path.join(directory, "worker.env"), { ownerOnlyMode: true });
  const after = await optionalStat(directory);
  if (!after || after.isSymbolicLink() || !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino || !ownerOnly(after, 0o700))
    throw new Error("The local worker directory changed while being inspected.");
  if (contents === undefined) return undefined;
  // One literal assignment, no shell evaluation, interpolation or duplicate keys.
  const lines = contents.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  const assignment = lines.length === 1 && /^FLUID_WORKER_DATABASE_URL[ \t]*=[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^ \t#'"\r\n]+))[ \t]*(?:#.*)?$/.exec(lines[0]);
  if (!assignment) throw new Error("The worker file must contain only one FLUID_WORKER_DATABASE_URL assignment.");
  const value = assignment[1] ?? assignment[2] ?? assignment[3];
  localWorkerDatabaseConfiguration(value);
  return value;
}

export async function prepareLocalChildEnvironments(root, inherited, { bridgeToken, connectionApproved = false }) {
  if (inherited.VERCEL) throw new Error("Embel local mode cannot run on a hosted deployment.");
  if (Object.hasOwn(inherited, WORKER_KEY)) throw new Error("Worker database credentials must be stored only in .local-fluid/worker.env.");
  if (inherited.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("Local mode requires verified TLS.");
  let publicConfiguration = {};
  for (const filename of NEXT_ENV_FILES) {
    const contents = await readConfiguration(path.join(root, filename), { ownerOnlyMode: filename === ".env.local" });
    if (contents === undefined) continue;
    const parsed = parseEnv(contents);
    // Also cover dotenv's legacy `KEY: value` syntax, which Next.js accepts.
    if (Object.hasOwn(parsed, WORKER_KEY) || /(?:^|[\r\n])\s*(?:export\s+)?FLUID_WORKER_DATABASE_URL\s*(?:=|:\s)/.test(contents))
      throw new Error("Remove the worker database credential from Next.js environment files before starting local mode.");
    if (filename === ".env.local") publicConfiguration = parsed;
  }
  const databaseUrl = await workerDatabaseUrl(root);
  const common = { ...publicConfiguration, ...inherited, NODE_ENV: "production", FLUID_RUNTIME: "local",
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
