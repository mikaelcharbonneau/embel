import "server-only";

/** Local transport configuration only; SQL and the worker own runtime readiness. */
export function getApiTextPublicationOrigin(env: Record<string, string | undefined> = process.env): string | null {
  if ((env.VERCEL_ENV !== "preview" && env.VERCEL_ENV !== "production") ||
      (env.VERCEL_TARGET_ENV && env.VERCEL_TARGET_ENV !== env.VERCEL_ENV) ||
      env.VERCEL_PROJECT_ID !== "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt") return null;
  const origin = env.FLUID_API_TEXT_WORKER_ORIGIN ?? "";
  try {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== "https:" || !/^[a-z0-9-]+\.vercel\.app$/.test(url.hostname) ||
        url.port || url.username || url.password) return null;
    return origin;
  } catch { return null; }
}
