import "server-only";
import { checkBotId } from "botid/server";
import { ApiError, logServerError } from "./errors";

/** How long a route waits for BotID's verdict before letting the request through. */
export const BOT_CHECK_TIMEOUT_MS = 3000;

/**
 * Blocks requests that Vercel BotID classifies as automated (403 `bot_detected`) before they
 * can start paid AI work. Call it first in the handler of every route that starts a run.
 *
 * Fails open: if BotID is unreachable, errors, or is slower than the timeout, the request
 * continues (and the failure is logged), so a BotID outage cannot stop generation. The
 * database's credits, daily limits and cost cap still apply to every request.
 * Outside Vercel (local development, CI) there is no BotID service, so the check is skipped.
 */
export async function assertNotBot(): Promise<void> {
  if (process.env.VERCEL !== "1") return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let verdict: Awaited<ReturnType<typeof checkBotId>>;
  try {
    verdict = await Promise.race([
      checkBotId(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("botid_timeout")), BOT_CHECK_TIMEOUT_MS); }),
    ]);
  } catch (error) {
    logServerError("botid_check_failed", error);
    return;
  } finally { clearTimeout(timer); }
  if (verdict.isBot) throw new ApiError("bot_detected");
}
