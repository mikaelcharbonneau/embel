import { accountAdminClient } from "@/server/account/admin";
import { assertMaintenanceCaller, runAccountCleanup } from "@/server/account/maintenance";
import { errorResponse, privateJson } from "@/server/http/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Callable cleanup job (no schedule yet): finishes interrupted account
 * deletions and removes Storage files whose account or project is gone.
 * GET with "Authorization: Bearer <CRON_SECRET>", as Vercel Cron calls it. */
export async function GET(request: Request) {
  try {
    assertMaintenanceCaller(request);
    return privateJson(await runAccountCleanup(accountAdminClient()));
  } catch (error) { return errorResponse(error); }
}
