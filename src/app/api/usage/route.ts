import { getAuthenticatedContext } from "@/server/auth/context";
import { listRecordedUsage } from "@/server/data/recorded-usage";
import { errorResponse, privateJson } from "@/server/http/errors";

export const dynamic = "force-dynamic";

export async function GET() {
  try { return privateJson(await listRecordedUsage(await getAuthenticatedContext())); }
  catch (error) { return errorResponse(error); }
}
