"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button, ButtonLink, IconButton } from "@/components/ui/button";
import { InlineMessage } from "@/components/ui/message";
import { useAccountSession } from "@/components/workspace/account-session";
import { requestSignIn, SignInRequestError, signInErrorMessage } from "./sign-in-request";
import { requestSignUp, signUpErrorMessage } from "./sign-up-request";
import { hasPromptRecovery } from "@/components/workspace/prompt-recovery";
import { readCaptcha, TurnstileWidget, type TurnstileHandle } from "./turnstile-widget";
import { AuthCard } from "./auth-card";
import { AuthField, fieldDescription } from "./auth-field";

/** Messages shown under their own field; `form` is for answers that belong to no single field. */
type FormErrors = {
  email?: string;
  password?: string;
  confirm?: string;
  resendEmail?: string;
  form?: string;
  /** The email and password together didn't match an account: both fields are marked. */
  credentials?: boolean;
};

const ideaKept = "Your idea is kept. It will be waiting when you're signed in.";

function emailError(input: HTMLInputElement | null): string | undefined {
  const email = input?.value.trim() ?? "";
  if (!email) return "Enter your email address.";
  if (email.length > 320 || input?.validity.typeMismatch) return "Enter a valid email address, like name@example.com.";
  return undefined;
}

export function SignInForm({
  configured,
  overlay = false,
  mode = "sign-in",
  confirmation,
}: {
  configured: boolean;
  overlay?: boolean;
  mode?: "sign-in" | "sign-up";
  confirmation?: "complete" | "failed";
}) {
  const router = useRouter();
  const idPrefix = overlay ? "auth-overlay" : "auth-page";
  const ids = {
    title: `${idPrefix}-title`,
    email: `${idPrefix}-email`,
    password: `${idPrefix}-password`,
    confirm: `${idPrefix}-confirm-password`,
    resendEmail: `${idPrefix}-confirmation-email`,
    error: `${idPrefix}-error`,
  };
  const { session, signIn, signingIn: submitting, awaitingConfirmation, dismissConfirmation } = useAccountSession();
  const emailInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const confirmPasswordInput = useRef<HTMLInputElement>(null);
  // Clear every detached password node, including fields recreated after a
  // confirmation notice. A mount-only cleanup would retain the initial nodes.
  const bindPasswordInput = useCallback((element: HTMLInputElement | null) => {
    if (passwordInput.current && passwordInput.current !== element) passwordInput.current.value = "";
    passwordInput.current = element;
  }, []);
  const bindConfirmPasswordInput = useCallback((element: HTMLInputElement | null) => {
    if (confirmPasswordInput.current && confirmPasswordInput.current !== element)
      confirmPasswordInput.current.value = "";
    confirmPasswordInput.current = element;
  }, []);
  const resendEmailInput = useRef<HTMLInputElement>(null);
  const captcha = useRef<TurnstileHandle>(null);
  const resendCaptcha = useRef<TurnstileHandle>(null);
  const titleElement = useRef<HTMLHeadingElement>(null);
  const requestPending = useRef(false);
  const credentialGeneration = useRef(0);
  const mounted = useRef(true);
  const [errors, setErrors] = useState<FormErrors>({});
  const [resend, setResend] = useState(false);
  const [resent, setResent] = useState(false);
  const [hasPrompt, setHasPrompt] = useState(false);
  // Shown only while the person asks; every submit and clear masks it again.
  const [passwordsShown, setPasswordsShown] = useState(false);
  const signingUp = mode === "sign-up";
  const confirming = signingUp && awaitingConfirmation;
  const checking = session.status === "checking";
  const signedIn = session.status === "ready";
  const disabled = !configured || submitting || checking;
  // Fields stay enabled while a request runs (focus stays put); they are read-only until it answers.
  const unavailable = !configured || checking;

  const clearPasswords = useCallback(() => {
    credentialGeneration.current++;
    if (passwordInput.current) passwordInput.current.value = "";
    if (confirmPasswordInput.current) confirmPasswordInput.current.value = "";
    setPasswordsShown(false);
  }, []);
  const clearErrors = () => setErrors({});

  useEffect(() => () => clearPasswords(), [mode, clearPasswords]);

  useEffect(() => {
    if (confirming) titleElement.current?.focus();
  }, [confirming]);

  useEffect(() => {
    // Only recovery metadata enters state. Credentials remain in uncontrolled inputs.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasPrompt(hasPromptRecovery());
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** The app's own checks, by field. The browser's validation bubble is off (noValidate). */
  function validate(): FormErrors {
    const found: FormErrors = {};
    const password = passwordInput.current?.value ?? "";
    const repeated = confirmPasswordInput.current?.value ?? "";
    found.email = emailError(emailInput.current);
    if (!password) found.password = signingUp ? "Create a password of at least 12 characters." : "Enter your password.";
    else if (password.length > 1024) found.password = "Use a password of 1,024 characters or fewer.";
    else if (signingUp && password.length < 12)
      found.password = `This password has ${password.length} character${password.length === 1 ? "" : "s"}. Use at least 12.`;
    if (signingUp && password) {
      if (!repeated) found.confirm = "Enter the same password again.";
      else if (password !== repeated) found.confirm = "The two passwords don't match. Enter the same password again.";
    }
    return Object.fromEntries(Object.entries(found).filter(([, value]) => value)) as FormErrors;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || signedIn || requestPending.current) return;
    setPasswordsShown(false);
    const found = validate();
    if (Object.keys(found).length > 0) {
      clearPasswords();
      setErrors(found);
      (found.email ? emailInput : found.password ? passwordInput : confirmPasswordInput).current?.focus();
      return;
    }
    const email = emailInput.current?.value.trim() ?? "";
    const password = passwordInput.current?.value ?? "";
    const check = readCaptcha(captcha.current);
    if (!check.ok) {
      setErrors({ form: check.message });
      return;
    }
    const body = JSON.stringify({ email, password, ...(check.token ? { captchaToken: check.token } : {}) });
    if (signingUp) clearPasswords();
    const submittedGeneration = credentialGeneration.current;
    clearErrors();
    requestPending.current = true;
    const result = await signIn(() => (signingUp ? requestSignUp(body) : requestSignIn(body)), mode);
    requestPending.current = false;
    captcha.current?.reset();
    if (!mounted.current || credentialGeneration.current !== submittedGeneration) return;
    const transientSignIn =
      !signingUp &&
      !result.ok &&
      result.reason === "failed" &&
      result.error instanceof SignInRequestError &&
      result.error.status === 503;
    if (!transientSignIn) clearPasswords();
    if (result.ok) {
      if (emailInput.current) emailInput.current.value = "";
      if (result.confirmationRequired) return;
      // Fresh provider verification begins before this internal navigation.
      router.replace(hasPromptRecovery() ? "/" : "/brands");
      router.refresh();
    } else if (result.reason === "failed") {
      if (signingUp) setErrors({ form: signUpErrorMessage(result.error) });
      else if (result.error instanceof SignInRequestError && [401, 413, 422].includes(result.error.status)) {
        setErrors({ password: signInErrorMessage(result.error), credentials: true });
        // The person fixes the password next; the message under it is read with the field.
        passwordInput.current?.focus();
      } else setErrors({ form: signInErrorMessage(result.error) });
    }
  }

  async function resendConfirmation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || signedIn || requestPending.current) return;
    const email = resendEmailInput.current?.value.trim() ?? "";
    const invalid = emailError(resendEmailInput.current);
    if (invalid) {
      setErrors({ resendEmail: invalid });
      resendEmailInput.current?.focus();
      return;
    }
    const check = readCaptcha(resendCaptcha.current);
    if (!check.ok) {
      setErrors({ form: check.message });
      return;
    }
    clearErrors();
    setResent(false);
    requestPending.current = true;
    const result = await signIn(
      () =>
        requestSignUp(
          JSON.stringify({ email, ...(check.token ? { captchaToken: check.token } : {}) }),
          "resend-confirmation",
        ),
      "sign-up",
    );
    requestPending.current = false;
    resendCaptcha.current?.reset();
    if (!mounted.current) return;
    if (result.ok) {
      if (resendEmailInput.current) resendEmailInput.current.value = "";
      setResent(true);
    } else if (result.reason === "failed") setErrors({ form: signUpErrorMessage(result.error) });
  }

  const title = signedIn
    ? "You're signed in"
    : confirming
      ? "Check your email"
      : signingUp
        ? "Create your Embel account"
        : "Sign in to Embel";
  const intro = signedIn
    ? "Continue to your projects and saved work."
    : confirming
      ? "Confirm your email to finish setting up your account."
      : hasPrompt
        ? ideaKept
        : signingUp
          ? "Save your projects and keep your work together."
          : "Continue with your email and password.";
  const formMessage = errors.form ? (
    <InlineMessage id={ids.error} tone="danger">
      {errors.form}
    </InlineMessage>
  ) : null;
  return (
    <AuthCard
      overlay={overlay}
      titleId={ids.title}
      titleRef={titleElement}
      title={title}
      intro={intro}
      onLeave={clearPasswords}
    >
      {confirmation === "failed" && (
        <InlineMessage tone="warning">
          We couldn&apos;t confirm your email with this link. Open the newest email link in the browser where you signed
          up, or send a new confirmation email below. If your email is already confirmed, sign in.
        </InlineMessage>
      )}
      {confirmation === "complete" && (
        <InlineMessage tone="positive">
          {signedIn ? "Your email is confirmed." : "Email confirmed. Sign in to start your first brand."}
        </InlineMessage>
      )}
      {signedIn ? (
        <ButtonLink variant="primary" block arrow href={hasPrompt ? "/" : "/brands"}>
          {hasPrompt ? "Continue your prompt" : "Go to Projects"}
        </ButtonLink>
      ) : (
        <>
          {!configured && (
            <InlineMessage>
              {signingUp ? "Account creation" : "Sign-in"} is unavailable right now. Your prompt is kept; please try
              again shortly.
            </InlineMessage>
          )}
          {confirming ? (
            <InlineMessage>
              <div className="e-stack e-stack--sm">
                <p>
                  If this address is eligible, a confirmation email will arrive shortly. Open its link in this browser.
                  Check your spam folder too.
                </p>
                <p>Already have an account? Sign in with your existing password.</p>
                {hasPrompt && <p>{ideaKept}</p>}
              </div>
            </InlineMessage>
          ) : (
            <form
              className="auth-form"
              method="post"
              action={signingUp ? "/api/auth/sign-up" : "/api/auth/sign-in"}
              onSubmit={submit}
              noValidate
              aria-label={signingUp ? "Create account" : "Sign in"}
              aria-busy={submitting}
            >
              <fieldset className="auth-form__fields" disabled={unavailable}>
                <AuthField id={ids.email} label="Email" error={errors.email}>
                  <input
                    ref={emailInput}
                    id={ids.email}
                    name="email"
                    type="email"
                    placeholder="you@example.com"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={320}
                    required
                    readOnly={submitting}
                    {...fieldDescription(ids.email, { error: errors.email, invalid: errors.credentials })}
                    onChange={() => {
                      if (!signingUp) clearPasswords();
                      clearErrors();
                    }}
                  />
                </AuthField>
                <AuthField
                  id={ids.password}
                  label="Password"
                  error={errors.password}
                  hint={signingUp ? "Use at least 12 characters." : undefined}
                  aside={
                    signingUp ? undefined : (
                      <Link
                        className="e-link e-link--standalone"
                        href="/forgot-password"
                        replace={overlay}
                        onClick={clearPasswords}
                      >
                        Forgot password?
                      </Link>
                    )
                  }
                >
                  <input
                    ref={bindPasswordInput}
                    id={ids.password}
                    name="password"
                    type={passwordsShown ? "text" : "password"}
                    autoComplete={signingUp ? "new-password" : "current-password"}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    minLength={signingUp ? 12 : undefined}
                    maxLength={1024}
                    required
                    readOnly={submitting}
                    {...fieldDescription(ids.password, { error: errors.password, hint: signingUp })}
                    onChange={clearErrors}
                  />
                  <IconButton
                    className="auth-password-toggle"
                    icon={passwordsShown ? "eye-off" : "eye"}
                    label={signingUp ? "Show passwords" : "Show password"}
                    size="sm"
                    tooltip={false}
                    pressed={passwordsShown}
                    aria-controls={signingUp ? `${ids.password} ${ids.confirm}` : ids.password}
                    onClick={() => setPasswordsShown((shown) => !shown)}
                  />
                </AuthField>
                {signingUp && (
                  <AuthField id={ids.confirm} label="Confirm password" error={errors.confirm}>
                    <input
                      ref={bindConfirmPasswordInput}
                      id={ids.confirm}
                      name="confirmPassword"
                      type={passwordsShown ? "text" : "password"}
                      autoComplete="new-password"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      minLength={12}
                      maxLength={1024}
                      required
                      readOnly={submitting}
                      {...fieldDescription(ids.confirm, { error: errors.confirm })}
                      onChange={clearErrors}
                    />
                  </AuthField>
                )}
                <TurnstileWidget handleRef={captcha} />
                {!resend && formMessage}
                <Button type="submit" variant="primary" block loading={submitting}>
                  {signingUp ? "Create account" : "Sign in"}
                </Button>
              </fieldset>
              {checking && configured && !submitting && (
                <p className="auth-card__note" role="status">
                  Checking your account…
                </p>
              )}
              {signingUp && <p className="auth-card__note">You&apos;ll confirm your email before you sign in.</p>}
            </form>
          )}
          {(confirming || confirmation === "failed") && !resend && (
            <Button
              variant="secondary"
              block
              disabled={disabled}
              onClick={() => {
                clearPasswords();
                clearErrors();
                setResend(true);
              }}
            >
              Send a new confirmation email
            </Button>
          )}
          {resend && (
            <form
              className="auth-form"
              method="post"
              action="/api/auth/resend-confirmation"
              aria-label="Resend confirmation"
              aria-busy={submitting}
              noValidate
              onSubmit={resendConfirmation}
            >
              <fieldset className="auth-form__fields" disabled={unavailable}>
                <AuthField id={ids.resendEmail} label="Email" error={errors.resendEmail}>
                  <input
                    ref={resendEmailInput}
                    id={ids.resendEmail}
                    name="email"
                    type="email"
                    placeholder="you@example.com"
                    autoComplete="email"
                    autoCapitalize="none"
                    maxLength={320}
                    required
                    readOnly={submitting}
                    {...fieldDescription(ids.resendEmail, { error: errors.resendEmail })}
                    onChange={() => {
                      clearErrors();
                      setResent(false);
                    }}
                  />
                </AuthField>
                <TurnstileWidget handleRef={resendCaptcha} />
                {formMessage}
                <Button type="submit" variant="secondary" block loading={submitting}>
                  Resend confirmation
                </Button>
              </fieldset>
              {resent && (
                <InlineMessage tone="positive">
                  If this address is awaiting confirmation, a new email will arrive shortly. Wait a minute before
                  requesting another.
                </InlineMessage>
              )}
            </form>
          )}
          <p className="auth-card__switch">
            {signingUp ? "Already have an account?" : "New to Embel?"}{" "}
            {submitting ? (
              <button type="button" className="e-link" disabled>
                {signingUp ? "Sign in" : "Create account"}
              </button>
            ) : (
              <Link
                className="e-link"
                href={signingUp ? "/sign-in" : "/sign-up"}
                replace={overlay}
                onClick={clearPasswords}
              >
                {signingUp ? "Sign in" : "Create account"}
              </Link>
            )}
          </p>
          {confirming && (
            <button
              type="button"
              className="e-link auth-card__action"
              disabled={disabled}
              onClick={() => {
                clearPasswords();
                clearErrors();
                setResend(false);
                setResent(false);
                dismissConfirmation();
              }}
            >
              Use another email
            </button>
          )}
        </>
      )}
    </AuthCard>
  );
}

export default SignInForm;
