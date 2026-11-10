import "server-only";
import { createHash } from "node:crypto";
import { constants, readFileSync, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { Pool, type PoolConfig } from "pg";
import { z } from "zod";
import { CAPPED_LOGO_IMAGE_MODEL } from "../src/domain/providers";
import { createIdentityAssetStore, createPostgresIdentityAssetBackend, type IdentityAssetReservation,
  type IdentityAssetStore } from "../src/server/data/identity-asset-store";
import type { LogoWorkerConnection } from "../src/server/data/logo-jobs";
import { createPooledIdentityConnectionFactory, type IdentityPoolPort } from "../src/server/runtime/identity-pool";
import { LOGO_IMAGE_HANDLER_VERSION } from "../src/server/ai/logo-image-prompts";
import { SUNBURST_STANDARD_IMAGE_PRICING } from "../src/server/ai/openai-image-pricing";
import type { OpenAIImageTransport } from "../src/server/ai/openai-image-transport";
import { createLogoWorkerRuntime } from "./logo-runtime";
import { createLogoImageRuntimeAdapter } from "./logo-image-runtime-adapter";
import { createLogoStorageAuthorization, type LogoStorageDependencies } from "./logo-storage-authorization";

const PROJECT = "fricsfwqibyhemknqgyf", DIRECT_HOST = `db.${PROJECT}.supabase.co`, POOLER_HOST = "aws-0-us-east-1.pooler.supabase.com";
const CA_HASH = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
const names = Object.freeze(["FLUID_LOGO_WORKER_DATABASE_URL", "FLUID_LOGO_WORKER_OWNER_ID", "FLUID_LOGO_WORKER_ROLE_NAME", "FLUID_LOGO_WORKER_ROLE_OID",
  "FLUID_LOGO_WORKER_ID", "FLUID_LOGO_OPENAI_API_KEY", "FLUID_LOGO_CONCEPT_POLICY_IDENTITY", "FLUID_LOGO_CONCEPT_MAX_COST_MICROUSD",
  "FLUID_LOGO_IMAGE_MODEL", "FLUID_LOGO_IMAGE_PRICE_VERSION", "FLUID_LOGO_PAID_CALLS_APPROVED",
  "FLUID_LOGO_STORAGE_AUTH_USER_ID", "FLUID_LOGO_SUPABASE_URL", "FLUID_LOGO_SUPABASE_PUBLISHABLE_KEY",
  "FLUID_LOGO_STORAGE_ACCESS_TOKEN", "FLUID_LOGO_STORAGE_SESSION_APPROVED"] as const);
type Field = typeof names[number];
type Configured = Readonly<{ status: "configured"; names: readonly Field[] }>;
export type LogoConceptConfiguration = Configured | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "unavailable"; code: "invalid_configuration" | "unsafe_configuration_file"; fields: readonly Field[] }>;
type Values = { ownerId: string; roleName: string; roleOid: number; workerId: string; apiKey: string; policyIdentity: string; maxCostMicrousd: number;
  database: { host: string; user: string; password: string };
  storage: { authUserId: string; publishableKey: string; accessToken: string | undefined; sessionApproved: boolean } };
// Values never appear on the public parse result, even with inspect(showHidden).
const configurations = new WeakMap<Configured, Values>();
const bad = (fields: readonly Field[] = []): LogoConceptConfiguration => Object.freeze({ status: "unavailable", code: "invalid_configuration", fields: Object.freeze([...fields]) });
const unavailable = () => new Error("Logo concept dependencies are unavailable.");

/** Pure parser for the dedicated protected file, not process.env or HTTP input.
 * Reports fixed field names only; no raw values, parser errors or URLs escape. */
