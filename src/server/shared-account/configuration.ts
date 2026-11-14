import "server-only";
import { z } from "zod";
import { ApiError } from "@/server/http/errors";
import { getSupabaseConfiguration } from "@/server/config";
import { qualifySharedSupabaseOrigin, sharedDevelopmentDatabasePort } from "@/server/runtime/shared-supabase-origin";
export { qualifySharedSupabaseOrigin } from "@/server/runtime/shared-supabase-origin";

type Environment = Readonly<Record<string, string | undefined>>;
const principal = z.strictObject({
  roleName: z.string().regex(/^embel_shared_http_(?:identity|home)_[a-z0-9_]{1,30}$/u),
  roleOid: z.number().int().positive().max(4_294_967_295),
  databaseUrl: z.string().min(1).max(8192),
});
const schema = z.strictObject({ identity: principal.optional(), homeVerifier: principal.optional() });
export type SharedHttpPrincipal = Readonly<{
  roleName: string;
  roleOid: number;
  host: string;
  port: number;
  tls: boolean;
  user: string;
  password: string;
}>;
type SharedAccountHttpConfiguration = Readonly<{
  origin: string;
  publishableKey: string;
  identity?: SharedHttpPrincipal;
  homeVerifier?: SharedHttpPrincipal;
}>;
const unavailable = () => new ApiError("integration_unavailable");

/** Finite, server-only service credentials. No customer registry, role creation,
 * Vault, implicit PG credentials, target discovery or user-controlled selector. */
export function readSharedAccountHttpConfiguration(env: Environment): SharedAccountHttpConfiguration | null {
  if (env.EMBEL_SHARED_ACCOUNT_HTTP_ENABLED !== "true") return null;
  try {
    const { url: origin, publishableKey } = getSupabaseConfiguration(env);
    qualifySharedSupabaseOrigin(origin, env);
    const target = /^https:\/\/([a-z0-9]{20})\.supabase\.co$/u.exec(origin),
      local = target === null;
    const port = local ? sharedDevelopmentDatabasePort(env) : 5432;
    const raw = env.EMBEL_SHARED_ACCOUNT_HTTP_CONFIG;
    if (!/^sb_publishable_[A-Za-z0-9_-]{1,500}$/u.test(publishableKey) || !raw || Buffer.byteLength(raw) > 32_768)
      throw unavailable();
    const config = schema.parse(JSON.parse(raw));
    if (!config.identity && !config.homeVerifier) throw unavailable();
    const roles = new Set<string>(),
      oids = new Set<number>();
    function parse(
      value: z.infer<typeof principal> | undefined,
      lane: "identity" | "home",
    ): SharedHttpPrincipal | undefined {
      if (!value) return undefined;
      if (
        !value.roleName.startsWith(`embel_shared_http_${lane}_`) ||
        roles.has(value.roleName) ||
        oids.has(value.roleOid) ||
        /[\s\x00-\x1f\x7f]/u.test(value.databaseUrl)
      )
        throw unavailable();
      const url = new URL(value.databaseUrl),
        project = target?.[1],
        host = url.hostname;
      if (
        !["postgres:", "postgresql:"].includes(url.protocol) ||
        url.pathname !== "/postgres" ||
        url.hash ||
        [...url.searchParams].length !== 1 ||
        (local
          ? host !== "127.0.0.1" || url.port !== String(port) || url.searchParams.get("sslmode") !== "disable"
          : url.port !== "5432" ||
            (host !== `db.${project}.supabase.co` && !/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/u.test(host)) ||
            url.searchParams.get("sslmode") !== "verify-full")
      )
        throw unavailable();
      const user = decodeURIComponent(url.username),
        password = decodeURIComponent(url.password);
      if (
        user !== (local || host.startsWith("db.") ? value.roleName : `${value.roleName}.${project}`) ||
        !password ||
        password.length > 4096 ||
        /[\x00-\x1f\x7f]/u.test(password)
      )
        throw unavailable();
      roles.add(value.roleName);
      oids.add(value.roleOid);
      const parsed = { roleName: value.roleName, roleOid: value.roleOid, host, port, tls: !local, user, password: "" };
      Object.defineProperty(parsed, "password", { value: password, enumerable: false });
      return Object.freeze(parsed);
    }
    return Object.freeze({
      origin,
      publishableKey,
      identity: parse(config.identity, "identity"),
      homeVerifier: parse(config.homeVerifier, "home"),
    });
  } catch {
    throw unavailable();
  }
}
