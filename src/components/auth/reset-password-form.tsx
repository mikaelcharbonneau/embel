"use client";

import { useRef, useState, type FormEvent } from "react";
import { Button, ButtonLink, IconButton } from "@/components/ui/button";
import { InlineMessage } from "@/components/ui/message";
import { useAccountSession } from "@/components/workspace/account-session";
import { newPasswordErrorMessage, PasswordResetRequestError, saveNewPassword } from "./password-reset-request";
import { AuthCard } from "./auth-card";
import { AuthField, fieldDescription } from "./auth-field";

type FieldErrors = { password?: string; confirm?: string; form?: string };
const passwordId = "auth-page-new-password";
const confirmId = "auth-page-confirm-password";

export function ResetPasswordForm({ configured }: { configured: boolean }) {
  const { refresh } = useAccountSession();
  const passwordInput = useRef<HTMLInputElement>(null);
  const confirmInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [expired, setExpired] = useState(false);
  const [shown, setShown] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
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
      setErrors({
        password:
          password.length > 1024
            ? "Use a password of 1,024 characters or fewer."
            : password
              ? `This password has ${password.length} character${password.length === 1 ? "" : "s"}. Use at least 12.`
              : "Use a password of at least 12 characters.",
      });
      passwordInput.current?.focus();
      return;
    }
    if (password !== repeated) {
      clearPasswords();
      setErrors({ confirm: "The two passwords don't match. Enter them again." });
      passwordInput.current?.focus();
      return;
    }
    setErrors({});
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
      const message = newPasswordErrorMessage(failure);
      setErrors(
        failure instanceof PasswordResetRequestError &&
          (failure.code === "weak_password" || failure.code === "same_password")
          ? { password: message }
          : { form: message },
      );
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }

  const title = saved ? "Your password is updated" : expired ? "This link has expired" : "Choose a new password";
  return (
    <AuthCard
      overlay={false}
      titleId="auth-page-title"
      title={title}
      intro={
        saved
          ? "You're signed in. Use your new password next time you sign in."
          : expired
            ? "Reset links work once and only for a short time."
            : "You'll stay signed in on this device."
      }
    >
      {!configured && (
        <InlineMessage>Password changes are unavailable right now. Please try again shortly.</InlineMessage>
      )}
      {saved ? (
        <ButtonLink variant="primary" block arrow href="/brands">
          Go to Projects
        </ButtonLink>
      ) : expired ? (
        <>
          <InlineMessage tone="warning">{errors.form}</InlineMessage>
          <ButtonLink variant="primary" block arrow href="/forgot-password">
            Request a new link
          </ButtonLink>
        </>
      ) : (
        <form
          className="auth-form"
          method="post"
          action="/api/auth/password"
          onSubmit={submit}
          noValidate
          aria-label="Choose a new password"
          aria-busy={submitting}
        >
          <fieldset className="auth-form__fields" disabled={!configured}>
            <AuthField id={passwordId} label="New password" hint="Use at least 12 characters." error={errors.password}>
              <input
                ref={passwordInput}
                id={passwordId}
                name="password"
                type={shown ? "text" : "password"}
                autoComplete="new-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                minLength={12}
                maxLength={1024}
                required
                readOnly={submitting}
                {...fieldDescription(passwordId, { error: errors.password, hint: true })}
                onChange={() => setErrors({})}
              />
              <IconButton
                className="auth-password-toggle"
                icon={shown ? "eye-off" : "eye"}
                label="Show passwords"
                size="sm"
                tooltip={false}
                pressed={shown}
                aria-controls={`${passwordId} ${confirmId}`}
                onClick={() => setShown((value) => !value)}
              />
            </AuthField>
            <AuthField id={confirmId} label="Confirm new password" error={errors.confirm}>
              <input
                ref={confirmInput}
                id={confirmId}
                name="confirmPassword"
                type={shown ? "text" : "password"}
                autoComplete="new-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                minLength={12}
                maxLength={1024}
                required
                readOnly={submitting}
                {...fieldDescription(confirmId, { error: errors.confirm })}
                onChange={() => setErrors({})}
              />
            </AuthField>
            {errors.form && (
              <InlineMessage id="auth-page-error" tone="danger">
                {errors.form}
              </InlineMessage>
            )}
            <Button type="submit" variant="primary" block loading={submitting}>
              Save new password
            </Button>
          </fieldset>
        </form>
      )}
    </AuthCard>
  );
}

export default ResetPasswordForm;
