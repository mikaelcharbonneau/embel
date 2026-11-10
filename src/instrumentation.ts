import type { Instrumentation } from "next";
import { logServerError } from "./server/http/errors";

/** Errors Next.js captures outside the API routes' own handling, such as page rendering.
 * Only the route's file pattern is logged; the real path can carry codes or tokens. */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? String((error as { digest?: unknown }).digest).slice(0, 64)
      : undefined;
  logServerError("request_error", error, {
    routePath: context.routePath,
    routeType: context.routeType,
    method: request.method,
    digest,
  });
};

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startSharedAccountHttpServices } = await import("./server/shared-account/bootstrap");
    startSharedAccountHttpServices(process.env);
  }
}
