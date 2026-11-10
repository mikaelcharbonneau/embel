import { getAuthenticatedContext } from "@/server/auth/context";
import { errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
import { getHomeAttachmentCapability } from "@/server/home-attachments";
export async function GET() {
  try {
    const auth = await getAuthenticatedContext();
    const policy = await getHomeAttachmentCapability(auth);
    return privateJson({
      ownerId: auth.userId.toLowerCase(),
      policy,
      reason: policy ? null : "Private input-file storage is not configured. Your typed prompt remains available.",
    });
  } catch (error) {
    return errorResponse(error);
  }
}
