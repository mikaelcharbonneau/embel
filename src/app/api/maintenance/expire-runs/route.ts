import { assertMaintenanceCaller } from "@/server/account/maintenance";
import { expireOverdueRuns } from "@/server/engine/sweep";
import { errorResponse, logServerError, privateJson } from "@/server/http/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Scheduled sweep (vercel.json, every 10 minutes): ends overdue generation runs of every
 * account and returns their credits. It never starts work and keeps running while generation
 * is paused. GET with "Authorization: Bearer <CRON_SECRET>", as Vercel Cron calls it; without
 * CRON_SECRET in the environment it answers 503 and does nothing. Answers counts only. */
export async function GET(request: Request) {
  try {
    assertMaintenanceCaller(request);
    const { ended, failed } = await expireOverdueRuns();
    if (ended > 0) console.info(JSON.stringify({ event: "overdue_runs_ended", ended }));
    if (failed > 0)
      logServerError("overdue_runs_not_ended", new Error("overdue_runs_not_ended"), { failed: String(failed) });
    return privateJson({ ended, failed });
  } catch (error) {
    return errorResponse(error);
  }
}
