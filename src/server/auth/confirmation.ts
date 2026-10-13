import "server-only";
import type { Session, User } from "@supabase/supabase-js";

/** Only provider-issued, confirmed, non-anonymous sessions may reach the browser. */
export function isConfirmedAuthResult(data: { user: User | null; session: Session | null }): boolean {
  return Boolean(data.user && data.session && !data.user.is_anonymous && data.user.email_confirmed_at &&
    data.session.user.id === data.user.id && !data.session.user.is_anonymous && data.session.user.email_confirmed_at);
}

export function confirmationStatus(value: unknown): "complete" | "failed" | undefined {
  return value === "complete" || value === "failed" ? value : undefined;
}
