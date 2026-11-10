import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { getSupabaseConfiguration } from "@/server/config";

export const metadata: Metadata = { title: "Choose a new password", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Reached from the email link through /auth/callback, which signs the browser in for the reset. */
export default function ResetPasswordPage() {
  let configured = false;
  try { getSupabaseConfiguration(); configured = true; } catch { /* The form shows the unavailable state. */ }
  return <ResetPasswordForm configured={configured} />;
}
