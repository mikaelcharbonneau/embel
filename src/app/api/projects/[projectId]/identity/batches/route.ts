import { IDENTITY_JOB_MUTATION_MAX_BYTES, identityBatchOverviewSchema, identityGenerationIntentSchema } from "@/domain/identity-jobs";
import { getAuthenticatedContext } from "@/server/auth/context";
import { enqueueIdentityBatch, getIdentityAvailability, getLatestIdentityBatch } from "@/server/data/identity-jobs";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function noQuery(request: Request) { if (new URL(request.url).search) throw new ApiError("invalid_input"); }
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext(); noQuery(request);
    const { projectId } = await context.params, availability = await getIdentityAvailability(auth, projectId);
    const latest = availability.status === "unavailable" && availability.reason === "pipeline_not_implemented" ? null : await getLatestIdentityBatch(auth, projectId);
    return privateJson(identityBatchOverviewSchema.parse({ ownerId: auth.userId, projectId: availability.projectId, availability, latest }));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    noQuery(request);
    const input = await readJson(request, identityGenerationIntentSchema, IDENTITY_JOB_MUTATION_MAX_BYTES);
    return privateJson(await enqueueIdentityBatch(auth, (await context.params).projectId, input), 201);
  } catch (error) { return errorResponse(error); }
}
