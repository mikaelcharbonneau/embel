import "server-only";
import { isDeepStrictEqual } from "node:util";
import { qualifiedLogoVectorProposalCapability } from "./logo-vector-proposal-capability";
import { logoVectorProposalConfigurationSchema } from "../src/features/logo-vector/server/proposal-policy";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { PoolConfig } from "pg";
import { decodeJwt } from "jose";
import { z } from "zod";
import { CAPPED_LOGO_IMAGE_MODEL } from "../src/domain/providers";
import { SUNBURST_STANDARD_IMAGE_PRICING } from "../src/server/ai/openai-image-pricing";
import { qualifiedLogoGenerativeStorageCapability } from "./logo-generative-storage-authorization";
import { qualifiedLogoProductionStorageCapability } from "./logo-production-storage-authorization";
import type { LogoWorkerCapability } from "./logo-readiness";

const PROJECT = "fricsfwqibyhemknqgyf", DIRECT_HOST = `db.${PROJECT}.supabase.co`, POOLER_HOST = "aws-0-us-east-1.pooler.supabase.com";
const CA_HASH = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
const unavailable = () => new Error("Logo dedicated configuration is unavailable.");
const uuid = z.uuid().transform(value => value.toLowerCase());
const secret = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
const schema = z.strictObject({
  version: z.literal(1), enabled: z.literal(true),
  binding: z.strictObject({ ownerId: uuid, roleName: z.string().max(63).regex(/^fluid_logo_worker(?:_[a-z0-9_]+)?$/), roleOid: z.number().int().min(1).max(4_294_967_295) }),
  workerId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  database: z.strictObject({ host: z.enum([DIRECT_HOST, POOLER_HOST]), port: z.literal(5432), database: z.literal("postgres"), password: secret }),
  storage: z.strictObject({ authUserId: uuid, publishableKey: z.string().regex(/^sb_publishable_[A-Za-z0-9_-]{1,500}$/),
    accessToken: z.string().max(16_384).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/), sessionApproved: z.literal(true) }).optional(),
  image: z.strictObject({ apiKey: secret, model: z.literal(CAPPED_LOGO_IMAGE_MODEL), rateVersion: z.literal(SUNBURST_STANDARD_IMAGE_PRICING.binding.rateVersion), paidCallsApproved: z.literal(true) }).optional(),
  vectorProposal: logoVectorProposalConfigurationSchema.extend({ apiKey: secret }).optional(),
  operations: z.strictObject({ proposals: z.unknown().optional(), concepts: z.unknown().optional(), refinements: z.unknown().optional(), vector: z.unknown().optional(), exports: z.unknown().optional() }),
});
type Lane = "proposals" | "concepts" | "refinements" | "vector" | "exports";
type Values = Readonly<Omit<z.infer<typeof schema>, "operations"> & { operations: Readonly<Partial<Record<Lane, LogoWorkerCapability>>> }>;
export type LogoDedicatedConfiguration = Readonly<{ status: "configured" }> | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "unavailable"; code: "invalid_configuration" | "unsafe_configuration_file" }>;
const configurations = new WeakMap<object, Values>();
const bad = (code: "invalid_configuration" | "unsafe_configuration_file" = "invalid_configuration"): LogoDedicatedConfiguration => Object.freeze({ status: "unavailable", code });
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** New schema only. No legacy env-file/parser migration, environment lookup,
 * session creation/refresh, credential write, connection or authorization I/O.
 * Public parse results are opaque: diagnostics never contain supplied values. */
export function parseLogoDedicatedConfiguration(input?: unknown): LogoDedicatedConfiguration {
  if (input === undefined) return Object.freeze({ status: "disabled" });
  try {
    if (z.strictObject({ version: z.literal(1), enabled: z.literal(false) }).safeParse(input).success) return Object.freeze({ status: "disabled" });
    const c = schema.parse(input), operations: Partial<Record<Lane, LogoWorkerCapability>> = {};
    if (c.storage) {
    if (c.binding.ownerId === c.storage.authUserId) throw unavailable();
    const claims = decodeJwt(c.storage.accessToken);
    if (claims.sub !== c.storage.authUserId || claims.role !== "authenticated" || claims.aud !== "authenticated"
      || claims.iss !== `https://${PROJECT}.supabase.co/auth/v1` || claims.is_anonymous !== false || !z.uuid().safeParse(claims.session_id).success
      || !Number.isSafeInteger(claims.exp) || claims.exp! * 1000 <= Date.now()
      || claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf * 1000 > Date.now())) throw unavailable();
    // Decoded claims only reject incompatible/expired input. Actual Auth and SQL
    // grant checks remain in the real brokers for each admitted leased job.
    }
    const expected = { proposals: "identity.logo_vector_propose", concepts: "identity.logo_concept", refinements: "identity.logo_refine", vector: "identity.logo_vectorize", exports: "identity.logo_export" } as const;
    for (const lane of Object.keys(expected) as Lane[]) {
      const raw = c.operations[lane]; if (raw === undefined) continue;
      const capability = lane === "proposals" ? qualifiedLogoVectorProposalCapability(raw) : lane === "concepts" || lane === "refinements" ? qualifiedLogoGenerativeStorageCapability(raw) : qualifiedLogoProductionStorageCapability(raw);
      if (!capability || capability.operation !== expected[lane]) throw unavailable();
      operations[lane] = capability;
    }
    if (!Object.keys(operations).length || Boolean(c.image) !== Boolean(operations.concepts || operations.refinements)) throw unavailable();
    if (Boolean(c.vectorProposal) !== Boolean(operations.proposals)
      || c.vectorProposal && !isDeepStrictEqual(c.vectorProposal.textPolicy, operations.proposals?.textPolicy)
      || Boolean(c.storage) !== Boolean(operations.concepts || operations.refinements || operations.vector || operations.exports)) throw unavailable();
    const handle = Object.freeze({ status: "configured" as const });
    configurations.set(handle, freeze({ ...c, operations })); return handle;
  } catch { return bad(); }
}

