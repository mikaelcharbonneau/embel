import { SignInForm } from "@/components/auth/sign-in-form";
import { SignInDialog } from "@/components/auth/sign-in-dialog";
import { getSupabaseConfiguration } from "@/server/config";

export const dynamic = "force-dynamic";

export default function Page() {
  let configured = false;
  try {
    getSupabaseConfiguration();
    configured = true;
  } catch {
    /* Unavailable integrations never accept credentials. */
  }
  return (
    <SignInDialog mode="sign-up">
      <SignInForm configured={configured} mode="sign-up" overlay />
    </SignInDialog>
  );
}
