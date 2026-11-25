import type { Metadata } from "next";
import { SignInForm } from "@/components/auth/sign-in-form";
import { getSupabaseConfiguration } from "@/server/config";
import { getEnabledAuthProviders } from "@/server/auth/providers";
import { confirmationStatus } from "@/server/auth/confirmation";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  let configured = false;
  try {
    getSupabaseConfiguration();
    configured = true;
  } catch {
    /* The form shows the unavailable state. */
  }
  // Only providers really enabled are offered; if that can't be read, the email form stands alone.
  const providers = configured ? await getEnabledAuthProviders().catch(() => []) : [];
  const query = await searchParams;
  return (
    <SignInForm
      configured={configured}
      confirmation={confirmationStatus(query.confirmation)}
      providers={providers}
      providerFailed={query.provider === "failed"}
    />
  );
}