export function parseLogoConceptConfiguration(input: unknown): LogoConceptConfiguration {
  if (input === undefined) return Object.freeze({ status: "disabled" });
  if (!input || typeof input !== "object" || Array.isArray(input)) return bad();
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some(key => !names.includes(key as Field))) return bad();
  const invalid = new Set<Field>();
  function field<T>(name: Field, parse: (value: string) => T): T | undefined {
    try { const value = raw[name]; if (typeof value !== "string" || !value || value !== value.trim()) throw unavailable(); return parse(value); }
    catch { invalid.add(name); return undefined; }
  }
  const ownerId = field("FLUID_LOGO_WORKER_OWNER_ID", value => z.uuid().parse(value).toLowerCase());
  const roleName = field("FLUID_LOGO_WORKER_ROLE_NAME", value => z.string().max(63).regex(/^fluid_logo_worker(?:_[a-z0-9_]+)?$/).parse(value));
  const integer = (value: string, max: number) => { if (!/^[1-9][0-9]*$/.test(value)) throw unavailable(); return z.number().int().min(1).max(max).parse(Number(value)); };
  const roleOid = field("FLUID_LOGO_WORKER_ROLE_OID", value => integer(value, 4_294_967_295));
  const workerId = field("FLUID_LOGO_WORKER_ID", value => z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/).parse(value));
  const apiKey = field("FLUID_LOGO_OPENAI_API_KEY", value => z.string().max(4096).regex(/^[\x21-\x7e]+$/).parse(value));
  const policyIdentity = field("FLUID_LOGO_CONCEPT_POLICY_IDENTITY", value => z.string().regex(/^[a-f0-9]{64}$/).parse(value));
  const maxCostMicrousd = field("FLUID_LOGO_CONCEPT_MAX_COST_MICROUSD", value => integer(value, Number.MAX_SAFE_INTEGER));
  field("FLUID_LOGO_IMAGE_MODEL", value => z.literal(CAPPED_LOGO_IMAGE_MODEL).parse(value));
  field("FLUID_LOGO_IMAGE_PRICE_VERSION", value => z.literal(SUNBURST_STANDARD_IMAGE_PRICING.binding.rateVersion).parse(value));
  field("FLUID_LOGO_PAID_CALLS_APPROVED", value => z.literal("true").parse(value));
  const authUserId = field("FLUID_LOGO_STORAGE_AUTH_USER_ID", value => z.uuid().parse(value).toLowerCase());
  if (authUserId && authUserId === ownerId) invalid.add("FLUID_LOGO_STORAGE_AUTH_USER_ID");
  field("FLUID_LOGO_SUPABASE_URL", value => z.literal(`https://${PROJECT}.supabase.co`).parse(value));
  const publishableKey = field("FLUID_LOGO_SUPABASE_PUBLISHABLE_KEY", value => z.string().regex(/^sb_publishable_[A-Za-z0-9_-]{1,500}$/).parse(value));
  const accessToken = raw.FLUID_LOGO_STORAGE_ACCESS_TOKEN === undefined ? undefined
    : field("FLUID_LOGO_STORAGE_ACCESS_TOKEN", value => z.string().max(16_384).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/).parse(value));
  const sessionApproved = raw.FLUID_LOGO_STORAGE_SESSION_APPROVED === undefined ? false
    : field("FLUID_LOGO_STORAGE_SESSION_APPROVED", value => z.enum(["true", "false"]).parse(value) === "true");
  const database = field("FLUID_LOGO_WORKER_DATABASE_URL", value => {
    if (value.length > 8192 || /[\s\x00-\x1f\x7f]/.test(value)) throw unavailable();
    const url = new URL(value), parameters = [...url.searchParams];
    if (!["postgres:", "postgresql:"].includes(url.protocol) || ![DIRECT_HOST, POOLER_HOST].includes(url.hostname)
      || url.port && url.port !== "5432" || url.pathname !== "/postgres" || url.hash || !url.username || !url.password
      || parameters.length !== 1 || parameters[0]![0] !== "sslmode" || parameters[0]![1] !== "verify-full") throw unavailable();
    const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
    if (!roleName || user !== (url.hostname === POOLER_HOST ? `${roleName}.${PROJECT}` : roleName)
      || !password || password.length > 4096 || /[\x00-\x1f\x7f]/.test(user + password)) throw unavailable();
    return { host: url.hostname, user, password };
  });
  if (invalid.size || !ownerId || !roleName || !roleOid || !workerId || !apiKey || !policyIdentity || !maxCostMicrousd || !database || !authUserId || !publishableKey) return bad([...invalid]);
  const token: Configured = Object.freeze({ status: "configured", names });
  configurations.set(token, { ownerId, roleName, roleOid, workerId, apiKey, policyIdentity, maxCostMicrousd, database,
    storage: { authUserId, publishableKey, accessToken, sessionApproved: sessionApproved === true } });
  return token;
}

