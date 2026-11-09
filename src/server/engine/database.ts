import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { attachDatabasePool } from "@vercel/functions";
import { Pool } from "pg";

/** The only database functions the engine login may call (docs/generation-engine.md). */
export type EngineFunction = "engine_claim" | "engine_check" | "engine_save_output" | "engine_finish";
const ENGINE_FUNCTIONS: readonly EngineFunction[] = ["engine_claim", "engine_check", "engine_save_output", "engine_finish"];

let pool: Pool | null = null;

function tlsFor(connectionString: string) {
  const host = new URL(connectionString).hostname;
  if (host === "127.0.0.1" || host === "localhost") return undefined;
  // Supabase's certificate authority, pinned in the repo and traced into every function.
  const ca = readFileSync(path.join(process.cwd(), "scripts/certs/supabase-prod-ca-2021.crt"), "utf8");
  return { ca, rejectUnauthorized: true };
}

/** One small pool per function instance, released by Vercel when the instance idles. */
export function engineDatabase(): Pool {
  if (pool) return pool;
  const connectionString = process.env.EMBEL_ENGINE_DATABASE_URL;
  if (!connectionString) throw new Error("engine_database_unconfigured");
  pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 10_000, ssl: tlsFor(connectionString) });
  attachDatabasePool(pool);
  return pool;
}

/** Calls one allowlisted engine function with positional arguments and returns its single result. */
export async function engineCall<T>(name: EngineFunction, args: readonly unknown[]): Promise<T> {
  if (!ENGINE_FUNCTIONS.includes(name)) throw new Error("engine_function_unknown");
  const placeholders = args.map((_, index) => `$${index + 1}`).join(", ");
  const { rows } = await engineDatabase().query(`select fluid_private.${name}(${placeholders}) as result`, [...args]);
  return rows[0]?.result as T;
}
