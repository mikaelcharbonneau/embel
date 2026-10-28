import type { PoolConfig } from "pg";
import { readDevelopmentConfiguration } from "../../src/server/development/config";

export type DevelopmentWorkerLane = "strategy" | "naming" | "logo";
export type DevelopmentWorkerMode = "preflight" | "run";
export type DevelopmentWorkerEnvironment = Record<string, string | undefined>;
export const DEVELOPMENT_WORKER_ROLES = Object.freeze({
  strategy: "embel_development_text_worker",
  naming: "embel_development_text_worker",
  logo: "embel_development_logo_worker",
});
export type DevelopmentWorkerConfiguration = Readonly<{
  lane: DevelopmentWorkerLane;
  ownerId: string;
  deploymentId: string;
  role: string;
  poolOptions: PoolConfig;
}>;

/** A separate entrypoint, never an override for the production-pinned launchers. */
export function readDevelopmentWorkerConfiguration(
  lane: DevelopmentWorkerLane,
  env: DevelopmentWorkerEnvironment = process.env,
): DevelopmentWorkerConfiguration | null {
  const development = readDevelopmentConfiguration(env);
  if (!development || !Object.hasOwn(DEVELOPMENT_WORKER_ROLES, lane)) return null;
  try {
    const ownerId = env.EMBEL_DEVELOPMENT_WORKER_OWNER_ID ?? "";
    const deploymentId = env.EMBEL_DEVELOPMENT_WORKER_DEPLOYMENT_ID ?? "";
    const raw = env.EMBEL_DEVELOPMENT_WORKER_DATABASE_URL ?? "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(ownerId)
      || !/^embel-dev-[A-Za-z0-9._:-]{1,170}$/u.test(deploymentId)
      || raw.length > 8192 || /[\s\x00-\x1f\x7f]/u.test(raw)
      || !/^postgres(?:ql)?:\/\/[^@/?#]+@127\.0\.0\.1:[1-9][0-9]{3,4}\/postgres$/u.test(raw)) return null;
    const url = new URL(raw), role = DEVELOPMENT_WORKER_ROLES[lane];
    const password = decodeURIComponent(url.password), port = Number(url.port);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1"
      || !/^\d+$/u.test(url.port) || port < 1024 || port > 65535
      || [new URL(development.supabaseUrl).port, new URL(development.origin).port].includes(url.port)
      || url.pathname !== "/postgres" || url.search || url.hash
      || decodeURIComponent(url.username) !== role || password.length > 4096 || /[\x00-\x1f\x7f]/u.test(password)) return null;
    return Object.freeze({ lane, role, ownerId: ownerId.toLowerCase(), deploymentId,
      // Explicit fields and the JS client prevent ambient PG*/native-client
      // fallbacks from substituting a remote target, options or credentials.
      poolOptions: Object.freeze({ host: "127.0.0.1", port, database: "postgres", user: role, password,
        ssl: false, options: "-c row_security=on", client_encoding: "UTF8", replication: "false",
        max: 2, connectionTimeoutMillis: 5_000, statement_timeout: 15_000,
        query_timeout: 15_000, idleTimeoutMillis: 10_000, application_name: `embel-development-${lane}` }),
    });
  } catch { return null; }
}

export function readDevelopmentWorkerArguments(args: readonly string[]): { lane: DevelopmentWorkerLane; mode: DevelopmentWorkerMode } {
  if (args.length !== 2 && args.length !== 3 || args[0] !== "--lane"
    || !["strategy", "naming", "logo"].includes(args[1] ?? "")
    || args.length === 3 && args[2] !== "--run") throw new Error("development_worker_arguments_invalid");
  return { lane: args[1] as DevelopmentWorkerLane, mode: args[2] === "--run" ? "run" : "preflight" };
}

export type DevelopmentWorkerExecution = Readonly<{ apiKey: string; model: string }>;
/** Explicit application credential only. Never inherit the agent's OPENAI_API_KEY. */
export function readDevelopmentWorkerExecution(
  lane: DevelopmentWorkerLane,
  env: DevelopmentWorkerEnvironment = process.env,
): DevelopmentWorkerExecution | null {
  if (lane === "logo" || env.EMBEL_DEVELOPMENT_DISPATCH_APPROVED !== "true" || env.FLUID_PAID_CALLS_APPROVED !== "true") return null;
  const apiKey = env.EMBEL_DEVELOPMENT_PROVIDER_API_KEY ?? "", model = env.EMBEL_DEVELOPMENT_MODEL ?? "";
  if (!/^\S{16,500}$/u.test(apiKey) || !/^[A-Za-z0-9._:-]{1,150}$/u.test(model)
    || !(env.EMBEL_DEVELOPMENT_VERIFIED_MODELS ?? "").split(",").map(value => value.trim()).includes(model)
    || lane === "strategy" && model !== "gpt-6-luna") return null;
  return Object.freeze({ apiKey, model });
}
