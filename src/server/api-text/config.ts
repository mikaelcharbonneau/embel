import "server-only";

/** Transport configuration only; signed workload identity, SQL and the worker
 * independently establish permission and runtime readiness. */
export function getApiTextPublicationOrigin(env: Record<string, string | undefined> = process.env): string | null {
  if (env.VERCEL_PROJECT_ID !== "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt") return null;
  if (env.FLUID_LOCAL_API_TEXT_ENABLED === "true") {
    // A local publisher uses a real development OIDC token. It must never
    // borrow hosted environment/deployment identifiers to pass configuration.
    if (env.NODE_ENV !== "development" || env.APP_ORIGIN !== "http://127.0.0.1:3105" ||
        env.VERCEL !== undefined || env.VERCEL_ENV !== undefined ||
        env.VERCEL_TARGET_ENV !== undefined || env.VERCEL_DEPLOYMENT_ID !== undefined) return null;
  } else if ((env.VERCEL_ENV !== "preview" && env.VERCEL_ENV !== "production") ||
      (env.VERCEL_TARGET_ENV && env.VERCEL_TARGET_ENV !== env.VERCEL_ENV)) return null;
  const origin = env.FLUID_API_TEXT_WORKER_ORIGIN ?? "";
  try {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== "https:" || !/^[a-z0-9-]+\.vercel\.app$/.test(url.hostname) ||
        url.port || url.username || url.password) return null;
    return origin;
  } catch { return null; }
}
