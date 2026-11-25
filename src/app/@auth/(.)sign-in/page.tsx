import { SignInForm } from "@/components/auth/sign-in-form";
import { SignInDialog } from "@/components/auth/sign-in-dialog";
import { getSupabaseConfiguration } from "@/server/config";
import { getEnabledAuthProviders } from "@/server/auth/providers";
import { confirmationStatus } from "@/server/auth/confirmation";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  let configured = false;
  try {
    getSupabaseConfiguration();
    configured = true;
  } catch {
    /* An unavailable integration never accepts credentials. */
  }
  // Only providers really enabled are offered; if that can't be read, the email form stands alone.
  const providers = configured ? await getEnabledAuthProviders().catch(() => []) : [];
  const query = await searchParams;
  return (
    <SignInDialog>
      <SignInForm
        configured={configured}
        overlay
        confirmation={confirmationStatus(query.confirmation)}
        providers={providers}
        providerFailed={query.provider === "failed"}
      />
    </SignInDialog>
  );
}