/** Proposed destination only. No file is created, migrated or discovered in
 * legacy worker/Next config; credential setup remains separately authorized. */
export async function readProtectedLogoConceptConfiguration(root: string): Promise<LogoConceptConfiguration> {
  const safe = (stat: Stats, mode: number) => !stat.isSymbolicLink() && (stat.mode & 0o7777) === mode
    && typeof process.getuid === "function" && stat.uid === process.getuid();
  const directory = join(root, ".local-fluid"), filename = join(directory, "logo-concept-worker.json");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(directory);
    if (!before.isDirectory() || !safe(before, 0o700)) throw unavailable();
    const file = await lstat(filename);
    if (!file.isFile() || !safe(file, 0o600) || file.nlink !== 1 || file.size > 65_536) throw unavailable();
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat(), after = await lstat(directory);
    if (!opened.isFile() || !safe(opened, 0o600) || opened.nlink !== 1 || opened.ino !== file.ino || opened.dev !== file.dev
      || !after.isDirectory() || !safe(after, 0o700) || after.ino !== before.ino || after.dev !== before.dev) throw unavailable();
    const bytes = Buffer.alloc(65_537), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65_536) throw unavailable();
    return parseLogoConceptConfiguration(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead))));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return Object.freeze({ status: "disabled" });
    return Object.freeze({ status: "unavailable", code: "unsafe_configuration_file", fields: Object.freeze([]) });
  } finally { await handle?.close().catch(() => {}); }
}

/** A future reviewed background capability must authorize exactly this leased,
 * immutable reservation. It must not reuse an owner session or service-role key.
 * Authorization grants neither overwrite, listing, deletion nor another path. */
