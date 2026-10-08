import type { Metadata } from "next";
import { SignInForm } from "@/components/auth/sign-in-form";
import { getSupabaseConfiguration } from "@/server/config";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default function SignInPage() {
  let configured = false;
  try { getSupabaseConfiguration(); configured = true; } catch { /* The form shows the unavailable state. */ }
  return <SignInForm configured={configured} />;
}
