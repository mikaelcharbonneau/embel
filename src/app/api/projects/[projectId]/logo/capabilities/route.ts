import { getAuthenticatedContext } from '@/server/auth/context';
import { readLogoCapabilities } from '@/server/data/logo-capabilities';
import { ApiError, privateJson } from '@/server/http/errors';
import { logoErrorResponse } from '@/server/http/logo-errors';

export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    if (new URL(request.url).searchParams.size) throw new ApiError('invalid_input');
    const { projectId } = await context.params;
    return privateJson(await readLogoCapabilities(auth, projectId, request.signal));
  } catch (error) { return logoErrorResponse(error); }
}
