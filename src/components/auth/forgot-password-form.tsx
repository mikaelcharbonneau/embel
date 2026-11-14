"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { InlineMessage } from "@/components/ui/message";
import { requestPasswordResetEmail, resetEmailErrorMessage } from "./password-reset-request";
import { readCaptcha, TurnstileWidget, type TurnstileHandle } from "./turnstile-widget";
import { AuthCard } from "./auth-card";
import { AuthField, fieldDescription } from "./auth-field";

export function ForgotPasswordForm({ configured, overlay = false }: { configured: boolean; overlay?: boolean }) {
  const idPrefix = overlay ? "auth-overlay" : "auth-page";
  const emailId = `${idPrefix}-reset-email`;
  const emailInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const captcha = useRef<TurnstileHandle>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [fieldError, setFieldError] = useState("");
  const [formError, setFormError] = useState("");
  const disabled = !configured || submitting;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || pending.current) return;
    const email = emailInput.current?.value.trim() ?? "";
    if (!email || email.length > 320 || emailInput.current?.validity.typeMismatch) {
      setFormError("");
      setFieldError(
        email ? "Enter a valid email address, like name@example.com." : "Enter the email address you use for Embel.",
      );
      emailInput.current?.focus();
      return;
    }
    const check = readCaptcha(captcha.current);
    if (!check.ok) {
      setFormError(check.message);
      return;
    }
    setFieldError("");
    setFormError("");
    pending.current = true;
    setSubmitting(true);
    try {
      await requestPasswordResetEmail(email, check.token);
      setSent(true);
    } catch (failure) {
      setFormError(resetEmailErrorMessage(failure));
    } finally {
      pending.current = false;
      captcha.current?.reset();
      setSubmitting(false);
    }
  }

  return (
    <AuthCard
      overlay={overlay}
      titleId={`${idPrefix}-title`}
      title={sent ? "Check your email" : "Reset your password"}
      intro={
        sent
          ? "Use the link we sent to choose a new password."
          : "Enter your email and we'll send you a link to choose a new password."
      }
    >
      {!configured && <InlineMessage>Password reset is unavailable right now. Please try again shortly.</InlineMessage>}
      {sent ? (
        <>
          <InlineMessage tone="positive">
            If an account uses this address, a reset link will arrive shortly. Open it in this browser. The link works
            once and expires after a short time. Check your spam folder too.
          </InlineMessage>
          <Button variant="secondary" block onClick={() => setSent(false)}>
            Send another link
          </Button>
        </>
      ) : (
        <form
          className="auth-form"
          method="post"
          action="/api/auth/password-reset"
          onSubmit={submit}
          noValidate
          aria-label="Request a password reset link"
          aria-busy={submitting}
        >
          <fieldset className="auth-form__fields" disabled={!configured}>
            <AuthField id={emailId} label="Email" error={fieldError}>
              <input
                ref={emailInput}
                id={emailId}
                name="email"
                type="email"
                placeholder="you@example.com"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={320}
                required
                readOnly={submitting}
                {...fieldDescription(emailId, { error: fieldError })}
                onChange={() => {
                  setFieldError("");
                  setFormError("");
                }}
              />
            </AuthField>
            <TurnstileWidget handleRef={captcha} />
            {formError && (
              <InlineMessage id={`${idPrefix}-error`} tone="danger">
                {formError}
              </InlineMessage>
            )}
            <Button type="submit" variant="primary" block loading={submitting}>
              Send reset link
            </Button>
          </fieldset>
        </form>
      )}
      <p className="auth-card__switch">
        Remembered it?{" "}
        <Link className="e-link" href="/sign-in" replace={overlay}>
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}

export default ForgotPasswordForm;
