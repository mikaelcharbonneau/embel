import { initBotId } from "botid/client/core";
import { BOT_PROTECTED_ROUTES } from "./domain/bot-protected-routes";

// Attaches Vercel BotID's invisible challenge to the calls that start paid AI work.
// Skipped automatically in local development. A failure here must never break the app.
try {
  initBotId({ protect: BOT_PROTECTED_ROUTES.map((path) => ({ path, method: "POST" })) });
} catch {
  /* The server check fails open too. */
}
