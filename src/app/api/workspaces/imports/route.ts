import { z } from "zod";
import { getAuthenticatedContext } from "@/server/auth/context";
import { getStandaloneImport } from "@/server/data/standalone-workspaces";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const auth = await getAuthenticatedContext();
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => key !== "projectId") || params.getAll("projectId").length !== 1) throw new ApiError("invalid_input");
    const id = z.uuid().safeParse(params.get("projectId")); if (!id.success) throw new ApiError("invalid_input");
    return privateJson(await getStandaloneImport(auth, id.data));
  } catch (error) { return errorResponse(error); }
}
