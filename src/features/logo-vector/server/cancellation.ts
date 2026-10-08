import "server-only";
import type { AuthenticatedContext } from "../../../server/auth/context";
import { ApiError } from "../../../server/http/errors";
import { LogoUncertainCommitError, logoDatabaseError, logoId, logoOwner, parseLogoInput, parseLogoStored } from "../../../server/data/logo-transaction";
import { logoVectorCancellableCommandSchema, logoVectorEditRequestStateSchema, sameLogoVectorEditCommand, type LogoVectorEditRequestState } from "../model/cancellation";

function active(signal?: AbortSignal) { if (signal?.aborted) throw new ApiError("integration_unavailable"); }
async function rpc(auth: AuthenticatedContext, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  logoOwner(auth); active(signal);
  try {
    const pending = auth.client.rpc(name, args), response = await (signal ? pending.abortSignal(signal) : pending);
    active(signal); if (response.error) throw logoDatabaseError(response.error);
    return response.data;
  } catch (error) { throw logoDatabaseError(error); }
}
function scoped(auth: AuthenticatedContext, projectId: string, key: string, value: unknown): LogoVectorEditRequestState {
  const state = parseLogoStored(logoVectorEditRequestStateSchema, value);
  if (state.status !== "not_found" && (state.ownerId !== logoOwner(auth) || state.projectId !== projectId || state.requestKey !== key)) throw new ApiError("not_found");
  return state;
}
/** An explicit cancellation is an owner-authenticated immutable fence, never a
 * deletion, provider operation, retry or inference from an earlier HTTP error. */
export async function cancelLogoVectorEdit(auth: AuthenticatedContext, projectId: string, raw: unknown, signal?: AbortSignal): Promise<LogoVectorEditRequestState> {
  logoOwner(auth); projectId = logoId(projectId);
  const command = parseLogoInput(logoVectorCancellableCommandSchema, raw); active(signal);
  try {
    const state = scoped(auth, projectId, command.body.requestKey, await rpc(auth, "cancel_logo_vector_edit", { p_project_id: projectId, p_command: command }, signal));
    if (state.status === "not_found" || !sameLogoVectorEditCommand(state.command, command)) throw new ApiError("integration_unavailable");
    return state;
  } catch (error) {
    const mapped = logoDatabaseError(error);
    if (mapped.code === "integration_unavailable") throw new LogoUncertainCommitError(projectId, command);
    throw mapped;
  }
}
/** A bounded single-key read. not_found is never terminal cancellation proof. */
export async function readLogoVectorEditRequest(auth: AuthenticatedContext, projectId: string, requestKey: string, signal?: AbortSignal): Promise<LogoVectorEditRequestState> {
  logoOwner(auth); projectId = logoId(projectId); requestKey = logoId(requestKey);
  return scoped(auth, projectId, requestKey, await rpc(auth, "read_logo_vector_edit_request", { p_project_id: projectId, p_request_key: requestKey }, signal));
}
