"use client";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useState, type ReactNode } from "react";
import { useAccountSession } from "./account-session";
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
