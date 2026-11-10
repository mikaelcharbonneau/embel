"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { isDialogBackdropClick } from "@/components/ui/dialog-backdrop";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import "@/styles/auth.css";

type ErrorBody = { error?: { code?: unknown } };
async function errorCode(response: Response): Promise<string | null> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") return null;
  try {
    const body = await response.json() as ErrorBody;
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch { return null; }
}

const exportMessages: Record<string, string> = {
  export_rate_limited: "You can download your data 3 times a day. Try again tomorrow.",
  unauthenticated: "Your session has ended. Sign in again to download your data.",
};
const deletionMessages: Record<string, string> = {
  confirmation_mismatch: "That email doesn't match this account. Check it and try again.",
  reauthentication_required: "For your security, sign in again before deleting your account. Then come back to Settings.",
  deletion_incomplete: "Deletion didn't finish. Some of your data may already be deleted. Try again to finish it.",
  unauthenticated: "Your session has ended. Sign in again to delete your account.",
};

/** Settings → Account: download a copy of everything, or delete the account. */
export function AccountDataControls() {
  const { session } = useAccountSession();
  if (session.status !== "ready") return null;
  return <AccountData key={`${session.userId}:${session.generation}`} account={session} />;
}

function AccountData({ account }: { account: VerifiedAccount }) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function download() {
    if (exporting) return;
    setExporting(true); setExportError(null);
    try {
      const response = await fetch("/api/account/export", {
        method: "POST", credentials: "same-origin", mode: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json", "X-Embel-Account": account.userId }, body: "{}",
      });
      if (!response.ok) {
        const code = await errorCode(response);
        setExportError((code && exportMessages[code]) ?? "Your data couldn't be prepared. Try again in a moment.");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `embel-data-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setExportError("The download was interrupted. Check your connection and try again.");
    } finally { setExporting(false); }
  }

  return <section className="sg-card sg-rows-card sg-account-data" aria-labelledby="account-data-title">
    <header><h2 id="account-data-title">Your data</h2><p>Take a copy of your work, or remove your account.</p></header>
    <div className="sg-card-body">
      <div className="sg-row">
        <div className="sg-row-copy"><strong>Download my data</strong>
          <p>A ZIP with your profile, projects, Strategy, Voice and Identity work, and the files you generated or uploaded.</p>
          {exportError && <p className="sg-account-data-error" role="alert">{exportError}</p>}
        </div>
        <button type="button" className="button secondary small" onClick={() => void download()} disabled={exporting} aria-busy={exporting}>{exporting ? "Preparing…" : "Download"}</button>
      </div>
      <div className="sg-row">
        <div className="sg-row-copy"><strong>Delete account</strong>
          <p>Permanently delete your account, projects and files. This can’t be undone.</p>
        </div>
        <button type="button" className="button danger small" onClick={() => setConfirming(true)}>Delete account</button>
      </div>
    </div>
    {confirming && <DeleteAccountDialog account={account} onClose={() => setConfirming(false)} />}
  </section>;
}

function DeleteAccountDialog({ account, onClose }: { account: VerifiedAccount; onClose: () => void }) {
  const { signOut } = useAccountSession();
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [state, setState] = useState<{ status: "idle" | "deleting" | "deleted"; error: string | null }>({ status: "idle", error: null });
  const ids = { title: useId(), description: useId(), field: useId(), error: useId() };
  const deleting = state.status === "deleting";

  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) { node.showModal(); input.current?.focus(); }
    return () => { if (node?.open) node.close(); };
  }, []);

  function close() { if (!deleting && state.status !== "deleted") onClose(); }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (deleting || !email.trim()) return;
    setState({ status: "deleting", error: null });
    try {
      const response = await fetch("/api/account/deletion", {
        method: "POST", credentials: "same-origin", mode: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json", "X-Embel-Account": account.userId },
        body: JSON.stringify({ confirmEmail: email.trim() }),
      });
      if (!response.ok) {
        const code = await errorCode(response);
        setState({ status: "idle", error: (code && deletionMessages[code]) ?? "Your account couldn't be deleted right now. Nothing more was changed. Try again in a moment." });
        return;
      }
      setState({ status: "deleted", error: null });
      // The account is gone: clear this tab's account state and leave Settings.
      await signOut(true).catch(() => undefined);
      router.replace("/");
    } catch {
      setState({ status: "idle", error: "The connection dropped before Embel confirmed the deletion. Try again to make sure it finishes." });
    }
  }

  return <dialog ref={dialog} className="auth-signout-dialog account-delete-dialog" aria-labelledby={ids.title} aria-describedby={ids.description}
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (isDialogBackdropClick(event)) close(); }}>
    <form onSubmit={event => void submit(event)}>
      <h2 id={ids.title}>{state.status === "deleted" ? "Account deleted" : "Delete your account?"}</h2>
      {state.status === "deleted" ? <p id={ids.description} role="status">Your account and data were deleted. Signing you out…</p> : <>
        <div id={ids.description}>
          <p>This permanently deletes your account, every project, your Strategy, Voice and Identity work, and all generated and uploaded files. It can’t be undone.</p>
          <p>Any generation still running is stopped. Credit and usage amounts are kept for accounting without your name or content.</p>
        </div>
        <label className="field-label account-delete-field" htmlFor={ids.field}>Type your email to confirm
          <input ref={input} id={ids.field} type="email" autoComplete="off" spellCheck={false} value={email} disabled={deleting}
            aria-invalid={state.error ? true : undefined} aria-describedby={state.error ? ids.error : undefined}
            onChange={event => { setEmail(event.target.value); if (state.error) setState({ status: "idle", error: null }); }} />
        </label>
        {state.error && <p id={ids.error} className="account-delete-error" role="alert">{state.error}</p>}
        <div className="auth-dialog-actions">
          <button type="button" className="button secondary small" onClick={close} disabled={deleting}>Cancel</button>
          <button type="submit" className="button danger small" disabled={deleting || !email.trim()} aria-busy={deleting}>{deleting ? "Deleting…" : "Delete account"}</button>
        </div>
      </>}
    </form>
  </dialog>;
}
