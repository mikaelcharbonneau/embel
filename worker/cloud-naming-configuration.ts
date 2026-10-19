import { createHash } from "node:crypto";
import type { PoolConfig } from "pg";
import { readNamingBrainConfiguration, type NamingBrainConfiguration } from "./naming-brain-configuration";

export const CLOUD_NAMING_RUNTIME = Object.freeze({ node: "22.22.2", icu: "78.2", unicode: "17.0" });
export const CLOUD_NAMING_SERVICE_NAME = "embel-naming-worker-production";
export const CLOUD_NAMING_DEPLOYMENT_ID = "embel-naming-local-b2ff6ce8bbc2-20261017";
const DATABASE_CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
const DIRECT_HOST = "db.fricsfwqibyhemknqgyf.supabase.co";
const POOLER_HOST = "aws-0-us-east-1.pooler.supabase.com";
export const CLOUD_NAMING_DATABASE_ROLE = "fluid_naming_brain_worker";
export const CLOUD_NAMING_DATABASE_ROLE_OID = 23033;

export type CloudNamingMode = "run" | "preflight";
export type CloudNamingConfiguration = NamingBrainConfiguration & {
  poolOptions: PoolConfig;
  sourceRevision: string;
  serviceId: string;
  instanceId: string;
};

/** This service always selects Naming. There is no generic worker argument. */
export function readCloudNamingMode(arguments_: readonly string[]): CloudNamingMode {
  if (arguments_.length === 0) return "run";
  if (arguments_.length === 1 && arguments_[0] === "--preflight") return "preflight";
  throw new Error("cloud_naming_arguments_invalid");
}

function databaseOptions(connectionString: string, ca: string | undefined): PoolConfig {
  try {
    if (!ca || createHash("sha256").update(ca).digest("hex") !== DATABASE_CA_SHA256
      || connectionString.length > 8192 || /[\s\x00-\x1f\x7f]/u.test(connectionString)) throw new Error();
    const url = new URL(connectionString), parameters = [...url.searchParams];
    const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
    const expectedUser = url.hostname === POOLER_HOST ? `${CLOUD_NAMING_DATABASE_ROLE}.fricsfwqibyhemknqgyf` : CLOUD_NAMING_DATABASE_ROLE;
    if (!["postgres:", "postgresql:"].includes(url.protocol) || ![DIRECT_HOST, POOLER_HOST].includes(url.hostname)
      || url.port && url.port !== "5432" || url.pathname !== "/postgres" || url.hash || user !== expectedUser || !password
      || /[\x00-\x1f\x7f]/u.test(user + password) || url.searchParams.get("sslmode") !== "verify-full"
      || parameters.some(([key, value]) => !["sslmode", "sslrootcert"].includes(key) || !value)
      || new Set(parameters.map(([key]) => key)).size !== parameters.length) throw new Error();
    // The legacy URL may name a Mac sslrootcert. Never read it or pass URL
    // options to pg: only the supplied, hash-pinned CA can configure TLS.
    return { host: url.hostname, port: 5432, database: "postgres", user, password,
      ssl: { ca, rejectUnauthorized: true, servername: url.hostname, minVersion: "TLSv1.2" },
      sslnegotiation: "postgres", max: 2, connectionTimeoutMillis: 30_000,
      statement_timeout: 15_000, query_timeout: 15_000, idleTimeoutMillis: 10_000,
      application_name: "embel-naming-worker", options: "" };
  } catch {
    // URL and TLS parser failures can retain credentials. Do not attach a cause.
    throw new Error("cloud_naming_database_configuration_invalid");
  }
}

/** Environment checks qualify this process, never a job's execution authority.
 * The existing database claim and dispatch gates remain authoritative. */
export function readCloudNamingConfiguration(options: {
  mode: CloudNamingMode;
  sourceRevision: string;
  env?: Record<string, string | undefined>;
  versions?: Pick<NodeJS.ProcessVersions, "node" | "icu" | "unicode">;
}): CloudNamingConfiguration {
  const env = options.env ?? process.env, versions = options.versions ?? process.versions;
  if (env.NODE_ENV !== "production" || env.FLUID_RUNTIME !== "cloud" || env.FLUID_LOCAL_PROTOTYPE !== "false"
    || env.RENDER !== "true" || env.IS_PULL_REQUEST !== "false" || env.RENDER_SERVICE_TYPE !== "worker"
    || env.RENDER_SERVICE_NAME !== CLOUD_NAMING_SERVICE_NAME || env.RENDER_GIT_REPO_SLUG !== "mikaelcharbonneau/embel"
    || env.RENDER_GIT_BRANCH !== "main" || !/^[a-f0-9]{40}$/u.test(options.sourceRevision)
    || env.RENDER_GIT_COMMIT !== options.sourceRevision || !/^srv-[a-z0-9]{10,64}$/u.test(env.RENDER_SERVICE_ID ?? "")
    || !/^[A-Za-z0-9_-]{1,200}$/u.test(env.RENDER_INSTANCE_ID ?? "")
    || env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined && env.NODE_TLS_REJECT_UNAUTHORIZED !== "1"
    || Object.keys(env).some(key => /^VERCEL(?:_|$)/u.test(key) && env[key] !== undefined)
    || Object.keys(env).some(key => /^PG/u.test(key) && env[key] !== undefined)
    || Object.entries(CLOUD_NAMING_RUNTIME).some(([key, value]) => versions[key as keyof typeof versions] !== value))
    throw new Error("cloud_naming_environment_unqualified");
  const naming = readNamingBrainConfiguration(env);
  if (!naming || naming.policy.model !== "gpt-6-luna" || env.FLUID_OPENAI_VERIFIED_MODELS !== "gpt-6-luna"
    || naming.deploymentId !== CLOUD_NAMING_DEPLOYMENT_ID) throw new Error("cloud_naming_configuration_invalid");
  if (options.mode === "run" && (env.EMBEL_NAMING_CLOUD_ACTIVATED !== "true" || !naming.paidDispatchEnabled))
    throw new Error("cloud_naming_activation_required");
  return { ...naming, poolOptions: databaseOptions(naming.databaseUrl, env.FLUID_NAMING_BRAIN_DATABASE_CA_PEM),
    sourceRevision: options.sourceRevision, serviceId: env.RENDER_SERVICE_ID!, instanceId: env.RENDER_INSTANCE_ID! };
}
