import "server-only";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig } from "pg";
import JavaScriptClient from "pg/lib/client.js";
import JavaScriptPool from "pg-pool";
import { z } from "zod";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ApiError } from "@/server/http/errors";
import { createIdentityTransactionService } from "@/server/data/identity-transaction";
import { createHomeAttachmentService } from "@/server/home-attachments";
import { createPostgresHomeAttachmentBackend } from "@/server/home-attachments/postgres";
import { PROPOSED_HOME_ATTACHMENT_POLICY } from "@/domain/attachments";
import { createPooledIdentityConnectionFactory, type IdentityPoolPort } from "./identity-pool";
import { qualifyIdentityConnection } from "./identity-qualification";
import { qualifyHomeAttachmentConnection } from "./home-attachment-qualification";
import { createAccountHomeStorageTransport } from "./account-home-storage";
import { createSupabasePrivateAssetStorage } from "./private-asset-storage";
import { readAccountHttpConfiguration, type AccountHttpCapability, type AccountHttpConfiguration } from "./account-http-configuration";

type Environment = Readonly<Record<string, string | undefined>>;
type AccountPool = IdentityPoolPort & { on(event: "error", listener: (error: Error) => void): unknown; end(): Promise<void> };
export type AccountHttpRuntimeDependencies = { createPool(configuration: PoolConfig): AccountPool; readCertificate(): string; fetch: typeof fetch };
type Dependencies = AccountHttpRuntimeDependencies;
const certificateHash = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
const unavailable = () => new ApiError("integration_unavailable");
const defaults: Dependencies = {
  createPool: config => new JavaScriptPool({ ...config, Client: JavaScriptClient }),
  readCertificate: () => readFileSync(join(process.cwd(), "scripts/certs/supabase-prod-ca-2021.crt"), "utf8"),
  fetch: (...args) => globalThis.fetch(...args),
};

/** Source composition only: registry entries are supplied by a trusted operator.
 * Pools select actual per-owner restricted logins. No Auth context, project,
 * checked-out connection, token, Storage transport or readiness result is cached. */
export function createAccountHttpRuntime(env: Environment, dependencies: Dependencies = defaults) {
  const configuration = readAccountHttpConfiguration(env);
  if (!configuration) return null;
  return createAccountHttpRuntimeFromConfiguration(configuration, dependencies);
}

