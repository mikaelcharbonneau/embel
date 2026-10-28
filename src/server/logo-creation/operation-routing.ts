import "server-only";
import { ApiError } from "../http/errors";
import { HOSTED_APPLICATION_ORIGIN } from "../runtime/hosted-application";
import { isHostedLogoRuntime } from "./hosted-runtime";
import { isLocalLogoRuntime } from "./local-runtime";
import { isSharedWorkerRuntime } from "../shared-account/routing";

/** Explicit managed enrollment uses its fixed owner-derived operation RPC. SQL independently verifies enrollment, policy and live worker authority.
 * Legacy local/hosted wrapper routing is unchanged unless this flag is enabled.
 * Invalid managed configuration never falls back to another admission lane. */
export function logoOperationBoundary(env: Record<string, string | undefined> = process.env): "local_logo_operation" | "account_logo_operation" | "shared_logo_operation" | null {
  if (isSharedWorkerRuntime(env)) return "shared_logo_operation";
  if (env.EMBEL_MANAGED_LOGO_ENABLED !== "true") return isLocalLogoRuntime(env) || isHostedLogoRuntime(env) ? "local_logo_operation" : null;
  if (env.EMBEL_ACCOUNT_ENROLLMENT_ENABLED !== "true" || env.NODE_ENV !== "production" ||
    env.VERCEL !== "1" || env.VERCEL_ENV !== "production" ||
    env.VERCEL_TARGET_ENV !== undefined && env.VERCEL_TARGET_ENV !== "production" ||
    env.VERCEL_PROJECT_ID !== "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt" || env.APP_ORIGIN !== HOSTED_APPLICATION_ORIGIN ||
    env.FLUID_LOCAL_LOGO_ENABLED === "true" || env.FLUID_LOCAL_PROTOTYPE === "true" || env.FLUID_RUNTIME === "local" ||
    env.EMBEL_DEVELOPMENT_ENABLED === "true") throw new ApiError("integration_unavailable");
  return "account_logo_operation";
}
