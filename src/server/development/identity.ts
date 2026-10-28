import "server-only";
import { createHash } from "node:crypto";
import type { PoolConfig } from "pg";
import JavaScriptClient from "pg/lib/client.js";
import JavaScriptPool from "pg-pool";
import { z } from "zod";
import { readDevelopmentConfiguration } from "./config";
import { ApiError } from "@/server/http/errors";
import { createIdentityTransactionService } from "@/server/data/identity-transaction";
import { createPooledIdentityConnectionFactory, type IdentityPoolPort } from "@/server/runtime/identity-pool";
import { qualifyIdentityConnection } from "@/server/runtime/identity-qualification";

type Environment = Record<string, string | undefined>;
type DevelopmentPool = IdentityPoolPort & { on(event: "error", listener: (error: Error) => void): unknown };
type Dependencies = { createPool(configuration: PoolConfig): DevelopmentPool };
const unavailable = () => new ApiError("integration_unavailable");
const fields = ["DATABASE_URL", "OWNER_ID", "ROLE_NAME", "ROLE_OID"] as const;
const prefix = "EMBEL_DEVELOPMENT_IDENTITY_";
export function readDevelopmentIdentityConfiguration(env: Environment = process.env) {
  const development = readDevelopmentConfiguration(env);
  if (!development) return null;
  if (fields.every(field => !env[prefix + field])) return null;
  const ownerId = z.uuid().safeParse(env[prefix + "OWNER_ID"]);
  const roleName = env[prefix + "ROLE_NAME"] ?? "";
  const roleOid = env[prefix + "ROLE_OID"] ?? "";
  const rawUrl = env[prefix + "DATABASE_URL"];
  if (!ownerId.success || !/^embel_dev_identity_[a-z0-9_]{1,43}$/u.test(roleName) ||
    !/^[1-9][0-9]{0,9}$/u.test(roleOid) || Number(roleOid) > 4_294_967_295 || !rawUrl) throw unavailable();
  try {
    if (rawUrl.length > 8192 || /[\s\x00-\x1f\x7f]/u.test(rawUrl) ||
      !/^postgres(?:ql)?:\/\/[^@/?#]+@127\.0\.0\.1:[1-9][0-9]{3,4}\/postgres$/u.test(rawUrl)) throw unavailable();
    const url = new URL(rawUrl);
    const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
    const port = Number(url.port);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1" ||
      !Number.isInteger(port) || port < 1024 || port > 65535 || url.pathname !== "/postgres" ||
      [new URL(development.supabaseUrl).port, new URL(development.origin).port].includes(url.port) ||
      url.search || url.hash || user !== roleName || !password || password.length > 4096 || /[\x00-\x1f\x7f]/u.test(password)) throw unavailable();
    const database = { host: "127.0.0.1", port, database: "postgres", user, password: "" };
    Object.defineProperty(database, "password", { value: password, enumerable: false });
    return { ownerId: ownerId.data.toLowerCase(), roleName, roleOid: Number(roleOid), database };
  } catch { throw unavailable(); }
}

/** Constructs only a dedicated bounded pool. Qualification is request-time;
 * neither configuration presence nor a pool object advertises availability. */
function createLocalPool(configuration: PoolConfig): DevelopmentPool {
  // The pg entrypoint honors NODE_PG_FORCE_NATIVE at import time. Select the JS
  // driver and its pool explicitly so libpq cannot consult a second target or
  // credential source through ambient PG* settings.
  return new JavaScriptPool({ ...configuration, Client: JavaScriptClient });
}

export function createDevelopmentIdentityRuntime(env: Environment, dependencies: Dependencies = { createPool: createLocalPool }) {
  const configuration = readDevelopmentIdentityConfiguration(env);
  if (!configuration) return null;
  const { ownerId, roleName, roleOid, database } = configuration;
  const poolConfiguration: PoolConfig & { replication: "false"; binary: false } = {
    host: database.host, port: database.port, database: database.database, user: database.user,
    password: () => database.password, ssl: false,
    replication: "false", binary: false,
    application_name: "embel-development-identity", fallback_application_name: "embel-development-identity",
    client_encoding: "UTF8", options: "-c row_security=on -c statement_timeout=15000 -c lock_timeout=1500 -c idle_in_transaction_session_timeout=5000",
    max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, allowExitOnIdle: true,
    statement_timeout: 15_000, query_timeout: 15_000, lock_timeout: 1500, idle_in_transaction_session_timeout: 5000,
  };
  const pool = dependencies.createPool(poolConfiguration);
  pool.on("error", () => { /* Driver errors never expose local credentials. */ });
  const factory = createPooledIdentityConnectionFactory([{ ownerId, roleName, roleOid, pool }], { acquireTimeoutMs: 5000 });
  const transactions = createIdentityTransactionService(factory);
  return {
    async resolve(verifiedOwnerId: string, signal?: AbortSignal) {
      if (verifiedOwnerId.toLowerCase() !== ownerId || signal?.aborted) return null;
      try {
        await qualifyIdentityConnection(factory, ownerId, roleName, roleOid, signal);
        return { transactions, saveAvailability: { status: "available" } as const };
      } catch { return null; }
    },
  };
}

// Keep only the immutable configured pool in this process; never retain auth
// contexts, requests, projects, a checked-out connection or availability results.
const runtimeSlot = Symbol.for("embel.development.identity-runtime.v1");
export async function resolveDevelopmentIdentityRuntime(ownerId: string, signal?: AbortSignal) {
  try {
    const configuration = readDevelopmentIdentityConfiguration();
    if (!configuration) return null;
    const key = createHash("sha256").update(JSON.stringify(configuration)).update(configuration.database.password).digest("hex");
    let saved = Reflect.get(globalThis, runtimeSlot) as { key: string; runtime: ReturnType<typeof createDevelopmentIdentityRuntime> } | undefined;
    if (!saved) {
      saved = { key, runtime: createDevelopmentIdentityRuntime(process.env) };
      Object.defineProperty(globalThis, runtimeSlot, { value: saved, configurable: true });
    }
    // Changing a running process's principal requires a restart, not silently
    // reusing or replacing an existing owner's pool.
    if (saved.key !== key) return null;
    return await saved.runtime?.resolve(ownerId, signal) ?? null;
  } catch { return null; }
}
