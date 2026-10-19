import "server-only";

/** Explicit local logo opt-in; a linked project ID is not a hosted runtime. */
export function isLocalLogoRuntime(env: Record<string, string | undefined> = process.env): boolean {
  return env.FLUID_LOCAL_LOGO_ENABLED === "true" && env.FLUID_RUNTIME === "local" &&
    (env.NODE_ENV === "development" && env.APP_ORIGIN === "http://127.0.0.1:3105" ||
      env.NODE_ENV === "production" && env.APP_ORIGIN === "http://127.0.0.1:3106") &&
    !Object.keys(env).some(key => key !== "VERCEL_PROJECT_ID" && /^VERCEL(?:_|$)/u.test(key) && env[key] !== undefined);
}
