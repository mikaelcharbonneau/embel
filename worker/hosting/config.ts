import type { PoolConfig } from "pg";
import { createHash } from "node:crypto";
import databaseCa from "../../scripts/certs/supabase-prod-ca-2021.crt?raw";

export function readWorkerIdentity(env: Record<string, string | undefined> = process.env): { deploymentId: string } {
  if (env.VERCEL_ENV !== "production" || (env.VERCEL_TARGET_ENV && env.VERCEL_TARGET_ENV !== "production") || env.VERCEL_PROJECT_ID !== "prj_waP1hoGVtBiqJCTqTWKHfRy8iLMk" || !/^dpl_[A-Za-z0-9_-]{1,196}$/.test(env.VERCEL_DEPLOYMENT_ID ?? "")) throw new Error("Unqualified worker environment");
  return { deploymentId: env.VERCEL_DEPLOYMENT_ID! };
}

function legacyWorkerConnection(connectionString: string): PoolConfig {
  let url: URL;
  let username: string;
  let password: string;
  try {
    url = new URL(connectionString);
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    // Parser errors may retain the secret input. Never forward them or their cause.
    throw new Error("Unapproved worker database");
  }
  const direct = url.hostname === "db.fricsfwqibyhemknqgyf.supabase.co" && username === "fluid_api_text_worker";
  const pooler = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname) && username === "fluid_api_text_worker.fricsfwqibyhemknqgyf";
  if (!["postgres:", "postgresql:"].includes(url.protocol) || (!direct && !pooler) || url.pathname !== "/postgres" || !url.password || url.hash) throw new Error("Unapproved worker database");
  // Legacy SSL query options never override our pinned, verified TLS settings.
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert", "ssl", "uselibpqcompat"]) url.searchParams.delete(key);
  if (url.search) throw new Error("Unsupported database option");
  return { host: url.hostname, port: Number(url.port || "5432"), database: "postgres", user: username, password };
}

export function workerPoolOptions(connectionString: string | undefined, password?: string): PoolConfig {
  if (connectionString !== undefined && password !== undefined) throw new Error("Ambiguous worker database configuration");
  if (!connectionString && !password) throw new Error("Worker database unavailable");
  // Pass the literal password directly to pg; never interpolate it into a URL.
  const connection: PoolConfig = password !== undefined
    ? { host: "aws-0-us-east-1.pooler.supabase.com", port: 5432, database: "postgres",
      user: "fluid_api_text_worker.fricsfwqibyhemknqgyf", password }
    : legacyWorkerConnection(connectionString!);
  if (createHash("sha256").update(databaseCa).digest("hex") !== "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7") throw new Error("Database trust anchor changed");
  return { ...connection, ssl: { rejectUnauthorized: true, ca: databaseCa }, max: 3,
    connectionTimeoutMillis: 3_000, statement_timeout: 3_000, query_timeout: 3_000,
    idleTimeoutMillis: 10_000, allowExitOnIdle: true, application_name: "fluid-api-text-worker" };
}
