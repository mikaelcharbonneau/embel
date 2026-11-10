import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { SignInDialog } from "@/components/auth/sign-in-dialog";
import { getSupabaseConfiguration } from "@/server/config";

export const dynamic = "force-dynamic";

export default function Page() {
  let configured = false;
  try {
    getSupabaseConfiguration();
    configured = true;
  } catch {
    /* An unavailable integration never sends reset links. */
  }
  return (
    <SignInDialog>
      <ForgotPasswordForm configured={configured} overlay />
    </SignInDialog>
  );
}
