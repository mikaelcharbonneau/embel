import "server-only";
import { createHash } from "node:crypto";
import type { PoolConfig } from "pg";
import { z } from "zod";
import { IMAGE_MODEL } from "../src/domain/providers";
import { SUNBURST_STANDARD_IMAGE_PRICING } from "../src/server/logo-creation/openai-image-pricing";

export const CLOUD_LOGO_RUNTIME = Object.freeze({ node: "22.22.2", icu: "78.2", unicode: "17.0", platform: "linux", arch: "x64" });
export const CLOUD_LOGO_DAEMON_NAME = "logo-worker";
export const CLOUD_LOGO_PROJECT_ID = "prj_QSWj13AkZzw4t8ZOGVzncFczz2gC";
// Existing durable job, principal and Storage identifiers are compatibility bindings.
export const CLOUD_LOGO_BINDING = Object.freeze({ ownerId: "6840f4c2-15a6-45a7-97be-41e7e5e37f42", roleName: "fluid_logo_worker", roleOid: 25288 });
export const CLOUD_LOGO_WORKER_ID = "embel-logo-local-20261018";
export const CLOUD_LOGO_STORAGE_USER_ID = "853fa383-9606-4577-924f-966194dc2f67";
export const CLOUD_LOGO_POLICY_IDENTITY = "175c12bb65f63fe8839b58323ba6e5bbe605d06062a9a708bfdd23efbb8515d5";
const PROJECT = "fricsfwqibyhemknqgyf", DIRECT_HOST = `db.${PROJECT}.supabase.co`, POOLER_HOST = "aws-0-us-east-1.pooler.supabase.com";
const CA_HASH = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
const secret = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
const capability = z.strictObject({ operation: z.literal("identity.logo_concept"), policyIdentity: z.literal(CLOUD_LOGO_POLICY_IDENTITY),
  handlerVersion: z.literal("logo-image-v1"), provider: z.literal("openai"), model: z.literal(IMAGE_MODEL), engine: z.null(), maxCostMicrousd: z.literal(2_000_000) });
const configurationSchema = z.strictObject({ version: z.literal(1), enabled: z.literal(true),
  binding: z.strictObject({ ownerId: z.literal(CLOUD_LOGO_BINDING.ownerId), roleName: z.literal(CLOUD_LOGO_BINDING.roleName), roleOid: z.literal(CLOUD_LOGO_BINDING.roleOid) }),
  workerId: z.literal(CLOUD_LOGO_WORKER_ID),
  database: z.strictObject({ host: z.enum([DIRECT_HOST, POOLER_HOST]), port: z.literal(5432), database: z.literal("postgres"), password: secret }),
  // Expiring snapshots and refresh tokens are deliberately absent. Every process
  // signs in the existing restricted identity and retains rotation only in memory.
  storage: z.strictObject({ authUserId: z.literal(CLOUD_LOGO_STORAGE_USER_ID), publishableKey: z.string().regex(/^sb_publishable_[A-Za-z0-9_-]{1,500}$/), sessionApproved: z.literal(true) }),
  image: z.strictObject({ apiKey: secret, model: z.literal(IMAGE_MODEL), rateVersion: z.literal(SUNBURST_STANDARD_IMAGE_PRICING.binding.rateVersion), paidCallsApproved: z.literal(true) }),
  operations: z.strictObject({ concepts: capability, refinements: capability.extend({ operation: z.literal("identity.logo_refine") }) }),
});
const identitySchema = z.strictObject({ version: z.literal(1), ownerId: z.literal(CLOUD_LOGO_BINDING.ownerId),
  authUserId: z.literal(CLOUD_LOGO_STORAGE_USER_ID), email: z.email().max(254), password: secret });

export type CloudLogoMode = "run" | "preflight" | "standby";
export type CloudLogoConfiguration = Readonly<{ status: "configured"; sourceRevision: string; projectId: string; vercelDeploymentId: string; activated: boolean }>;
type Values = { configuration: z.infer<typeof configurationSchema>; identity: z.infer<typeof identitySchema>; certificate: string; mode: CloudLogoMode };
const configurations = new WeakMap<CloudLogoConfiguration, Values>();
const unavailable = () => new Error("cloud_logo_configuration_invalid");

export function readCloudLogoMode(arguments_: readonly string[]): CloudLogoMode {
  if (arguments_.length === 0) return "run";
  if (arguments_.length === 1 && arguments_[0] === "--preflight") return "preflight";
  if (arguments_.length === 1 && arguments_[0] === "--standby") return "standby";
  throw new Error("cloud_logo_arguments_invalid");
}

/** Strict deployment qualification, never job authority. Supplied secrets stay
 * behind an opaque process-local handle; parser errors never escape. */
