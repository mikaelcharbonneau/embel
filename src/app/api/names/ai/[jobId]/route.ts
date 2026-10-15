import { z } from "zod";
import { standaloneNamesRetentionSchema } from "@/domain/standalone-names";
import { getAuthenticatedContext } from "@/server/auth/context";
import { cancelStandaloneNames, getStandaloneNameJob, retainStandaloneName } from "@/server/data/standalone-names";
import { errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ jobId: string }> };
export async function GET(_request: Request, context: Context) {
  try { return privateJson(await getStandaloneNameJob(await getAuthenticatedContext(), (await context.params).jobId)); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, context: Context) {
  try { assertMutationOrigin(request); const auth = await getAuthenticatedContext(); await readJson(request, z.strictObject({ action: z.literal("cancel") }), 512);
    return privateJson(await cancelStandaloneNames(auth, (await context.params).jobId)); }
  catch (error) { return errorResponse(error); }
}
export async function PATCH(request: Request, context: Context) {
  try { assertMutationOrigin(request); const auth = await getAuthenticatedContext();
    return privateJson(await retainStandaloneName(auth, (await context.params).jobId, await readJson(request, standaloneNamesRetentionSchema, 1024))); }
  catch (error) { return errorResponse(error); }
}
