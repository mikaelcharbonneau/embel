import { enqueueNamingBatchSchema, NAMING_JOB_MUTATION_MAX_BYTES } from "@/domain/naming-jobs";
import { getAuthenticatedContext } from "@/server/auth/context";
import { enqueueNamingBatch, getNamingBatches, readNamingQuery } from "@/server/data/project-naming";
import { errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };
export async function GET(request: Request, context: RouteContext) {
  try { const auth = await getAuthenticatedContext(); return privateJson(await getNamingBatches(auth, (await context.params).projectId, readNamingQuery(request, "batches"))); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, context: RouteContext) {
  try { assertMutationOrigin(request); const auth = await getAuthenticatedContext(); const input = await readJson(request, enqueueNamingBatchSchema, NAMING_JOB_MUTATION_MAX_BYTES);
    return privateJson(await enqueueNamingBatch(auth, (await context.params).projectId, input), 202); }
  catch (error) { return errorResponse(error); }
}