export interface LogoConceptStorageAuthorization {
  assertAvailable(scope: Readonly<{ ownerId: string; operation: "identity.logo_concept" }>): Promise<void>;
  authorize(scope: Readonly<{ ownerId: string; projectId: string; jobId: string; leaseToken: string; reservation: Readonly<IdentityAssetReservation> }>, signal?: AbortSignal): Promise<{
    putIfAbsent(bytes: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<void>;
    read(signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }>;
  }>;
}
type LogoPool = IdentityPoolPort & { on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown; end(): Promise<void> };
export type LogoConceptStartupDependencies = { createPool(configuration: PoolConfig): LogoPool; readCertificate(): string; imageTransport?: OpenAIImageTransport; storageTransport?: LogoStorageDependencies };
const defaults: LogoConceptStartupDependencies = { createPool: configuration => new Pool(configuration),
  readCertificate: () => readFileSync(new URL("../scripts/certs/supabase-prod-ca-2021.crt", import.meta.url), "utf8") };
type Runtime = ReturnType<typeof createLogoWorkerRuntime>;
export type LogoConceptStartup = { status: "ready"; runtime: Runtime; close(): Promise<void> }
  | { status: "disabled" | "unavailable"; reason: "configuration" | "background_storage" | "dependency_validation"; close(): Promise<void> };

function referenceFreeAssets(connection: LogoWorkerConnection, authorization: LogoConceptStorageAuthorization): IdentityAssetStore {
  const backend = createPostgresIdentityAssetBackend({ owned: null, worker: connection });
  const denied = async (): Promise<never> => { throw unavailable(); };
  return {
    stageOwnedAsset: denied, publishOwnedUpload: denied, readOwnedAsset: denied, readLeasedAsset: denied,
    async publishLeasedAsset(job, publication, bytes, signal) {
      if (job.operation !== "identity.logo_concept" || publication.source.kind !== "concept") throw unavailable();
      let reserved: IdentityAssetReservation | undefined, transport: Awaited<ReturnType<LogoConceptStorageAuthorization["authorize"]>> | undefined;
      const authorized = async (path: string) => {
        if (!reserved || path !== reserved.storagePath || signal?.aborted) throw unavailable();
        return transport ??= await authorization.authorize(Object.freeze({ ownerId: job.ownerId, projectId: job.projectId, jobId: job.id,
          leaseToken: job.leaseToken, reservation: Object.freeze({ ...reserved, reference: Object.freeze({ ...reserved.reference }) }) }), signal);
      };
      // Each publication owns its reservation/transport. No shared mutable path
      // mapping or token can cross jobs; the existing store verifies read-back.
      const store = createIdentityAssetStore({ backend: { ...backend, async prepare(access, write, currentSignal) {
        return reserved = await backend.prepare(access, write, currentSignal);
      } }, storage: {
        async putIfAbsent(path, value, mimeType, currentSignal) { await (await authorized(path)).putIfAbsent(value, mimeType, currentSignal); },
        async read(path, currentSignal) { return (await authorized(path)).read(currentSignal); },
      } });
      return store.publishLeasedAsset(job, publication, bytes, signal);
    },
  };
}

/** Constructs and validates actual concept dependencies, but does not advertise,
 * claim, listen or dispatch. Host owns ticks; close drains them before pool.end.
 * Missing background authentication stays unavailable rather than a fixture. */
export async function startLogoConceptWorker(options: { configuration: LogoConceptConfiguration; storage?: LogoConceptStorageAuthorization | null },
  dependencies: LogoConceptStartupDependencies = defaults): Promise<LogoConceptStartup> {
  const absent = (status: "disabled" | "unavailable", reason: "configuration" | "background_storage" | "dependency_validation"): LogoConceptStartup =>
    ({ status, reason, async close() {} });
  if (options.configuration.status !== "configured") return absent(options.configuration.status === "disabled" ? "disabled" : "unavailable", "configuration");
  const configuration = configurations.get(options.configuration);
  if (!configuration) return absent("unavailable", "configuration");
  // Only this protected-file token supplies a CLI session. No environment,
  // owner session, legacy worker credential or refresh path is consulted.
  // The marker is an operator gate, never evidence of actual user consent.
  const managedStorage = options.storage === undefined && configuration.storage.sessionApproved && configuration.storage.accessToken
    ? createLogoStorageAuthorization({ ownerId: configuration.ownerId, authUserId: configuration.storage.authUserId,
      workerRoleName: configuration.roleName, workerRoleOid: configuration.roleOid, workerId: configuration.workerId,
      publishableKey: configuration.storage.publishableKey, accessToken: configuration.storage.accessToken }, dependencies.storageTransport)
    : null;
  const storage = options.storage === undefined ? managedStorage : options.storage;
  if (!storage || typeof storage.assertAvailable !== "function" || typeof storage.authorize !== "function") return absent("unavailable", "background_storage");
  const { ownerId, roleName, roleOid, database } = configuration;
  let pool: LogoPool | undefined, runtime: Runtime | undefined, stopped = false, closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const stop = () => { stopped = true; void runtime?.close(); };
  async function close() {
    if (closing) return closing;
    stop();
    return closing = (async () => {
      try { await runtime?.close(); await Promise.allSettled([...pending]); }
      finally {
        // Preserve already-dispatched publication/evidence until the drain;
        // then cancel all remaining Auth/Storage requests and capabilities.
        managedStorage?.close();
        try { await pool?.end(); } catch { /* Never expose connection or driver errors. */ }
        finally { pool?.removeListener("error", stop); }
      }
    })();
  }
  try {
    await storage.assertAvailable({ ownerId, operation: "identity.logo_concept" });
    const ca = dependencies.readCertificate();
    if (createHash("sha256").update(ca).digest("hex") !== CA_HASH) throw unavailable();
    const poolConfiguration: PoolConfig & { replication: "false"; binary: false } = {
      host: database.host, port: 5432, database: "postgres", user: database.user, password: () => database.password,
      ssl: { ca, rejectUnauthorized: true, servername: database.host, minVersion: "TLSv1.2" }, sslnegotiation: "postgres",
      application_name: "fluid-logo-concept-worker", fallback_application_name: "fluid-logo-concept-worker", client_encoding: "UTF8", replication: "false", binary: false,
      options: "-c statement_timeout=15000 -c lock_timeout=1500 -c idle_in_transaction_session_timeout=5000",
      max: 3, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, statement_timeout: 15_000, query_timeout: 15_000,
      lock_timeout: 1500, idle_in_transaction_session_timeout: 5000, allowExitOnIdle: true,
    };
    pool = dependencies.createPool(poolConfiguration); pool.on("error", stop);
    const factory = createPooledIdentityConnectionFactory([{ ownerId, roleName, roleOid, pool }]);
    const connection: LogoWorkerConnection = { async query<Row>(sql: string, parameters: unknown[] = []) {
      const acquired = await factory.acquire(ownerId); let discard = false, principalValidated = false;
      try {
        const result = await acquired.connection.query("SELECT session_user::text AS role_name, current_user::text AS active_role, pg_catalog.to_regrole(session_user)::oid::bigint AS role_oid, fluid_private.logo_worker_owner()::text AS owner_id");
        const principal = z.strictObject({ role_name: z.literal(roleName), active_role: z.literal(roleName), role_oid: z.coerce.number().int().refine(value => value === roleOid), owner_id: z.literal(ownerId) });
        if (result.rows.length !== 1 || !principal.safeParse(result.rows[0]).success) throw unavailable();
        principalValidated = true;
        return sql ? await acquired.connection.query(sql, parameters) as { rows: Row[] } : { rows: [] };
      } catch (error) {
        discard = true;
        // Preserve the runner's sole durable-plan control signal, never raw
        // driver details, credential-bearing messages or arbitrary SQL errors.
        if (principalValidated && sql === "select public.register_logo_job_plan($1,$2,$3)" && error instanceof Error && error.message === "plan_conflict")
          throw new Error("plan_conflict");
        throw unavailable();
      }
      finally { await acquired.connection.release(discard); }
    } };
    await connection.query(""); if (stopped) throw unavailable();
    const adapter = createLogoImageRuntimeAdapter({ ownerId, connection,
      capability: { operation: "identity.logo_concept", policyIdentity: configuration.policyIdentity, handlerVersion: LOGO_IMAGE_HANDLER_VERSION,
        provider: "openai", model: CAPPED_LOGO_IMAGE_MODEL, engine: null, maxCostMicrousd: configuration.maxCostMicrousd },
      image: { apiKey: configuration.apiKey, model: CAPPED_LOGO_IMAGE_MODEL, rateVersion: SUNBURST_STANDARD_IMAGE_PRICING.binding.rateVersion, paidCallsApproved: true },
      references: "none", acceptingWork: () => !stopped, assets: referenceFreeAssets(connection, storage), transport: dependencies.imageTransport,
      async assertAvailable() { if (stopped) throw unavailable(); await storage.assertAvailable({ ownerId, operation: "identity.logo_concept" }); if (stopped) throw unavailable(); },
    });
    if (!adapter?.concepts) throw unavailable();
    const concepts = adapter.concepts;
    const engine = createLogoWorkerRuntime({ connection, workerId: configuration.workerId, manifest: [adapter.capability],
      composition: { concepts: { ...concepts, async resolveInputs(job) { if (stopped) throw unavailable(); return concepts.resolveInputs(job); } }, refinements: null, vector: null, directions: null, exports: null, unavailableReasons: {} },
    });
    function track<T>(promise: Promise<T>): Promise<T> { pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise; }
    runtime = Object.freeze({ ...engine, tick: (signal?: AbortSignal) => track(engine.tick(signal)), refreshReadiness: () => track(engine.refreshReadiness()) });
    return { status: "ready", runtime, close };
  } catch { await close(); return absent("unavailable", "dependency_validation"); }
}