export function readCloudLogoConfiguration(options: { mode: CloudLogoMode; sourceRevision: string; expectedProjectId: string;
  env?: Record<string, string | undefined>; versions?: Pick<NodeJS.ProcessVersions, "node" | "icu" | "unicode">;
  platform?: string; arch?: string }): CloudLogoConfiguration {
  const env = options.env ?? process.env, versions = options.versions ?? process.versions;
  if (env.NODE_ENV !== "production" || env.FLUID_RUNTIME !== "cloud" || env.FLUID_LOCAL_PROTOTYPE !== "false"
    || env.VERCEL !== "1" || env.VERCEL_ENV !== "production" || env.VERCEL_TARGET_ENV !== "production"
    || env.VERCEL_REGION !== "iad1" || env.VERCEL_GIT_PROVIDER !== "github" || env.VERCEL_GIT_REPO_OWNER !== "mikaelcharbonneau"
    || env.VERCEL_GIT_REPO_SLUG !== "embel" || env.VERCEL_GIT_COMMIT_REF !== "main" || env.VERCEL_GIT_PULL_REQUEST_ID
    || !/^[a-f0-9]{40}$/u.test(options.sourceRevision) || env.VERCEL_GIT_COMMIT_SHA !== options.sourceRevision
    || options.expectedProjectId !== CLOUD_LOGO_PROJECT_ID || env.VERCEL_PROJECT_ID !== CLOUD_LOGO_PROJECT_ID
    || !/^dpl_[A-Za-z0-9]{10,100}$/u.test(env.VERCEL_DEPLOYMENT_ID ?? "")
    || env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined && env.NODE_TLS_REJECT_UNAUTHORIZED !== "1"
    || env.NODE_OPTIONS || env.NODE_PATH || env.NODE_PG_FORCE_NATIVE !== undefined
    || Object.keys(env).some(key => /^(?:PG|RENDER(?:_|$))/u.test(key) && env[key] !== undefined)
    || versions.node !== CLOUD_LOGO_RUNTIME.node || versions.icu !== CLOUD_LOGO_RUNTIME.icu || versions.unicode !== CLOUD_LOGO_RUNTIME.unicode
    || (options.platform ?? process.platform) !== CLOUD_LOGO_RUNTIME.platform || (options.arch ?? process.arch) !== CLOUD_LOGO_RUNTIME.arch)
    throw new Error("cloud_logo_environment_unqualified");
  if (!["run", "preflight", "standby"].includes(options.mode)) throw unavailable();
  if (options.mode === "run" && env.EMBEL_LOGO_CLOUD_ACTIVATED !== "true") throw new Error("cloud_logo_activation_required");
  try {
    const raw = env.EMBEL_LOGO_WORKER_CONFIGURATION_JSON, identity = env.EMBEL_LOGO_STORAGE_IDENTITY_JSON, certificate = env.EMBEL_LOGO_DATABASE_CA_PEM;
    if (!raw || raw.length > 32_768 || !identity || identity.length > 8192 || !certificate || createHash("sha256").update(certificate).digest("hex") !== CA_HASH) throw unavailable();
    const values = { configuration: configurationSchema.parse(JSON.parse(raw)), identity: identitySchema.parse(JSON.parse(identity)), certificate, mode: options.mode };
    const handle = Object.freeze({ status: "configured" as const, sourceRevision: options.sourceRevision,
      projectId: env.VERCEL_PROJECT_ID!, vercelDeploymentId: env.VERCEL_DEPLOYMENT_ID!, activated: env.EMBEL_LOGO_CLOUD_ACTIVATED === "true" });
    configurations.set(handle, values); return handle;
  } catch { throw unavailable(); }
}

/** Trusted internal seam. Never log or serialize the returned credential values. */
export function getCloudLogoConfiguration(configuration: CloudLogoConfiguration): Values | null { return configurations.get(configuration) ?? null; }

/** No URL parser, Mac certificate path, PG environment or native-client fallback. */
export function cloudLogoPoolOptions(configuration: CloudLogoConfiguration): PoolConfig {
  const value = getCloudLogoConfiguration(configuration); if (!value) throw unavailable();
  const database = value.configuration.database;
  return { host: database.host, port: 5432, database: "postgres", password: database.password,
    user: database.host === POOLER_HOST ? `${CLOUD_LOGO_BINDING.roleName}.${PROJECT}` : CLOUD_LOGO_BINDING.roleName,
    ssl: { ca: value.certificate, rejectUnauthorized: true, servername: database.host, minVersion: "TLSv1.2" }, sslnegotiation: "postgres",
    options: "-c row_security=on", client_encoding: "UTF8", max: 3, connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000, query_timeout: 15_000, idleTimeoutMillis: 10_000, application_name: "embel-logo-worker" };
}
