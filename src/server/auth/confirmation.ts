import "server-only";
import type { Session, User } from "@supabase/supabase-js";

/** Only provider-issued, confirmed, non-anonymous sessions may reach the browser. */
export function isConfirmedAuthResult(data: { user: User | null; session: Session | null }): boolean {
  return Boolean(
    data.user &&
    data.session &&
    !data.user.is_anonymous &&
    data.user.email_confirmed_at &&
    data.session.user.id === data.user.id &&
    !data.session.user.is_anonymous &&
    data.session.user.email_confirmed_at,
  );
}

/** How long after opening a reset link a new password may be set without the old one. */
export const RECOVERY_WINDOW_SECONDS = 60 * 60;

/** True when the verified token says this session began from a password reset link within the window. */
export function isRecentRecovery(claims: unknown, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const amr = (claims as { amr?: unknown } | null | undefined)?.amr;
  if (!Array.isArray(amr)) return false;
  return amr.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    return (
      method === "recovery" &&
      typeof timestamp === "number" &&
      Number.isFinite(timestamp) &&
      nowSeconds - timestamp <= RECOVERY_WINDOW_SECONDS &&
      timestamp - nowSeconds <= 60
    );
  });
}

export function confirmationStatus(value: unknown): "complete" | "failed" | undefined {
  return value === "complete" || value === "failed" ? value : undefined;
}
