import type { Metadata } from "next";
import { SignInForm } from "@/components/auth/sign-in-form";
import { getSupabaseConfiguration } from "@/server/config";
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
  return <SignInForm configured={configured} confirmation={confirmationStatus((await searchParams).confirmation)} />;
}
