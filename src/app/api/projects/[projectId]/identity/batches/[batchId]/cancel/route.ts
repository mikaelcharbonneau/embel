import { z } from "zod";
import { getAuthenticatedContext } from "@/server/auth/context";
import { cancelIdentityBatch } from "@/server/data/identity-jobs";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ projectId: string; batchId: string }> }) {
  try {
    assertMutationOrigin(request); const auth = await getAuthenticatedContext();
    if (new URL(request.url).search) throw new ApiError("invalid_input");
    await readJson(request, z.strictObject({}), 256);
    const { projectId, batchId } = await context.params;
    return privateJson(await cancelIdentityBatch(auth, projectId, batchId));
  } catch (error) { return errorResponse(error); }
}
