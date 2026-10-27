/** Explicit local development opt-in. Never broadens a hosted runtime's targets. */
export type DevelopmentConfiguration = Readonly<{ supabaseUrl: string; origin: string }>;

type Environment = Record<string, string | undefined>;

function loopbackOrigin(value: string | undefined): string | null {
  if (!value || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/?$/u.test(value)) return null;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      !Number.isInteger(port) || port < 1024 || port > 65535) return null;
    return url.origin;
  } catch { return null; }
}

/** Missing, hosted or ambiguous configuration fails closed without reading secrets. */
export function readDevelopmentConfiguration(env: Environment = process.env): DevelopmentConfiguration | null {
  if (env.EMBEL_DEVELOPMENT_ENABLED !== "true" || !["development", "test"].includes(env.NODE_ENV ?? "") ||
    Object.keys(env).some(key => /^VERCEL(?:_|$)/u.test(key) && env[key] !== undefined)) return null;
  const supabaseUrl = loopbackOrigin(env.NEXT_PUBLIC_SUPABASE_URL);
  const origin = loopbackOrigin(env.APP_ORIGIN);
  if (!supabaseUrl || !origin || supabaseUrl === origin) return null;
  return Object.freeze({ supabaseUrl, origin });
}
