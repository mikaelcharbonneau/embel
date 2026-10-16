import "server-only";
import { getVercelOidcToken } from "@vercel/oidc";
import { getApiTextPublicationOrigin } from "./config";

/** Use the SDK's CLI-backed refresh only inside the explicit local boundary. */
export function getApiTextPublisherToken(): Promise<string> {
  if (!getApiTextPublicationOrigin()) throw new Error("Unconfigured publisher");
  if (process.env.FLUID_LOCAL_API_TEXT_ENABLED === "true") {
    return getVercelOidcToken({
      project: "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt",
      team: "team_0Koie5796IDOraQkDFg6J0AF",
      // Local tokens last 12h, but the worker accepts an age of at most 2h.
      // The supported buffer refreshes both SDK token sources and its disk
      // cache after 1h, leaving margin for the complete request deadline.
      expirationBufferMs: 11 * 60 * 60 * 1_000,
    });
  }
  // Hosted tokens must continue to come from the current request context.
  return getVercelOidcToken();
}
