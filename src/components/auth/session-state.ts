/** Sent by the app shell's session check. With it, a signed-out visitor gets an
 * ordinary `{ authenticated: false }` answer instead of a 401, so routine page
 * loads don't log a failed request. Callers that rely on 401 to expire a
 * session simply leave it out. */
export const SESSION_STATE_HEADER = "X-Embel-Session-State";
