"use client";

import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { isDialogBackdropClick } from "@/components/ui/dialog-backdrop";
import { useEffect, useRef, useState } from "react";
import { useAccountSession } from "./account-session";
import { preparePromptForSignIn } from "./prompt-recovery";
import "@/styles/auth.css";

export function AccountAccess() {
  const { session, refresh, signOut, signingIn, signingUp, signingOut, signOutError } = useAccountSession();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmSignOut && dialog.current && !dialog.current.open) {
      dialog.current.showModal();
      cancel.current?.focus();
    } else if (!confirmSignOut && dialog.current?.open) dialog.current.close();
  }, [confirmSignOut]);

  async function startSignOut(discardUnsaved = false) {
    const result = await signOut(discardUnsaved);
    if (!result.ok && result.reason === "confirmation_required") setConfirmSignOut(true);
  }

  return <>
    <div className="topbar-account auth-account-access">
      <button type="button" className="icon-button subtle account-check" aria-label={session.status === "checking" ? "Checking account…" : "Check account"} title="Check account" onClick={refresh} disabled={session.status === "checking" || signingIn || signingOut}><Icon name="refresh" size={18} /></button>
      {signingIn ? <button type="button" className="text-link auth-session-action" disabled>{signingUp ? "Creating account…" : "Signing in…"}</button> : session.status === "ready" || signingOut || signOutError ? <button type="button" className="text-link auth-session-action" onClick={() => void startSignOut()} disabled={signingOut}>{signingOut ? "Signing out…" : signOutError ? "Retry sign-out" : "Sign out"}</button> : session.status === "checking" ? <span className="text-link auth-session-action" role="status">Checking account…</span> : <Link className="text-link auth-session-action" href="/sign-in" onClick={event => { if (!preparePromptForSignIn()) event.preventDefault(); }}>Sign in</Link>}
      <Link className="preview-badge" href="/settings">{session.status === "ready" ? "Account connected" : session.status === "checking" ? "Checking account…" : "Sign in to save"}</Link>
    </div>
    <dialog ref={dialog} className="auth-signout-dialog" aria-labelledby="sign-out-title" aria-describedby="sign-out-description" onCancel={() => setConfirmSignOut(false)} onClose={event => { if (!event.currentTarget.open) setConfirmSignOut(false); }} onClick={event => { if (isDialogBackdropClick(event)) setConfirmSignOut(false); }}>
      <h2 id="sign-out-title">Sign out with unsaved account edits?</h2>
      <p id="sign-out-description">Saved work stays in your account. Unsaved edits will be discarded only after sign-out is confirmed.</p>
      <div className="auth-dialog-actions"><button ref={cancel} type="button" className="button secondary small" onClick={() => setConfirmSignOut(false)}>Keep editing</button><button type="button" className="button danger small" onClick={() => { setConfirmSignOut(false); void startSignOut(true); }}>Discard edits and sign out</button></div>
    </dialog>
  </>;
}

export function AccountAccessNotice() {
  const { signOutError, signInSlow, signingUp } = useAccountSession();
  if (signOutError) return <div className="auth-session-notice" role="alert">{signOutError}</div>;
  return signInSlow ? <div className="auth-session-notice" role="status">{signingUp ? "Account creation" : "Sign-in"} is taking longer than expected. Account actions will resume when it finishes. Your work is kept while we check the connection.</div> : null;
}
