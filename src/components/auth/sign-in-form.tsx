"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "@/components/ui/icon";
import { useAccountSession } from "@/components/workspace/account-session";
import { requestSignIn, signInErrorMessage } from "./sign-in-request";
import "@/styles/auth.css";

export function SignInForm({ configured }: { configured: boolean }) {
  const router = useRouter();
  const { session, signIn, signingIn: submitting } = useAccountSession();
  const emailInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const [error, setError] = useState("");

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured || submitting || session.status === "checking" || session.status === "ready") return;
    const email = emailInput.current?.value.trim() ?? "";
    const password = passwordInput.current?.value ?? "";
    if (!email || email.length > 320 || !password || password.length > 1024) {
      if (passwordInput.current) passwordInput.current.value = "";
      setError("Enter your email and password to continue.");
      return;
    }
    const body = JSON.stringify({ email, password });
    // Keep the password out of React state and clear the field as soon as the attempt starts.
    if (passwordInput.current) passwordInput.current.value = "";
    setError("");
    const result = await signIn(() => requestSignIn(body));
    if (!mounted.current) return;
    if (passwordInput.current) passwordInput.current.value = "";
    if (result.ok) {
      // The provider has started fresh verification before this internal navigation.
      router.replace("/brands");
      router.refresh();
    } else if (result.reason === "failed") {
      setError(signInErrorMessage(result.error));
    }
  }

  const checking = session.status === "checking";
  const signedIn = session.status === "ready";
  return <div className="page auth-page">
    <section className="auth-card" aria-labelledby="sign-in-title">
      <div className="auth-heading"><span className="auth-mark" aria-hidden="true">f</span><span className="auth-stage">Development workspace</span></div>
      <h1 id="sign-in-title">{signedIn ? "You're signed in" : "Sign in to Fluid"}</h1>
      {signedIn ? <><p className="auth-intro">Your account is ready. Continue to your brands and saved projects.</p><Link className="button primary auth-continue" href="/brands">Go to Brands<Icon name="arrow" size={16} /></Link></> : <>
        <p className="auth-intro">Use an existing test account. Account creation isn&apos;t available in this development workspace.</p>
        {!configured ? <div className="auth-unavailable" role="status"><Icon name="offline" size={18} /><p>Sign-in is not connected. You can continue with browser drafts.</p></div> : null}
        <form method="post" action="/api/auth/sign-in" onSubmit={submit} aria-label="Sign in" aria-busy={submitting}>
          <fieldset disabled={!configured || submitting || checking}>
            <label className="auth-field" htmlFor="sign-in-email">Email<input ref={emailInput} id="sign-in-email" name="email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={320} required onChange={() => setError("")} /></label>
            <label className="auth-field" htmlFor="sign-in-password">Password<input ref={passwordInput} id="sign-in-password" name="password" type="password" autoComplete="current-password" maxLength={1024} required onChange={() => setError("")} aria-describedby={error ? "sign-in-error" : undefined} /></label>
            <button type="submit" className="button primary auth-submit">{submitting ? "Signing in…" : "Sign in"}{submitting ? <span className="auth-progress" aria-hidden="true" /> : <Icon name="arrow" size={16} />}</button>
          </fieldset>
          {checking && configured && !submitting ? <p className="auth-status" role="status">Checking your account…</p> : null}
          {error ? <p className="form-error" id="sign-in-error" role="alert">{error}</p> : null}
        </form>
      </>}
      <div className="auth-draft-note"><Icon name="device" size={16} /><p>Your browser drafts and Names workspace stay on this device. Signing in doesn&apos;t move them into your account.</p></div>
    </section>
    <Link className="auth-browser-link text-link" href="/brands">Continue with browser drafts<Icon name="arrow" size={14} /></Link>
  </div>;
}

export default SignInForm;
