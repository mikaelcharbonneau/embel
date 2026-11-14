"use client";

import Link from "next/link";
import { preparePromptForSignIn } from "@/components/workspace/prompt-recovery";

/** The two ways in for a signed-out visitor. In the navigation pill, Create
 * account leads; on a page that asks someone to sign in, Sign in leads. Both
 * keep an unsent Home prompt for after sign-in. */
export function SignedOutActions({ placement }: { placement: "nav" | "page" }) {
  const keepPrompt = (event: React.MouseEvent) => {
    if (!preparePromptForSignIn()) event.preventDefault();
  };
  const nav = placement === "nav";
  return (
    <div className={nav ? "app-nav" : "signed-out-actions"}>
      <Link
        className={nav ? "e-nav__item e-nav__item--keep-label" : "button primary"}
        href="/sign-in"
        onClick={keepPrompt}
      >
        {nav ? <span className="e-nav__label">Sign in</span> : "Sign in"}
      </Link>
      <Link
        className={nav ? "e-button e-button--primary e-button--sm e-nav__extra" : "button secondary"}
        href="/sign-up"
        onClick={keepPrompt}
      >
        Create account
      </Link>
    </div>
  );
}
