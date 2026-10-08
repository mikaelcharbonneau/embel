import { getAuthenticatedContext } from "@/server/auth/context";
import { errorResponse, privateJson } from "@/server/http/errors";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { userId } = await getAuthenticatedContext();
    return privateJson({ user: { id: userId } });
  } catch (error) { return errorResponse(error); }
}
