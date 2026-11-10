import { z } from "zod";
import { createRouteAuthClient } from "@/server/auth/client";
import { authFailure } from "@/server/auth/failure";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertMutationOrigin(request);
    await readJson(request, z.strictObject({}), 1024);
    const client = await createRouteAuthClient(request.signal);
    const { error } = await client.auth.signOut({ scope: "local" }).catch(() => {
      throw new ApiError("integration_unavailable");
    });
    if (error) throw authFailure(error);
    return privateJson({ authenticated: false });
  } catch (error) {
    return errorResponse(error);
  }
}
