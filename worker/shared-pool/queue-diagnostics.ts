/** Closed, rate-limited classifications only. Never emit raw SDK/SQL errors,
 * messages, URLs, headers, tokens, job payloads or customer identifiers. */
export type SharedQueueFailurePhase = "db_list" | "descriptor" | "queue_send" | "db_ack" | "queue_receive";
export function classifySharedQueueFailure(error: unknown): string {
  if (!(error instanceof Error)) return "unclassified";
  if (/Failed to get OIDC token|OIDC token file|x-vercel-oidc-token/u.test(error.message)) return "oidc_unavailable";
  switch (error.constructor.name) {
    case "UnauthorizedError": return "queue_unauthorized";
    case "ForbiddenError": return "queue_forbidden";
    case "RateLimitError": return "queue_rate_limited";
    case "BadRequestError": return "queue_bad_request";
  }
  if (error.name === "AbortError" || error.name === "TimeoutError") return "request_interrupted";
  if ("code" in error && ["42501", "40001", "57014", "55000", "PT409"].includes(String(error.code))) return "database_guard_refused";
  return "unclassified";
}
const lastReport = new Map<string, number>();
export function reportSharedQueueFailure(phase: SharedQueueFailurePhase, error: unknown): void {
  const reason = classifySharedQueueFailure(error), key = `${phase}:${reason}`, now = Date.now();
  if (now - (lastReport.get(key) ?? -Infinity) < 60_000) return;
  lastReport.set(key, now);
  console.warn(JSON.stringify({ event: "shared_strategy_delivery_unavailable", phase, reason }));
}
