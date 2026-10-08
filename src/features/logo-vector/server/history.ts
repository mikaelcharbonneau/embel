import "server-only";
import type { AuthenticatedContext } from "../../../server/auth/context";
import { ApiError } from "../../../server/http/errors";
import { logoDatabaseError, logoId, logoOwner, parseLogoInput, parseLogoStored } from "../../../server/data/logo-transaction";
import { logoVectorHistoryPageSchema, logoVectorHistoryQuerySchema, type LogoVectorHistoryPage, type LogoVectorHistoryQuery } from "../model/history";

const active = (signal?: AbortSignal): void => { if (signal?.aborted) throw new ApiError("integration_unavailable"); };

/** Fixed authenticated read only. The RPC derives ownership from auth.uid(),
 * binds cursor scope and checks its workspace revision in one DB snapshot. */
export async function listLogoVectorHistory(auth: AuthenticatedContext, projectId: string, query: LogoVectorHistoryQuery = {}, signal?: AbortSignal): Promise<LogoVectorHistoryPage> {
  const ownerId = logoOwner(auth); projectId = logoId(projectId);
  const input = parseLogoInput(logoVectorHistoryQuerySchema, query); active(signal);
  let response: { data: unknown; error: unknown };
  try {
    const request = auth.client.rpc("list_logo_vector_history", { p_project_id: projectId, p_query: input });
    response = await (signal ? request.abortSignal(signal) : request);
  } catch (cause) { throw logoDatabaseError(cause); }
  active(signal);
  if (response.error) throw logoDatabaseError(response.error);
  const page = parseLogoStored(logoVectorHistoryPageSchema, response.data);
  if (page.ownerId !== ownerId || page.projectId !== projectId) throw new ApiError("not_found");
  if (page.items.length > input.limit) throw new ApiError("integration_unavailable");
  return page;
}
