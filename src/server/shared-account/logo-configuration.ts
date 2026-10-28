import "server-only";
import { z } from "zod";
import { getSupabaseConfiguration } from "@/server/config";
import { ApiError } from "@/server/http/errors";
import { qualifySharedSupabaseOrigin, type SharedHttpPrincipal } from "./configuration";
type Environment = Readonly<Record<string, string | undefined>>;
const schema = z.strictObject({ roleName: z.string().regex(/^embel_shared_http_logo_[a-z0-9_]{1,35}$/u).max(63), roleOid: z.number().int().positive().max(4_294_967_295), databaseUrl: z.string().min(1).max(8192) });
export function readSharedLogoHttpConfiguration(env: Environment): { origin: string; publishableKey: string; principal: SharedHttpPrincipal } | null {
  if (env.EMBEL_SHARED_ACCOUNT_HTTP_ENABLED !== "true" && env.EMBEL_SHARED_WORKERS_ENABLED !== "true") return null;
  const raw = env.EMBEL_SHARED_LOGO_HTTP_CONFIG;
  if (raw === undefined) return null;
  try {
    if (!raw || Buffer.byteLength(raw) > 16_384) throw Error();
    const source = schema.parse(JSON.parse(raw)), { url: origin, publishableKey } = getSupabaseConfiguration(env);
    qualifySharedSupabaseOrigin(origin, env);
    if (!/^sb_publishable_[A-Za-z0-9_-]{1,500}$/u.test(publishableKey) || /[\s\x00-\x1f\x7f]/u.test(source.databaseUrl)) throw Error();
    const url = new URL(source.databaseUrl), local = origin === "http://127.0.0.1:54321", project = new URL(origin).hostname.split(".")[0], host = url.hostname;
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.pathname !== "/postgres" || url.hash || [...url.searchParams].length !== 1
      || (local ? host !== "127.0.0.1" || url.port !== "54322" || url.searchParams.get("sslmode") !== "disable"
        : url.port !== "5432" || (host !== `db.${project}.supabase.co` && !/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/u.test(host)) || url.searchParams.get("sslmode") !== "verify-full")) throw Error();
    const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
    if (user !== (local || host.startsWith("db.") ? source.roleName : `${source.roleName}.${project}`) || !password || password.length > 4096 || /[\x00-\x1f\x7f]/u.test(password)) throw Error();
    const principal = { roleName: source.roleName, roleOid: source.roleOid, host, port: local ? 54322 : 5432, tls: !local, user, password: "" };
    Object.defineProperty(principal, "password", { value: password, enumerable: false });
    return Object.freeze({ origin, publishableKey, principal: Object.freeze(principal) });
  } catch { throw new ApiError("integration_unavailable"); }
}
