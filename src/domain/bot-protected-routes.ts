/** Routes that start paid AI work, the one that starts a paid checkout, and the account forms a
 * script could hammer: guessing passwords, creating accounts in bulk, or sending confirmation
 * and reset emails. The browser attaches BotID's challenge to calls to these paths
 * (instrumentation-client.ts), and each route handler calls `assertNotBot()` first.
 * `*` matches any project id. A test keeps this list and the route files in step. */
export const BOT_PROTECTED_ROUTES = [
  "/api/projects/*/generations",
  "/api/projects/*/naming/feed/ensure",
  "/api/projects/*/naming/steering",
  "/api/projects/*/identity/batches",
  "/api/billing/checkout",
  "/api/auth/sign-in",
  "/api/auth/sign-up",
  "/api/auth/password-reset",
  "/api/auth/resend-confirmation",
] as const;
