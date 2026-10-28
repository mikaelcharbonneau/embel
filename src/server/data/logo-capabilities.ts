import 'server-only';
import { logoCapabilitiesSchema, type LogoCapabilities } from '@/domain/logo-capabilities';
import type { AuthenticatedContext } from '@/server/auth/context';
import { ApiError } from '@/server/http/errors';
import { logoDatabaseError, logoId, logoOwner, parseLogoStored } from './logo-transaction';
import { logoOperationBoundary } from '../logo-creation/operation-routing';

const active = (signal?: AbortSignal) => { if (signal?.aborted) throw new ApiError('integration_unavailable'); };

/** One owned read using the existing authenticated client. No factory creation,
 * privileged connection, configuration lookup, cache, job or provider call. */
export async function readLogoCapabilities(auth: AuthenticatedContext, projectId: string, signal?: AbortSignal): Promise<LogoCapabilities> {
  const owner = logoOwner(auth);
  projectId = logoId(projectId);
  active(signal);
  let response: { data: unknown; error: unknown };
  try {
    const accountImageLane = logoOperationBoundary();
    const request = auth.client.rpc(accountImageLane ?? 'read_logo_capabilities', accountImageLane
      ? { p_project_id: projectId, p_kind: 'capabilities', p_input: null } : { p_project_id: projectId });
    response = await (signal ? request.abortSignal(signal) : request);
  } catch (error) { throw logoDatabaseError(error); }
  active(signal);
  if (response.error) throw logoDatabaseError(response.error);
  const value = parseLogoStored(logoCapabilitiesSchema, response.data);
  if (value.ownerId !== owner || value.projectId !== projectId) throw new ApiError('not_found');
  return value;
}
