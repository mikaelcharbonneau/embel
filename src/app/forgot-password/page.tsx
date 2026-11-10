import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { getSupabaseConfiguration } from "@/server/config";

export const metadata: Metadata = { title: "Reset your password" };
export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  let configured = false;
  try {
    getSupabaseConfiguration();
    configured = true;
  } catch {
    /* The form shows the unavailable state. */
  }
  return <ForgotPasswordForm configured={configured} />;
}
