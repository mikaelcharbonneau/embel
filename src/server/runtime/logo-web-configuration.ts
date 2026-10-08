import "server-only";
import { z } from "zod";
import { ApiError } from "@/server/http/errors";
import { getSupabaseConfiguration } from "@/server/config";

export const LOGO_SUPABASE_ORIGIN = "https://fricsfwqibyhemknqgyf.supabase.co";
const PROJECT_REF = "fricsfwqibyhemknqgyf";
const DIRECT_HOST = `db.${PROJECT_REF}.supabase.co`;
const SESSION_POOLER_HOST = "aws-0-us-east-1.pooler.supabase.com";
const keys = ["FLUID_LOGO_WEB_DATABASE_URL", "FLUID_LOGO_WEB_OWNER_ID", "FLUID_LOGO_WEB_ROLE_NAME", "FLUID_LOGO_WEB_ROLE_OID"] as const;
export type LogoWebEnvironment = Readonly<Record<string, string | undefined>>;
export type LogoWebConfiguration = Readonly<{
  ownerId: string; roleName: string; roleOid: number; publishableKey: string;
  database: Readonly<{ host: string; port: 5432; database: "postgres"; user: string; password: string }>;
}>;
const unavailable = () => new ApiError("integration_unavailable");

/** Only these dedicated inputs are accepted. No worker/PG fallback, dotenv or
 * credential-file discovery. Configuration is not evidence of hosted grants. */
export function readLogoWebConfiguration(env: LogoWebEnvironment): LogoWebConfiguration | null {
  if (keys.every(key => env[key] === undefined)) return null;
  try {
    if (keys.some(key => typeof env[key] !== "string" || !env[key])) throw unavailable();
    const ownerId = z.uuid().parse(env.FLUID_LOGO_WEB_OWNER_ID).toLowerCase();
    // A dedicated web-role namespace excludes administrator and worker reuse.
    const roleName = z.string().max(63).regex(/^fluid_logo_web(?:_[a-z0-9_]+)?$/).parse(env.FLUID_LOGO_WEB_ROLE_NAME);
    const oid = env.FLUID_LOGO_WEB_ROLE_OID!;
    if (!/^[1-9][0-9]{0,9}$/.test(oid)) throw unavailable();
    const roleOid = z.number().int().min(1).max(4_294_967_295).parse(Number(oid));
    const raw = env.FLUID_LOGO_WEB_DATABASE_URL!;
    if (raw.length > 8192 || /[\s\x00-\x1f\x7f]/.test(raw)) throw unavailable();
    const url = new URL(raw), parameters = [...url.searchParams];
    if (!["postgres:", "postgresql:"].includes(url.protocol) || ![DIRECT_HOST, SESSION_POOLER_HOST].includes(url.hostname)
      || url.port && url.port !== "5432" || url.pathname !== "/postgres" || url.hash || !url.username || !url.password
      || parameters.length !== 1 || parameters[0]![0] !== "sslmode" || parameters[0]![1] !== "verify-full") throw unavailable();
    const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
    if (user !== (url.hostname === SESSION_POOLER_HOST ? `${roleName}.${PROJECT_REF}` : roleName)
      || !password || password.length > 4096 || /[\x00-\x1f\x7f]/.test(user + password)) throw unavailable();
    const publicConfiguration = getSupabaseConfiguration(env);
    if (publicConfiguration.url !== LOGO_SUPABASE_ORIGIN || !/^sb_publishable_[A-Za-z0-9_-]{1,500}$/.test(publicConfiguration.publishableKey)) throw unavailable();
    const database = { host: url.hostname, port: 5432 as const, database: "postgres" as const, user, password };
    Object.defineProperty(database, "password", { value: password, enumerable: false });
    return Object.freeze({ ownerId, roleName, roleOid, publishableKey: publicConfiguration.publishableKey, database: Object.freeze(database) });
  } catch { throw unavailable(); }
}
