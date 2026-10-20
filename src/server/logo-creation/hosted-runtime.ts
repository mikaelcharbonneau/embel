import "server-only";
import { HOSTED_APPLICATION_ORIGIN } from "../runtime/hosted-application";

/** Routing opt-in for the existing account-bound image authority. The RPC's
 * historical `local` name is a compatibility identifier: ownership, exact
 * worker/policy bindings, leases and accounting are enforced in Postgres.
 * This flag grants no database or provider permission by itself. */
export function isHostedLogoRuntime(env: Record<string, string | undefined> = process.env): boolean {
  return env.FLUID_HOSTED_LOGO_ENABLED === "true" && env.NODE_ENV === "production" &&
    env.VERCEL === "1" && env.VERCEL_ENV === "production" &&
    (env.VERCEL_TARGET_ENV === undefined || env.VERCEL_TARGET_ENV === "production") &&
    env.VERCEL_PROJECT_ID === "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt" &&
    env.APP_ORIGIN === HOSTED_APPLICATION_ORIGIN &&
    env.FLUID_LOCAL_LOGO_ENABLED !== "true" && env.FLUID_LOCAL_PROTOTYPE !== "true" && env.FLUID_RUNTIME !== "local";
}
