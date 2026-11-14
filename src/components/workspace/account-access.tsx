"use client";

import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useState, type ReactNode } from "react";
import { useAccountSession } from "./account-session";
import { preparePromptForSignIn } from "./prompt-recovery";
import "@/styles/auth.css";

/** Signing out, with the confirmation shown when unsaved account edits would be lost. Render `dialog`
 * outside any menu: a closed menu is hidden, and the confirmation must stay visible. */
export function useSignOutFlow(): { start: (discardUnsaved?: boolean) => Promise<void>; dialog: ReactNode } {
  const { signOut } = useAccountSession();
  const [confirming, setConfirming] = useState(false);
  async function start(discardUnsaved = false) {
    const result = await signOut(discardUnsaved);
    if (!result.ok && result.reason === "confirmation_required") setConfirming(true);
  }
  const dialog = confirming ? (
    <Dialog
      title="Sign out with unsaved account edits?"
      description="Saved work stays in your account. Unsaved edits will be discarded only after sign-out is confirmed."
      size="sm"
      onClose={() => setConfirming(false)}
      footer={
        <>
          <Button variant="secondary" autoFocus onClick={() => setConfirming(false)}>
            Keep editing
          </Button>
          <Button
            variant="danger-filled"
            onClick={() => {
              setConfirming(false);
              void start(true);
            }}
          >
            Discard edits and sign out
          </Button>
        </>
      }
    />
  ) : null;
  return { start, dialog };
}

/** Settings' sign-out and recovery controls: an explicit account check beside Sign out. The account menu
 * builds its own rows from `useSignOutFlow`. */
export function AccountAccess() {
  const { session, refresh, signingIn, signingUp, signingOut, signOutError } = useAccountSession();
  const { start: startSignOut, dialog } = useSignOutFlow();

  const signOutAvailable = session.status === "ready" || signingOut || Boolean(signOutError);
  const signOutLabel = signingOut ? "Signing out…" : signOutError ? "Retry sign-out" : "Sign out";
  const signInLink = (
    <Link
      className="text-link auth-session-action"
      href="/sign-in"
      onClick={(event) => {
        if (!preparePromptForSignIn()) event.preventDefault();
      }}
    >
      Sign in
    </Link>
  );

  return (
    <>
      <div className="topbar-account auth-account-access">
        <button
          type="button"
          className="icon-button subtle account-check"
          aria-label={session.status === "checking" ? "Checking account…" : "Check account"}
          title="Check account"
          onClick={refresh}
          disabled={session.status === "checking" || signingIn || signingOut}
        >
          <Icon name="refresh" size={18} />
        </button>
        {signingIn ? (
          <button type="button" className="text-link auth-session-action" disabled>
            {signingUp ? "Creating account…" : "Signing in…"}
          </button>
        ) : signOutAvailable ? (
          <button
            type="button"
            className="text-link auth-session-action"
            onClick={() => void startSignOut()}
            disabled={signingOut}
          >
            {signOutLabel}
          </button>
        ) : session.status === "checking" ? (
          <span className="text-link auth-session-action" role="status">
            Checking account…
          </span>
        ) : (
          signInLink
        )}
        <Link className="preview-badge" href="/settings">
          {session.status === "ready"
            ? "Account connected"
            : session.status === "checking"
              ? "Checking account…"
              : "Sign in to save"}
        </Link>
      </div>
      {dialog}
    </>
  );
}

export function AccountAccessNotice() {
  const { signOutError, signInSlow, signingUp } = useAccountSession();
  if (signOutError)
    return (
      <div className="auth-session-notice" role="alert">
        {signOutError}
      </div>
    );
  return signInSlow ? (
    <div className="auth-session-notice" role="status">
      {signingUp ? "Account creation" : "Sign-in"} is taking longer than expected. Account actions will resume when it
      finishes. Your work is kept while we check the connection.
    </div>
  ) : null;
}
