import "server-only";
import { logoRequestStateSchema, type LogoRequestState } from "@/domain/logo-jobs";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { logoDatabaseError, logoId, logoOwner, parseLogoStored } from "./logo-transaction";

function scope(owner: string, project: string, value: { ownerId: string; projectId: string }) {
  if (value.ownerId !== owner || value.projectId !== project) throw new ApiError("not_found");
}

/** The saved outcome of one Logo request key: a save (brief, references, a choice) or an
 * earlier generation request. Reading never starts, repeats or reconciles any work. */
export async function readLogoRequest(
  auth: AuthenticatedContext,
  projectId: string,
  requestKey: string,
): Promise<LogoRequestState> {
  const owner = logoOwner(auth);
  projectId = logoId(projectId);
  requestKey = logoId(requestKey);
  let response: { data: unknown; error: unknown };
  try {
    response = await auth.client.rpc("read_logo_request", { p_project_id: projectId, p_request_key: requestKey });
  } catch (error) {
    throw logoDatabaseError(error);
  }
  if (response.error) throw logoDatabaseError(response.error);
  const state = parseLogoStored(logoRequestStateSchema, response.data);
  if (state.status !== "not_found") {
    if (state.requestKey !== requestKey) throw new ApiError("not_found");
    if (state.receipt) scope(owner, projectId, state.receipt);
    if (state.rejection) {
      scope(owner, projectId, state.rejection);
      if (state.rejection.requestKey !== requestKey || state.rejection.input.requestKey !== requestKey)
        throw new ApiError("not_found");
    }
    for (const output of state.outputs) scope(owner, projectId, output.reference);
  }
  return state;
}