export function createAccountHttpRuntimeFromConfiguration(configuration: AccountHttpConfiguration, dependencies: Dependencies = defaults) {
  const ca = dependencies.readCertificate();
  if (createHash("sha256").update(ca).digest("hex") !== certificateHash) throw unavailable();
  const pools: AccountPool[] = [];
  let closed = false, closure: Promise<void> | undefined;
  try {
    const prepared = configuration.owners.map(owner => {
      const result: { ownerId: string; identity?: AccountHttpCapability & { pool: AccountPool };
        attachments?: AccountHttpCapability & { pool: AccountPool } } = { ownerId: owner.ownerId };
      for (const lane of ["identity", "attachments"] as const) {
        const capability = owner[lane]; if (!capability) continue;
        const { database, ownerId, roleName, roleOid } = capability;
        const poolConfiguration: PoolConfig & { replication: "false"; binary: false } = {
          host: database.host, port: database.port, database: database.database, user: database.user, password: () => database.password,
          ssl: { ca, rejectUnauthorized: true, servername: database.host, minVersion: "TLSv1.2" }, sslnegotiation: "postgres",
          replication: "false", binary: false, client_encoding: "UTF8",
          application_name: `embel-account-http-${lane}`, fallback_application_name: `embel-account-http-${lane}`,
          options: "-c row_security=on -c statement_timeout=15000 -c lock_timeout=1500 -c idle_in_transaction_session_timeout=5000",
          max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, allowExitOnIdle: true,
          statement_timeout: 15_000, query_timeout: 15_000, lock_timeout: 1500, idle_in_transaction_session_timeout: 5000,
        };
        const pool = dependencies.createPool(poolConfiguration); pools.push(pool);
        pool.on("error", () => { /* Credential-bearing driver errors are never emitted. */ });
        result[lane] = { ...capability, ownerId, roleName, roleOid, pool };
      }
      return result;
    });
    const owners = new Map(prepared.map(owner => [owner.ownerId, owner]));
    const identityFactory = createPooledIdentityConnectionFactory(prepared.flatMap(owner => owner.identity ? [owner.identity] : []), { acquireTimeoutMs: 5000 });
    const attachmentFactory = createPooledIdentityConnectionFactory(prepared.flatMap(owner => owner.attachments ? [owner.attachments] : []), { acquireTimeoutMs: 5000 });
    const transactions = createIdentityTransactionService(identityFactory);
    return {
      async resolveIdentity(verifiedOwnerId: string, signal?: AbortSignal) {
        const owner = z.uuid().safeParse(verifiedOwnerId);
        const binding = owner.success ? owners.get(owner.data.toLowerCase())?.identity : undefined;
        if (!binding || closed || signal?.aborted) return null;
        try {
          await qualifyIdentityConnection(identityFactory, binding.ownerId, binding.roleName, binding.roleOid, signal, binding.managed);
          if (closed || signal?.aborted) return null;
          return { transactions, saveAvailability: { status: "available" } as const };
        } catch { return null; }
      },
      async resolveHome(auth: AuthenticatedContext, signal?: AbortSignal) {
        const owner = z.uuid().safeParse(auth.userId);
        const binding = owner.success ? owners.get(owner.data.toLowerCase())?.attachments : undefined;
        if (!binding || closed || signal?.aborted) return null;
        try {
          await qualifyHomeAttachmentConnection(attachmentFactory, binding.ownerId, binding.roleName, binding.roleOid, signal, binding.managed);
          if (closed || signal?.aborted) return null;
          const transport = await createAccountHomeStorageTransport(auth, { publishableKey: configuration.publishableKey, fetch: dependencies.fetch }, signal);
          const storage = createSupabasePrivateAssetStorage({ scope: { kind: "home", ownerId: binding.ownerId }, transport });
          return createHomeAttachmentService({ backend: createPostgresHomeAttachmentBackend(attachmentFactory), storage, policy: PROPOSED_HOME_ATTACHMENT_POLICY });
        } catch { return null; }
      },
      close(): Promise<void> {
        closed = true;
        // pg-pool.end waits for existing checked-out clients to be released. It
        // does not cancel a tenant operation or terminate a database backend.
        return closure ??= Promise.all(pools.map(async pool => { await pool.end(); })).then(() => {}, () => { throw unavailable(); });
      },
    };
  } catch {
    for (const pool of pools) { try { void pool.end().catch(() => {}); } catch {} }
    throw unavailable();
  }
}

export type AccountHttpRuntime = NonNullable<ReturnType<typeof createAccountHttpRuntime>>;
export type AccountIdentityRuntime = NonNullable<Awaited<ReturnType<AccountHttpRuntime["resolveIdentity"]>>>;
export type AccountHomeAttachmentService = NonNullable<Awaited<ReturnType<AccountHttpRuntime["resolveHome"]>>>;
type Runtime = AccountHttpRuntime;
const runtimeSlot = Symbol.for("embel.account-http.runtime.v1");
const bootstrapSlot = Symbol.for("embel.account-http.bootstrap.v1");
type Status = "disabled" | "installed" | "unavailable";

/** Instrumentation calls once. Installing lazy pools is not a readiness claim. */
export function startAccountHttpServices(env: Environment, dependencies: Dependencies = defaults): Status {
  const existing = Reflect.get(globalThis, bootstrapSlot) as { status: Status } | undefined;
  if (existing) return existing.status;
  const state: { status: Status } = { status: "unavailable" };
  Object.defineProperty(globalThis, bootstrapSlot, { value: state, configurable: true });
  try {
    const runtime = createAccountHttpRuntime(env, dependencies);
    if (!runtime) return state.status = "disabled";
    if (Reflect.has(globalThis, runtimeSlot)) throw unavailable();
    Object.defineProperty(globalThis, runtimeSlot, { value: runtime, configurable: true });
    return state.status = "installed";
  } catch { return state.status; }
}

export async function resolveAccountIdentityRuntime(ownerId: string, signal?: AbortSignal) {
  const runtime = Reflect.get(globalThis, runtimeSlot) as Runtime | undefined;
  return await runtime?.resolveIdentity(ownerId, signal) ?? null;
}
export async function resolveAccountHomeAttachmentService(auth: AuthenticatedContext, signal?: AbortSignal) {
  const runtime = Reflect.get(globalThis, runtimeSlot) as Runtime | undefined;
  return await runtime?.resolveHome(auth, signal) ?? null;
}
