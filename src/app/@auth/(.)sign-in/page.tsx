import { SignInForm } from "@/components/auth/sign-in-form";
import { SignInDialog } from "@/components/auth/sign-in-dialog";
import { getSupabaseConfiguration } from "@/server/config";

export const dynamic = "force-dynamic";

export default function Page() {
  let configured = false;
  try { getSupabaseConfiguration(); configured = true; } catch { /* An unavailable integration never accepts credentials. */ }
  return <SignInDialog><SignInForm configured={configured} overlay /></SignInDialog>;
}
