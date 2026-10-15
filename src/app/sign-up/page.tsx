import type { Metadata } from "next";
import { SignInForm } from "@/components/auth/sign-in-form";
import { getSupabaseConfiguration } from "@/server/config";

export const metadata: Metadata = { title: "Create account" };
export const dynamic = "force-dynamic";

export default function SignUpPage() {
  let configured = false;
  try { getSupabaseConfiguration(); configured = true; } catch { /* Unavailable integrations never accept credentials. */ }
  return <SignInForm configured={configured} mode="sign-up" />;
}
