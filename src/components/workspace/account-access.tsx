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
      description="Unsaved edits will be lost."
      size="sm"
      onClose={() => setConfirming(false)}
      footer={
        <>
          <Button variant="secondary" data-dialog-focus onClick={() => setConfirming(false)}>
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
  const { activity } = useAccountSession();
  if (activity.kind === "sign_out_unconfirmed")
    return (
      <div className="auth-session-notice" role="alert">
        {activity.message}
      </div>
    );
  return activity.kind === "signing_in" && activity.slow ? (
    <div className="auth-session-notice" role="status">
      {activity.as === "sign-up" ? "Account creation" : "Sign-in"} is taking longer than expected. Your work is kept.
    </div>
  ) : null;
}
