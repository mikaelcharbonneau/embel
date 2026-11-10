import type { Instrumentation } from "next";
import { logServerError } from "./server/http/errors";

/** Errors Next.js captures outside the API routes' own handling, such as page rendering.
 * Only the route's file pattern is logged; the real path can carry codes or tokens. */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  const digest = typeof error === "object" && error !== null && "digest" in error ? String((error as { digest?: unknown }).digest).slice(0, 64) : undefined;
  logServerError("request_error", error, { routePath: context.routePath, routeType: context.routeType, method: request.method, digest });
};

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { sharedAccountHttpConfigured, startSharedAccountHttpServices } = await import("./server/shared-account/bootstrap");
    if (sharedAccountHttpConfigured(process.env)) {
      startSharedAccountHttpServices(process.env);
      return;
    }
    const { startAccountHttpBindingSource } = await import("./server/runtime/account-http-binding-source");
    startAccountHttpBindingSource(process.env);
    const { startAccountHttpServices } = await import("./server/runtime/account-http-services");
    if (process.env.EMBEL_ACCOUNT_HTTP_SOURCE_ENABLED !== "true") startAccountHttpServices(process.env);
    const { startLogoWebServices } = await import("./server/runtime/logo-web-bootstrap");
    startLogoWebServices(process.env);
  }
}
