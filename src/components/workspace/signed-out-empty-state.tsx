"use client";

import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { preparePromptForSignIn } from "./prompt-recovery";
import { useAccountSession } from "./account-session";

/** A page that needs an account, for a signed-out visitor: the page Empty state with Sign in and Create account.
 * While signing in or out, or when the session could not be checked, `fallback` (the shared account status) says
 * what is happening instead. */
export function SignedOutEmptyState({ title, text, fallback }: { title: string; text: string; fallback: ReactNode }) {
  const { session, signingIn, signingOut, signOutError } = useAccountSession();
  if (session.status !== "signed_out" || signingIn || signingOut || signOutError) return fallback;
  const keepPrompt = (event: React.MouseEvent) => {
    if (!preparePromptForSignIn()) event.preventDefault();
  };
  return (
    <EmptyState
      icon="lock"
      title={title}
      text={text}
      action={
        <div className="e-cluster">
          <ButtonLink variant="primary" href="/sign-in" onClick={keepPrompt}>
            Sign in
          </ButtonLink>
          <ButtonLink href="/sign-up" onClick={keepPrompt}>
            Create account
          </ButtonLink>
        </div>
      }
    />
  );
}
