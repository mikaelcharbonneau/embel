"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { EmbelMark, Icon } from "@/components/ui/icon";
import { requestPasswordResetEmail, resetEmailErrorMessage } from "./password-reset-request";
import { readCaptcha, TurnstileWidget, type TurnstileHandle } from "./turnstile-widget";
import "@/styles/auth.css";

export function ForgotPasswordForm({ configured, overlay = false }: { configured: boolean; overlay?: boolean }) {
  const idPrefix = overlay ? "auth-overlay" : "auth-page";
  const emailInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const captcha = useRef<TurnstileHandle>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const disabled = !configured || submitting;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || pending.current) return;
    const email = emailInput.current?.value.trim() ?? "";
    if (!email || email.length > 320) {
      setError("Enter the email address you use for Embel.");
      return;
    }
    const check = readCaptcha(captcha.current);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    setError("");
    pending.current = true;
    setSubmitting(true);
    try {
      await requestPasswordResetEmail(email, check.token);
      setSent(true);
    } catch (failure) {
      setError(resetEmailErrorMessage(failure));
    } finally {
      pending.current = false;
      captcha.current?.reset();
      setSubmitting(false);
    }
  }

  return (
    <div className={`auth-guided ${overlay ? "auth-guided-modal" : "page auth-guided-page"}`}>
      <section className="auth-card" aria-labelledby={`${idPrefix}-title`}>
        <header className="auth-guided-heading">
          <EmbelMark />
          <h1 id={`${idPrefix}-title`} tabIndex={-1}>
            {sent ? "Check your email" : "Reset your password"}
          </h1>
          <p className="auth-intro">
            {sent
              ? "Use the link we sent to choose a new password."
              : "Enter your email and we'll send you a link to choose a new password."}
          </p>
        </header>
        {!configured && (
          <div className="auth-unavailable" role="status">
            <Icon name="offline" size={18} />
            <p>Password reset is unavailable right now. Please try again shortly.</p>
          </div>
        )}
        {sent ? (
          <div className="auth-confirmation-note" role="status">
            <p>
              If an account uses this address, a reset link will arrive shortly. Open it in this browser. The link works
              once and expires after a short time. Check your spam folder too.
            </p>
            <button type="button" className="text-link auth-resend-toggle" onClick={() => setSent(false)}>
              Send another link
            </button>
          </div>
        ) : (
          <form
            method="post"
            action="/api/auth/password-reset"
            onSubmit={submit}
            aria-label="Request a password reset link"
            aria-busy={submitting}
          >
            <fieldset disabled={disabled}>
              <label className="auth-field" htmlFor={`${idPrefix}-reset-email`}>
                Email
                <input
                  ref={emailInput}
                  id={`${idPrefix}-reset-email`}
                  name="email"
                  type="email"
                  placeholder="you@example.com"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={320}
                  required
                  onChange={() => setError("")}
                  aria-describedby={error ? `${idPrefix}-error` : undefined}
                />
              </label>
              <TurnstileWidget handleRef={captcha} />
              <button type="submit" className="button primary auth-submit">
                {submitting ? "Sending link…" : "Send reset link"}
                {submitting ? (
                  <span className="auth-progress" aria-hidden="true" />
                ) : (
                  <Icon name="arrow-right" size="sm" />
                )}
              </button>
            </fieldset>
            {error && (
              <p className="form-error" id={`${idPrefix}-error`} role="alert">
                {error}
              </p>
            )}
          </form>
        )}
        <p className="auth-mode-switch">
          Remembered it?{" "}
          <Link className="text-link" href="/sign-in" replace={overlay}>
            Sign in
          </Link>
        </p>
      </section>
      <div className="auth-guided-browser">
        <Link className="auth-browser-link text-link" href="/">
          Return to Home
          <Icon name="arrow-right" size="sm" />
        </Link>
      </div>
    </div>
  );
}

export default ForgotPasswordForm;
