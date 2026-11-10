/** Routes that start paid AI work. The browser attaches BotID's challenge to calls to these
 * paths (instrumentation-client.ts), and each route handler calls `assertNotBot()` first.
 * `*` matches any project id. A test keeps this list and the route files in step. */
export const BOT_PROTECTED_ROUTES = [
  "/api/projects/*/generations",
  "/api/projects/*/naming/feed/ensure",
  "/api/projects/*/naming/steering",
  "/api/projects/*/logo/requests",
  "/api/projects/*/strategy",
  "/api/projects/*/identity/batches",
] as const;
