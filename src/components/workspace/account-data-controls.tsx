"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { InlineMessage } from "@/components/ui/message";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { useAccountProfile } from "./account-profile-provider";

type ErrorBody = { error?: { code?: unknown } };
async function errorCode(response: Response): Promise<string | null> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") return null;
  try {
    const body = (await response.json()) as ErrorBody;
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

const exportMessages: Record<string, string> = {
  export_rate_limited: "You can download your data 3 times a day. Try again tomorrow.",
  unauthenticated: "Your session has ended. Sign in again to download your data.",
};
const deletionMessages: Record<string, string> = {
  confirmation_mismatch: "That email doesn't match this account. Check it and try again.",
  reauthentication_required:
    "For your security, sign in again before deleting your account. Then come back to Settings.",
  deletion_incomplete: "Deletion didn't finish. Some of your data may already be deleted. Try again to finish it.",
  unauthenticated: "Your session has ended. Sign in again to delete your account.",
};
/** The same comparison the server makes; the server still checks it. */
const sameEmail = (typed: string, email: string) => typed.trim().toLowerCase() === email.trim().toLowerCase();

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
    setExporting(true);
    setExportError(null);
    try {
      const response = await fetch("/api/account/export", {
        method: "POST",
        credentials: "same-origin",
        mode: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "X-Embel-Account": account.userId },
        body: "{}",
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
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setExportError("The download was interrupted. Check your connection and try again.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="e-section" aria-labelledby="account-data-title">
      <div className="e-section__head">
        <h2 className="e-section__title" id="account-data-title">
          Your data
        </h2>
        <p className="e-section__hint">Take a copy of your work, or remove your account.</p>
      </div>
      <div>
        <div className="e-setting-row">
          <div className="e-setting-row__text">
            <p className="e-setting-row__title">Download my data</p>
            <p className="e-section__hint">
              A ZIP with your profile, projects, Strategy, Voice and Identity work, and the files you generated or
              uploaded.
            </p>
            {exportError && (
              <InlineMessage tone="danger" form="field">
                {exportError}
              </InlineMessage>
            )}
          </div>
          <Button icon="download" loading={exporting} onClick={() => void download()}>
            {exporting ? "Preparing…" : "Download"}
          </Button>
        </div>
        <div className="e-setting-row">
          <div className="e-setting-row__text">
            <p className="e-setting-row__title">Delete account</p>
            <p className="e-section__hint">
              Permanently delete your account, projects and files. This can’t be undone.
            </p>
          </div>
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Delete account
          </Button>
        </div>
      </div>
      {confirming && <DeleteAccountDialog account={account} onClose={() => setConfirming(false)} />}
    </section>
  );
}

function DeleteAccountDialog({ account, onClose }: { account: VerifiedAccount; onClose: () => void }) {
  const { signOut } = useAccountSession();
  const profile = useAccountProfile();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<{ status: "idle" | "deleting" | "deleted"; error: string | null }>({
    status: "idle",
    error: null,
  });
  const ids = { form: useId(), cancel: useId(), field: useId(), note: useId(), error: useId() };
  const deleting = state.status === "deleting";
  // The account's own email, when this owner's profile is loaded; otherwise the server alone compares.
  const saved = profile?.workspace?.saved;
  const accountEmail = saved && saved.ownerId === account.userId ? saved.email : null;
  const matches = accountEmail ? sameEmail(email, accountEmail) : Boolean(email.trim());

  // Focus starts on Cancel (after the dialog has opened and placed its own focus).
  useEffect(() => document.getElementById(ids.cancel)?.focus(), [ids.cancel]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (deleting || !email.trim() || !matches) return;
    setState({ status: "deleting", error: null });
    try {
      const response = await fetch("/api/account/deletion", {
        method: "POST",
        credentials: "same-origin",
        mode: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "X-Embel-Account": account.userId },
        body: JSON.stringify({ confirmEmail: email.trim() }),
      });
      if (!response.ok) {
        const code = await errorCode(response);
        setState({
          status: "idle",
          error:
            (code && deletionMessages[code]) ??
            "Your account couldn't be deleted right now. Nothing more was changed. Try again in a moment.",
        });
        return;
      }
      setState({ status: "deleted", error: null });
      // The account is gone: clear this tab's account state and leave Settings.
      await signOut(true).catch(() => undefined);
      router.replace("/");
    } catch {
      setState({
        status: "idle",
        error: "The connection dropped before Embel confirmed the deletion. Try again to make sure it finishes.",
      });
    }
  }

  if (state.status === "deleted")
    return (
      <Dialog size="sm" title="Account deleted" onClose={() => undefined} busy>
        <p role="status">Your account and data were deleted. Signing you out…</p>
      </Dialog>
    );
  return (
    <Dialog
      size="sm"
      title="Delete your account?"
      onClose={onClose}
      busy={deleting}
      footer={
        <>
          <Button id={ids.cancel} onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={ids.form}
            variant="danger-filled"
            loading={deleting}
            disabled={!deleting && !matches}
          >
            {deleting ? "Deleting…" : "Delete account"}
          </Button>
        </>
      }
    >
      <form id={ids.form} className="e-stack" onSubmit={(event) => void submit(event)}>
        <p>
          Your account, every project, and every file you made or uploaded will be deleted for good. This can’t be
          undone.
        </p>
        <p>
          Any work in progress is stopped. A record of the credits you used is kept for our accounts, without your name
          or your work.
        </p>
        <div className="e-field">
          <label className="e-field__label" htmlFor={ids.field}>
            Type your email to confirm
          </label>
          <div className="e-input">
            <input
              id={ids.field}
              name="confirm-email"
              type="email"
              autoComplete="off"
              spellCheck={false}
              value={email}
              disabled={deleting}
              aria-invalid={state.error ? true : undefined}
              aria-describedby={[ids.note, state.error && ids.error].filter(Boolean).join(" ")}
              onChange={(event) => {
                setEmail(event.target.value);
                if (state.error) setState({ status: "idle", error: null });
              }}
            />
          </div>
          <p className="e-field__hint" id={ids.note}>
            {accountEmail
              ? `Your email is ${accountEmail}. The Delete account button turns on when it matches.`
              : "Type the email you sign in with."}
          </p>
        </div>
        {state.error && (
          <InlineMessage id={ids.error} tone="danger">
            {state.error}
          </InlineMessage>
        )}
      </form>
    </Dialog>
  );
}
