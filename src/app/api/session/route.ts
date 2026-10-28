import { getAuthenticatedContext } from "@/server/auth/context";
import { errorResponse, privateJson } from "@/server/http/errors";
import { isSharedWorkerRuntime } from "@/server/shared-account/routing";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { userId } = await getAuthenticatedContext();
    // Shared signup is a data-only Auth trigger, not a browser-driven service
    // provisioning loop or a claim that all integrations are currently ready.
    return privateJson({ user: { id: userId }, ...(process.env.EMBEL_ACCOUNT_ENROLLMENT_ENABLED === "true" && !isSharedWorkerRuntime() ? { enrollmentEnabled: true } : {}) });
  } catch (error) { return errorResponse(error); }
}
