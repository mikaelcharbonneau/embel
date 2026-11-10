import { getAuthenticatedContext } from "@/server/auth/context";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { SESSION_STATE_HEADER } from "@/components/auth/session-state";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { userId } = await getAuthenticatedContext();
    return privateJson({ user: { id: userId } });
  } catch (error) {
    // The app shell only asks whether someone is signed in. It opts in to an
    // ordinary signed-out answer, so a visitor's page load doesn't log a failed
    // request. Every other caller keeps the 401 it uses to expire a session.
    if (
      request.headers.get(SESSION_STATE_HEADER) === "1" &&
      error instanceof ApiError &&
      error.code === "unauthenticated"
    ) {
      return privateJson({ authenticated: false });
    }
    return errorResponse(error);
  }
}
