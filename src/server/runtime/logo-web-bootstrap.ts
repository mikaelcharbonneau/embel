import "server-only";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool, type PoolConfig } from "pg";
import { ApiError } from "@/server/http/errors";
import { createPooledIdentityConnectionFactory, type IdentityPoolPort } from "./identity-pool";
import { configureLogoRequestServices } from "./logo-request-services";
import { readLogoWebConfiguration, type LogoWebEnvironment } from "./logo-web-configuration";
import { createLogoOwnerStorageTransport } from "./logo-owner-storage";
import { createSupabasePrivateAssetStorage } from "./private-asset-storage";

const BOOTSTRAP = Symbol.for("fluid.logo.web-bootstrap.v1");
const CA_HASH = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
type Status = "disabled" | "installed" | "unavailable";
type WebPool = IdentityPoolPort & { on(event: "error", listener: (error: Error) => void): unknown; end(): Promise<void> };
type Dependencies = { createPool(configuration: PoolConfig): WebPool; readCertificate(): string; fetch: typeof fetch; diagnostic(message: string): void };
const defaults: Dependencies = {
  createPool: configuration => new Pool(configuration),
  readCertificate: () => readFileSync(join(process.cwd(), "scripts/certs/supabase-prod-ca-2021.crt"), "utf8"),
  fetch: (...args) => globalThis.fetch(...args),
  diagnostic: message => console.warn(message),
};

/** Called by Node instrumentation. Pool construction is lazy and does not probe
 * the database. Only the immutable operator binding/pool lives in the resolver;
 * auth contexts, tokens, projects, storage and services are request-scoped. */
export function startLogoWebServices(env: LogoWebEnvironment, dependencies: Dependencies = defaults): Status {
  const existing = Reflect.get(globalThis, BOOTSTRAP) as { status: Status } | undefined;
  if (existing) return existing.status;
  const state: { status: Status } = { status: "unavailable" };
  Object.defineProperty(globalThis, BOOTSTRAP, { value: state, configurable: true });
  let pool: WebPool | undefined;
  const diagnostic = (message: string) => { try { dependencies.diagnostic(message); } catch {} };
  try {
    const configuration = readLogoWebConfiguration(env);
    if (!configuration) return state.status = "disabled";
    const ca = dependencies.readCertificate();
    if (createHash("sha256").update(ca).digest("hex") !== CA_HASH) throw new ApiError("integration_unavailable");
    const { database, ownerId, roleName, roleOid, publishableKey } = configuration;
    // Truthy explicit values prevent pg's PG* defaults from replacing access,
    // TLS, database options or encoding. The password callback avoids pgpass.
    const poolConfiguration: PoolConfig & { replication: "false"; binary: false } = {
      host: database.host, port: database.port, database: database.database, user: database.user, password: () => database.password,
      ssl: { ca, rejectUnauthorized: true, servername: database.host, minVersion: "TLSv1.2" }, sslnegotiation: "postgres",
      application_name: "fluid-logo-web", fallback_application_name: "fluid-logo-web", client_encoding: "UTF8", replication: "false", binary: false,
      options: "-c statement_timeout=15000 -c lock_timeout=1500 -c idle_in_transaction_session_timeout=5000",
      max: 3, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, statement_timeout: 15_000, query_timeout: 15_000,
      lock_timeout: 1500, idle_in_transaction_session_timeout: 5000, allowExitOnIdle: true,
    };
    pool = dependencies.createPool(poolConfiguration);
    pool.on("error", () => diagnostic("Logo HTTP database connection unavailable."));
    const connections = createPooledIdentityConnectionFactory([{ ownerId, roleName, roleOid, pool }]);
    configureLogoRequestServices(async (auth, projectId, signal) => {
      if (signal?.aborted) throw new ApiError("integration_unavailable");
      if (auth.userId.toLowerCase() !== ownerId) return null;
      const transport = await createLogoOwnerStorageTransport(auth, projectId, { publishableKey, fetch: dependencies.fetch }, signal);
      const storage = createSupabasePrivateAssetStorage({ scope: { kind: "identity", ownerId, projectId }, transport });
      return { ownerId, projectId, dependencies: { connections, storage } };
    });
    return state.status = "installed";
  } catch {
    if (pool) { try { void pool.end().catch(() => {}); } catch {} }
    diagnostic("Logo HTTP services unavailable: invalid configuration or dependency setup.");
    return state.status;
  }
}
