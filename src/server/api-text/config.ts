import "server-only";
import { HOSTED_APPLICATION_ORIGIN } from "../runtime/hosted-application";
import { readDevelopmentConfiguration } from "../development/config";

/** Both polling routes retain SQL-owned admission and independent worker readiness. */
export function isLocalPollingRuntime(env: Record<string, string | undefined> = process.env): boolean {
  return isLocalPrototypeRuntime(env) || readDevelopmentConfiguration(env) !== null;
}

/** The prototype keeps normal account persistence and SQL-owned readiness while
 * using the local polling worker instead of hosted Queue publication. */
export function isLocalPrototypeRuntime(env: Record<string, string | undefined> = process.env): boolean {
  return env.FLUID_LOCAL_PROTOTYPE === "true" && env.FLUID_RUNTIME === "local" &&
    env.NODE_ENV === "production" && env.APP_ORIGIN === "http://127.0.0.1:3106" &&
    // A CLI-linked project ID can exist in local .env files. It conveys no
    // hosted execution identity, unlike runtime, deployment and OIDC markers.
    !Object.keys(env).some(key => key !== "VERCEL_PROJECT_ID" && /^VERCEL(?:_|$)/u.test(key) && env[key] !== undefined);
}

/** Production routing opt-in only. The account grant, exact worker binding and
 * immutable execution authority are independently enforced by the database. */
export function isHostedNamingRuntime(env: Record<string, string | undefined> = process.env): boolean {
  return env.FLUID_HOSTED_NAMING_ENABLED === "true" && env.NODE_ENV === "production" &&
    env.VERCEL === "1" && env.VERCEL_ENV === "production" &&
    (env.VERCEL_TARGET_ENV === undefined || env.VERCEL_TARGET_ENV === "production") &&
    env.VERCEL_PROJECT_ID === "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt" &&
    env.APP_ORIGIN === HOSTED_APPLICATION_ORIGIN &&
    env.FLUID_LOCAL_PROTOTYPE !== "true" && env.FLUID_RUNTIME !== "local";
}

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
