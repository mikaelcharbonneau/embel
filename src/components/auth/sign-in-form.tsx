"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "@/components/ui/icon";
import { AuthArtwork } from "@/components/ui/auth-artwork";
import { useAccountSession } from "@/components/workspace/account-session";
import { requestSignIn, SignInRequestError, signInErrorMessage } from "./sign-in-request";
import { requestSignUp, signUpErrorMessage } from "./sign-up-request";
import { hasPromptRecovery } from "@/components/workspace/prompt-recovery";
import "@/styles/auth.css";

export function SignInForm({ configured, overlay = false, mode = "sign-in", confirmation }: {
  configured: boolean; overlay?: boolean; mode?: "sign-in" | "sign-up"; confirmation?: "complete" | "failed";
}) {
  const router = useRouter();
  const idPrefix = overlay ? "auth-overlay" : "auth-page";
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
    if (confirmPasswordInput.current && confirmPasswordInput.current !== element) confirmPasswordInput.current.value = "";
    confirmPasswordInput.current = element;
  }, []);
  const resendEmailInput = useRef<HTMLInputElement>(null);
  const titleElement = useRef<HTMLHeadingElement>(null);
  const requestPending = useRef(false);
  const credentialGeneration = useRef(0);
  const mounted = useRef(true);
  const [error, setError] = useState("");
  const [resend, setResend] = useState(false);
  const [resent, setResent] = useState(false);
  const [hasPrompt, setHasPrompt] = useState(false);
  const signingUp = mode === "sign-up";
  const confirming = signingUp && awaitingConfirmation;
  const checking = session.status === "checking";
  const signedIn = session.status === "ready";
  const disabled = !configured || submitting || checking;

  const clearPasswords = useCallback(() => {
    credentialGeneration.current++;
    if (passwordInput.current) passwordInput.current.value = "";
    if (confirmPasswordInput.current) confirmPasswordInput.current.value = "";
  }, []);

  useEffect(() => () => clearPasswords(), [mode, clearPasswords]);

  useEffect(() => { if (confirming) titleElement.current?.focus(); }, [confirming]);

  useEffect(() => {
    // Only recovery metadata enters state. Credentials remain in uncontrolled inputs.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasPrompt(hasPromptRecovery());
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || signedIn || requestPending.current) return;
    const email = emailInput.current?.value.trim() ?? "";
    const password = passwordInput.current?.value ?? "";
    const repeated = confirmPasswordInput.current?.value ?? "";
    if (!email || email.length > 320 || !password || password.length > 1024 || (signingUp && password.length < 12)) {
      clearPasswords();
      setError(signingUp ? "Enter your email and a password of at least 12 characters." : "Enter your email and password to continue.");
      return;
    }
    if (signingUp && password !== repeated) {
      clearPasswords();
      setError("The passwords didn't match. Enter them again.");
      return;
    }
    const body = JSON.stringify({ email, password });
    if (signingUp) clearPasswords();
    const submittedGeneration = credentialGeneration.current;
    setError("");
    requestPending.current = true;
    const result = await signIn(() => signingUp ? requestSignUp(body) : requestSignIn(body), mode);
    requestPending.current = false;
    if (!mounted.current || credentialGeneration.current !== submittedGeneration) return;
    const transientSignIn = !signingUp && !result.ok && result.reason === "failed" && result.error instanceof SignInRequestError && result.error.status === 503;
    if (!transientSignIn) clearPasswords();
    if (result.ok) {
      if (emailInput.current) emailInput.current.value = "";
      if (result.confirmationRequired) return;
      // Fresh provider verification begins before this internal navigation.
      router.replace(hasPromptRecovery() ? "/" : "/brands");
      router.refresh();
    } else if (result.reason === "failed") {
      setError(signingUp ? signUpErrorMessage(result.error) : signInErrorMessage(result.error));
    }
  }

  async function resendConfirmation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || signedIn || requestPending.current) return;
    const email = resendEmailInput.current?.value.trim() ?? "";
    if (!email || email.length > 320) { setError("Enter a valid email address."); return; }
    setError("");
    setResent(false);
    requestPending.current = true;
    const result = await signIn(() => requestSignUp(JSON.stringify({ email }), "resend-confirmation"), "sign-up");
    requestPending.current = false;
    if (!mounted.current) return;
    if (result.ok) {
      if (resendEmailInput.current) resendEmailInput.current.value = "";
      setResent(true);
    } else if (result.reason === "failed") setError(signUpErrorMessage(result.error));
  }

  const title = signedIn ? "You're signed in" : confirming ? "Check your email" : signingUp ? "Create your Embel account" : "Sign in to Embel";
  return <div className={`auth-guided ${overlay ? "auth-guided-modal" : "page auth-guided-page"}`}>
    <section className="auth-card" aria-labelledby={`${idPrefix}-title`}>
      <header className="auth-guided-heading"><AuthArtwork name="card-mark" /><h1 ref={titleElement} tabIndex={-1} id={`${idPrefix}-title`}>{title}</h1><p className="auth-intro">{signedIn ? "Continue to your projects and saved work." : confirming ? "Confirm your email to finish setting up your account." : signingUp ? "Save your projects and keep your work together." : "Continue with your email and password."}</p></header>
      {hasPrompt && <div className="prompt-recovery-notice"><p>Your prompt is kept while you sign in. {signingUp ? "Create an account or sign in" : "Sign in"} to continue, or return to your prompt.</p><Link className="text-link" href="/">Return to your prompt<Icon name="arrow" size={14} /></Link></div>}
      {confirmation === "failed" && <p className="auth-confirmation-note" role="alert">We couldn&apos;t complete this confirmation link. Open the newest email link in the browser where you requested it. If your email is already confirmed, sign in below. You can also request another confirmation email.</p>}
      {confirmation === "complete" && <p className="auth-confirmation-note" role="status">{signedIn ? "Your email is confirmed." : "Your confirmation link was processed. Check your account or sign in to continue."}</p>}
      {signedIn ? <Link className="button primary auth-continue" href={hasPrompt ? "/" : "/brands"}>{hasPrompt ? "Continue your prompt" : "Go to Projects"}<AuthArtwork name="submit-arrow" /></Link> : <>
        {!configured && <div className="auth-unavailable" role="status"><Icon name="offline" size={18} /><p>{signingUp ? "Account creation" : "Sign-in"} is unavailable right now. Your prompt is kept; please try again shortly.</p></div>}
        {confirming ? <div className="auth-confirmation-note" role="status"><p>If this address is eligible, a confirmation email will arrive shortly. Open its link in this browser. Check your spam folder too.</p><p>Already have an account? Sign in with your existing password.</p></div> : <form method="post" action={signingUp ? "/api/auth/sign-up" : "/api/auth/sign-in"} onSubmit={submit} aria-label={signingUp ? "Create account" : "Sign in"} aria-busy={submitting}>
          <fieldset disabled={disabled}>
            <label className="auth-field" htmlFor={`${idPrefix}-email`}>Email<input ref={emailInput} id={`${idPrefix}-email`} name="email" type="email" placeholder="you@example.com" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={320} required onChange={() => { if (!signingUp) clearPasswords(); setError(""); }} /></label>
            <label className="auth-field" htmlFor={`${idPrefix}-password`}>Password<input ref={bindPasswordInput} id={`${idPrefix}-password`} name="password" type="password" placeholder={signingUp ? "Create a password" : "Enter your password"} autoComplete={signingUp ? "new-password" : "current-password"} minLength={signingUp ? 12 : undefined} maxLength={1024} required onChange={() => setError("")} aria-describedby={error ? `${idPrefix}-error` : signingUp ? `${idPrefix}-password-guidance` : undefined} /></label>
            {signingUp && <><p className="auth-field-help" id={`${idPrefix}-password-guidance`}>Use at least 12 characters.</p><label className="auth-field auth-confirm-password" htmlFor={`${idPrefix}-confirm-password`}>Confirm password<input ref={bindConfirmPasswordInput} id={`${idPrefix}-confirm-password`} name="confirmPassword" type="password" placeholder="Enter your password again" autoComplete="new-password" minLength={12} maxLength={1024} required onChange={() => setError("")} /></label><p className="auth-field-help">You&apos;ll need to confirm your email before signing in.</p></>}
            <button type="submit" className="button primary auth-submit">{submitting ? signingUp ? "Creating account…" : "Signing in…" : signingUp ? "Create account" : "Sign in"}{submitting ? <span className="auth-progress" aria-hidden="true" /> : <AuthArtwork name="submit-arrow" />}</button>
          </fieldset>
          {checking && configured && !submitting && <p className="auth-status" role="status">Checking your account…</p>}
          {error && !resend && <p className="form-error" id={`${idPrefix}-error`} role="alert">{error}</p>}
        </form>}
        {(confirming || confirmation === "failed") && !resend && <button type="button" className="text-link auth-resend-toggle" disabled={disabled} onClick={() => { clearPasswords(); setError(""); setResend(true); }}>Request another confirmation email</button>}
        {resend && <form method="post" action="/api/auth/resend-confirmation" aria-label="Resend confirmation" aria-busy={submitting} onSubmit={resendConfirmation}>
          <fieldset disabled={disabled}><label className="auth-field" htmlFor={`${idPrefix}-confirmation-email`}>Email<input ref={resendEmailInput} id={`${idPrefix}-confirmation-email`} name="email" type="email" placeholder="you@example.com" autoComplete="email" autoCapitalize="none" maxLength={320} required onChange={() => { setError(""); setResent(false); }} /></label><button className="button secondary auth-submit" type="submit">{submitting ? "Requesting email…" : "Resend confirmation"}</button></fieldset>
          {resent && <p className="auth-status" role="status">If this address is awaiting confirmation, a new email will arrive shortly. Wait a minute before requesting another.</p>}
          {error && <p className="form-error" id={`${idPrefix}-error`} role="alert">{error}</p>}
        </form>}
        <p className="auth-mode-switch">{signingUp ? "Already have an account?" : "New to Embel?"} {submitting ? <button type="button" className="text-link" disabled>{signingUp ? "Sign in" : "Create account"}</button> : <Link className="text-link" href={signingUp ? "/sign-in" : "/sign-up"} replace={overlay} onClick={clearPasswords}>{signingUp ? "Sign in" : "Create account"}</Link>}</p>
        {confirming && <button type="button" className="text-link auth-resend-toggle" disabled={disabled} onClick={() => { clearPasswords(); setError(""); setResend(false); setResent(false); dismissConfirmation(); }}>Use another email</button>}
      </>}
    </section>
    <div className="auth-guided-browser"><div className="auth-draft-note"><AuthArtwork name="device" /><p>Your projects and names save to your account.</p></div><Link className="auth-browser-link text-link" href="/" onClick={clearPasswords}>Return to Home<AuthArtwork name="browser-arrow" /></Link></div>
  </div>;
}

export default SignInForm;
