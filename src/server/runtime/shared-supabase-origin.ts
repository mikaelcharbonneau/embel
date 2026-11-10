import "server-only";
import { ApiError } from "@/server/http/errors";
import { getSupabaseConfiguration } from "@/server/config";
import { readDevelopmentConfiguration } from "@/server/development/config";

/** The hosted Supabase project the shared lanes serve by default. */
export const LOGO_SUPABASE_ORIGIN = "https://fricsfwqibyhemknqgyf.supabase.co";
type Environment = Readonly<Record<string, string | undefined>>;
const unavailable = () => new ApiError("integration_unavailable");

/** Trusted composition only. Hosted targets match the server's selected public
 * project; local mode additionally requires the existing strict no-Vercel gate. */
export function qualifySharedSupabaseOrigin(origin: string, env: Environment = process.env): string {
  if (getSupabaseConfiguration(env).url !== origin) throw unavailable();
  if (/^https:\/\/[a-z0-9]{20}\.supabase\.co$/u.test(origin)) return origin;
  const development = readDevelopmentConfiguration(env);
  if (development && origin === development.supabaseUrl) return origin;
  throw unavailable();
}

/** Local HTTP principals connect only to the database port selected by the
 * development launcher. This setting never changes hosted connection rules. */
export function sharedDevelopmentDatabasePort(env: Environment): number {
  const development = readDevelopmentConfiguration(env);
  const raw = env.EMBEL_DEVELOPMENT_DATABASE_PORT ?? "54322";
  if (!development || !/^[1-9][0-9]{3,4}$/u.test(raw)) throw unavailable();
  const port = Number(raw);
  if (port < 1024 || port > 65535 ||
    [development.origin, development.supabaseUrl].some(origin => Number(new URL(origin).port) === port)) throw unavailable();
  return port;
}
