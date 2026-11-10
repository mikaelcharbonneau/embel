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
    <div className={nav ? "signed-out-actions signed-out-actions--nav" : "signed-out-actions"}>
      <Link className={nav ? "button small signed-out-sign-in" : "button primary"} href="/sign-in" onClick={keepPrompt}>
        Sign in
      </Link>
      <Link className={nav ? "button primary small" : "button secondary"} href="/sign-up" onClick={keepPrompt}>
        Create account
      </Link>
    </div>
  );
}
