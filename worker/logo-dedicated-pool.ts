import "server-only";
import { createRequire } from "node:module";
import type { PoolConfig } from "pg";
import type { LogoDedicatedPool } from "./logo-dedicated-launcher";

// pg explicitly exports its JS-client subpath. Importing its root instead can
// select pg-native from ambient NODE_PG_FORCE_NATIVE, losing the JS TLS options.
// Resolve pg's own declared pool dependency, and always provide its JS Client so
// pg-pool never takes its require('pg').Client fallback. No environment is read.
const require = createRequire(import.meta.url);
const JavaScriptClient = require("pg/lib/client.js") as typeof import("pg").Client;
const requireFromPg = createRequire(require.resolve("pg/package.json"));
const PgPool = requireFromPg("pg-pool") as typeof import("pg").Pool;

/** Trusted internal pool construction; options come only from the strict
 * certificate-checked adapter. Construction itself makes no connection. */
export function createLogoDedicatedPool(options: PoolConfig): LogoDedicatedPool {
  return new PgPool({ ...options, Client: JavaScriptClient });
}
