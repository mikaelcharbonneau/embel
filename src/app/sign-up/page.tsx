import type { Metadata } from "next";
import { SignInForm } from "@/components/auth/sign-in-form";
import { getSupabaseConfiguration } from "@/server/config";
import { getEnabledAuthProviders } from "@/server/auth/providers";

export const metadata: Metadata = { title: "Create account" };
export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  let configured = false;
  try {
    getSupabaseConfiguration();
    configured = true;
  } catch {
    /* Unavailable integrations never accept credentials. */
  }
  // Only providers really enabled are offered; if that can't be read, the email form stands alone.
  const providers = configured ? await getEnabledAuthProviders().catch(() => []) : [];
  return <SignInForm configured={configured} mode="sign-up" providers={providers} />;
}
