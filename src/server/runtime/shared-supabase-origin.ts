import "server-only";
import { ApiError } from "@/server/http/errors";
import { getSupabaseConfiguration } from "@/server/config";
import { readDevelopmentConfiguration } from "@/server/development/config";

type Environment = Readonly<Record<string, string | undefined>>;
const unavailable = () => new ApiError("integration_unavailable");

/** Trusted composition only. Hosted targets match the server's selected public
 * project; local mode additionally requires the existing strict no-Vercel gate. */
export function qualifySharedSupabaseOrigin(origin: string, env: Environment = process.env): string {
  if (getSupabaseConfiguration(env).url !== origin) throw unavailable();
  if (/^https:\/\/[a-z0-9]{20}\.supabase\.co$/u.test(origin)) return origin;
  const development = readDevelopmentConfiguration(env);
  if (development?.supabaseUrl === "http://127.0.0.1:54321" && origin === development.supabaseUrl) return origin;
  throw unavailable();
}