/** Internal trusted adapter seam. Never serialize or log the returned secrets. */
export function getLogoDedicatedConfiguration(configuration: LogoDedicatedConfiguration): Values | null {
  return configurations.get(configuration) ?? null;
}

/** Explicit absolute /approved-root/.local-fluid/logo-worker.json only. Missing
 * explicit files fail closed. Never searches cwd/home, reads env, creates a file
 * or follows configuration symlinks. POSIX owner/mode checks are mandatory. */
export async function readProtectedLogoDedicatedConfiguration(filename: string): Promise<LogoDedicatedConfiguration> {
  try { return parseLogoDedicatedConfiguration(await readProtectedLogoConfigurationFile(filename, "logo-worker.json")); }
  catch { return bad("unsafe_configuration_file"); }
}

/** Internal credential reader for explicit local startup. Never log its value. */
export async function readProtectedLogoConfigurationFile(filename: string, expectedName: "logo-worker.json" | "logo-storage-identity.json"): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const safe = (stat: Stats, mode: number) => !stat.isSymbolicLink() && (stat.mode & 0o7777) === mode
    && typeof process.getuid === "function" && stat.uid === process.getuid();
  try {
    if (typeof filename !== "string" || !isAbsolute(filename) || resolve(filename) !== filename || basename(filename) !== expectedName
      || basename(dirname(filename)) !== ".local-fluid") throw unavailable();
    const directory = dirname(filename), before = await lstat(directory);
    if (!before.isDirectory() || !safe(before, 0o700) || await realpath(directory) !== directory) throw unavailable();
    const file = await lstat(filename);
    if (!file.isFile() || !safe(file, 0o600) || file.nlink !== 1 || file.size < 1 || file.size > 65_536) throw unavailable();
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || !safe(opened, 0o600) || opened.nlink !== 1 || opened.ino !== file.ino || opened.dev !== file.dev) throw unavailable();
    const bytes = Buffer.alloc(65_537); let length = 0;
    while (length < bytes.length) {
      const part = await handle.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead;
    }
    const [after, afterFile, afterPath] = await Promise.all([lstat(directory), handle.stat(), lstat(filename)]);
    if (length > 65_536 || length !== opened.size || afterFile.size !== opened.size || afterFile.mtimeMs !== opened.mtimeMs || afterFile.ctimeMs !== opened.ctimeMs
      || !safe(afterFile, 0o600) || afterFile.nlink !== 1 || afterPath.ino !== opened.ino || afterPath.dev !== opened.dev || !safe(afterPath, 0o600)
      || !after.isDirectory() || !safe(after, 0o700) || after.ino !== before.ino || after.dev !== before.dev || await realpath(directory) !== directory) throw unavailable();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } catch { throw unavailable(); }
  finally { await handle?.close().catch(() => {}); }
}

/** Literal pg options prevent connection-string, PGOPTIONS and TLS-negotiation
 * fallbacks. The pinned certificate is a public source asset, never config. */
export function logoDedicatedPoolOptions(configuration: LogoDedicatedConfiguration, certificate: string): PoolConfig & { sslnegotiation: "postgres"; replication: "false" } {
  const c = getLogoDedicatedConfiguration(configuration);
  if (!c || typeof certificate !== "string" || createHash("sha256").update(certificate).digest("hex") !== CA_HASH) throw unavailable();
  return { host: c.database.host, port: 5432, database: "postgres", password: c.database.password,
    user: c.database.host === POOLER_HOST ? `${c.binding.roleName}.${PROJECT}` : c.binding.roleName,
    ssl: { rejectUnauthorized: true, ca: certificate }, sslnegotiation: "postgres", options: "-c row_security=on", client_encoding: "UTF8", replication: "false",
    max: 3, connectionTimeoutMillis: 10_000, statement_timeout: 15_000, query_timeout: 15_000, idleTimeoutMillis: 10_000,
    allowExitOnIdle: false, application_name: "fluid-logo-dedicated-worker" };
}
