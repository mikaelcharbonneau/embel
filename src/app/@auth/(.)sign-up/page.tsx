import { SignInForm } from "@/components/auth/sign-in-form";
import { SignInDialog } from "@/components/auth/sign-in-dialog";
import { getSupabaseConfiguration } from "@/server/config";
import { getEnabledAuthProviders } from "@/server/auth/providers";

export const dynamic = "force-dynamic";

export default async function Page() {
  let configured = false;
  try {
    getSupabaseConfiguration();
    configured = true;
  } catch {
    /* Unavailable integrations never accept credentials. */
  }
  // Only providers really enabled are offered; if that can't be read, the email form stands alone.
  const providers = configured ? await getEnabledAuthProviders().catch(() => []) : [];
  return (
    <SignInDialog mode="sign-up">
      <SignInForm configured={configured} mode="sign-up" overlay providers={providers} />
    </SignInDialog>
  );
}
