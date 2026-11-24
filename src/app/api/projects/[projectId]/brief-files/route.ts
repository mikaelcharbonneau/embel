import { getAuthenticatedContext } from "@/server/auth/context";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { z } from "zod";
import { BRIEF_FILE_MAX } from "@/domain/brief-files";
import { attachFilesToProject, projectBriefFileViews } from "@/server/engine/brief-files";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { assertOwnedProject } from "@/server/engine/strategy";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };

/** The files attached to this brand's first prompt, each with what Embel read in it (if read yet). */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const auth = await getAuthenticatedContext();
    const { projectId } = await context.params;
    await assertOwnedProject(auth, projectId);
    let files;
    try {
      files = await projectBriefFileViews(auth, projectId);
    } catch {
      throw new ApiError("integration_unavailable");
    }
    return privateJson({ files });
  } catch (error) {
    return errorResponse(error);
  }
}

const attachSchema = z.strictObject({ attachmentIds: z.array(z.uuid()).min(1).max(BRIEF_FILE_MAX) });

/** Adds files the person already uploaded to this brand (the side chat's attach button). It starts no
 * AI work: the browser then asks for the reading through /generations, which is bot-protected. */
export async function POST(request: Request, context: RouteContext) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    const { projectId } = await context.params;
    const body = await readJson(request, attachSchema, 4_096);
    await assertOwnedProject(auth, projectId);
    await attachFilesToProject(auth, projectId, body.attachmentIds);
    let files;
    try {
      files = await projectBriefFileViews(auth, projectId);
    } catch {
      throw new ApiError("integration_unavailable");
    }
    return privateJson({ files });
  } catch (error) {
    return errorResponse(error);
  }
}
