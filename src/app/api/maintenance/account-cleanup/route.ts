import { accountAdminClient } from "@/server/account/admin";
import { assertMaintenanceCaller, runAccountCleanup } from "@/server/account/maintenance";
import { errorResponse, logServerError, privateJson } from "@/server/http/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Scheduled cleanup (vercel.json, once a day): finishes interrupted account deletions, which
 * the person already confirmed, and removes Storage files whose account or project is gone.
 * GET with "Authorization: Bearer <CRON_SECRET>", as Vercel Cron calls it; without CRON_SECRET
 * in the environment it answers 503 and does nothing. Answers counts only. */
export async function GET(request: Request) {
  try {
    assertMaintenanceCaller(request);
    const result = await runAccountCleanup(accountAdminClient());
    if (result.resumedDeletions > 0 || result.orphanedFilesRemoved > 0)
      console.info(JSON.stringify({ event: "account_cleanup_done", ...result }));
    if (result.failedDeletions > 0)
      logServerError("account_cleanup_deletions_failed", new Error("account_cleanup_deletions_failed"), {
        failed: String(result.failedDeletions),
      });
    return privateJson(result);
  } catch (error) {
    return errorResponse(error);
  }
}
