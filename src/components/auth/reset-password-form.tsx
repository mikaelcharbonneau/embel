"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { AuthArtwork } from "@/components/ui/auth-artwork";
import { Icon } from "@/components/ui/icon";
import { useAccountSession } from "@/components/workspace/account-session";
import { HidePasswordIcon, ShowPasswordIcon } from "./auth-icons";
import { newPasswordErrorMessage, PasswordResetRequestError, saveNewPassword } from "./password-reset-request";
import "@/styles/auth.css";

export function ResetPasswordForm({ configured }: { configured: boolean }) {
  const { refresh } = useAccountSession();
  const passwordInput = useRef<HTMLInputElement>(null);
  const confirmInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [expired, setExpired] = useState(false);
  const [shown, setShown] = useState(false);
  const [error, setError] = useState("");
  const disabled = !configured || submitting;

  function clearPasswords() {
    if (passwordInput.current) passwordInput.current.value = "";
    if (confirmInput.current) confirmInput.current.value = "";
    setShown(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || pending.current) return;
    const password = passwordInput.current?.value ?? "";
    const repeated = confirmInput.current?.value ?? "";
    setShown(false);
    if (password.length < 12 || password.length > 1024) {
      setError("Use a password of at least 12 characters.");
      return;
    }
    if (password !== repeated) {
      clearPasswords();
      setError("The passwords didn't match. Enter them again.");
      return;
    }
    setError("");
    pending.current = true;
    setSubmitting(true);
    try {
      await saveNewPassword(password);
      clearPasswords();
      setSaved(true);
      refresh();
    } catch (failure) {
      clearPasswords();
      if (failure instanceof PasswordResetRequestError && failure.code === "recovery_required") setExpired(true);
      setError(newPasswordErrorMessage(failure));
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }

  const title = saved ? "Your password is updated" : expired ? "This link has expired" : "Choose a new password";
  return (
    <div className="auth-guided page auth-guided-page">
      <section className="auth-card" aria-labelledby="auth-page-title">
        <header className="auth-guided-heading">
          <AuthArtwork name="card-mark" />
          <h1 id="auth-page-title" tabIndex={-1}>
            {title}
          </h1>
          <p className="auth-intro">
            {saved
              ? "You're signed in. Use your new password next time you sign in."
              : expired
                ? "Reset links work once and only for a short time."
                : "You'll stay signed in on this device."}
          </p>
        </header>
        {!configured && (
          <div className="auth-unavailable" role="status">
            <Icon name="offline" size={18} />
            <p>Password changes are unavailable right now. Please try again shortly.</p>
          </div>
        )}
        {saved ? (
          <Link className="button primary auth-continue" href="/brands">
            Go to Projects
            <AuthArtwork name="submit-arrow" />
          </Link>
        ) : expired ? (
          <>
            <p className="auth-confirmation-note" role="alert">
              {error}
            </p>
            <Link className="button primary auth-continue" href="/forgot-password">
              Request a new link
              <AuthArtwork name="submit-arrow" />
            </Link>
          </>
        ) : (
          <form
            method="post"
            action="/api/auth/password"
            onSubmit={submit}
            aria-label="Choose a new password"
            aria-busy={submitting}
          >
            <fieldset disabled={disabled}>
              <div className="auth-password-field">
                <label className="auth-field" htmlFor="auth-page-new-password">
                  New password
                  <input
                    ref={passwordInput}
                    id="auth-page-new-password"
                    name="password"
                    type={shown ? "text" : "password"}
                    placeholder="Create a new password"
                    autoComplete="new-password"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    minLength={12}
                    maxLength={1024}
                    required
                    onChange={() => setError("")}
                    aria-describedby={error ? "auth-page-error" : "auth-page-password-guidance"}
                  />
                </label>
                <button
                  type="button"
                  className="auth-password-toggle"
                  aria-label="Show passwords"
                  aria-pressed={shown}
                  aria-controls="auth-page-new-password auth-page-confirm-password"
                  title={shown ? "Hide password" : "Show password"}
                  onClick={() => setShown((value) => !value)}
                >
                  {shown ? <HidePasswordIcon /> : <ShowPasswordIcon />}
                </button>
              </div>
              <p className="auth-field-help" id="auth-page-password-guidance">
                Use at least 12 characters.
              </p>
              <label className="auth-field auth-confirm-password" htmlFor="auth-page-confirm-password">
                Confirm new password
                <input
                  ref={confirmInput}
                  id="auth-page-confirm-password"
                  name="confirmPassword"
                  type={shown ? "text" : "password"}
                  placeholder="Enter it again"
                  autoComplete="new-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  minLength={12}
                  maxLength={1024}
                  required
                  onChange={() => setError("")}
                />
              </label>
              <button type="submit" className="button primary auth-submit">
                {submitting ? "Saving…" : "Save new password"}
                {submitting ? (
                  <span className="auth-progress" aria-hidden="true" />
                ) : (
                  <AuthArtwork name="submit-arrow" />
                )}
              </button>
            </fieldset>
            {error && (
              <p className="form-error" id="auth-page-error" role="alert">
                {error}
              </p>
            )}
          </form>
        )}
      </section>
      <div className="auth-guided-browser">
        <Link className="auth-browser-link text-link" href="/">
          Return to Home
          <AuthArtwork name="browser-arrow" />
        </Link>
      </div>
    </div>
  );
}

export default ResetPasswordForm;
