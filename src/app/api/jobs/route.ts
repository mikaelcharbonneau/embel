import { getAuthenticatedContext } from "@/server/auth/context";
import { listJobActivity } from "@/server/data/job-activity";
import { errorResponse, privateJson } from "@/server/http/errors";

export const dynamic = "force-dynamic";

export async function GET() {
  try { return privateJson(await listJobActivity(await getAuthenticatedContext())); }
  catch (error) { return errorResponse(error); }
}
