import { z } from "zod";
import { getAuthenticatedContext } from "@/server/auth/context";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin } from "@/server/http/request";
import { throwDatabaseError } from "../../_shared";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ jobId: string }> };
async function getId(context: RouteContext) {
  const parsed = z.uuid().safeParse((await context.params).jobId);
  if (!parsed.success) throw new ApiError("not_found");
  return parsed.data;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { client, userId } = await getAuthenticatedContext();
    const id = await getId(context);
    const { data, error } = await client.from("jobs")
      .select("id,project_id,operation,input_revision,state,progress,reserved_cost_microusd,actual_cost_microusd,error_code,created_at,finished_at")
      .eq("id", id).eq("owner_id", userId).single();
    throwDatabaseError(error);
    if (!data) throw new ApiError("not_found");
    return privateJson({ job: data });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    assertMutationOrigin(request);
    const { client } = await getAuthenticatedContext();
    const id = await getId(context);
    const { data, error } = await client.rpc("request_job_cancel", { p_job_id: id });
    throwDatabaseError(error);
    // The row can still be cancel_requested while the worker resolves an in-flight result.
    if (!data) throw new ApiError("not_found");
    const { id: jobId, project_id, operation, input_revision, state, progress, reserved_cost_microusd, actual_cost_microusd, error_code, created_at, finished_at } = data;
    return privateJson({ job: { id: jobId, project_id, operation, input_revision, state, progress, reserved_cost_microusd, actual_cost_microusd, error_code, created_at, finished_at } });
  } catch (error) { return errorResponse(error); }
}
