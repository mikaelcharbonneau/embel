import { SignInForm } from "@/components/auth/sign-in-form";
import { SignInDialog } from "@/components/auth/sign-in-dialog";
import { getSupabaseConfiguration } from "@/server/config";
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
  return (
    <SignInDialog>
      <SignInForm
        configured={configured}
        overlay
        confirmation={confirmationStatus((await searchParams).confirmation)}
      />
    </SignInDialog>
  );
}
