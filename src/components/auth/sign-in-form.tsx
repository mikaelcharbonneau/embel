"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "@/components/ui/icon";
import { AuthArtwork } from "@/components/ui/auth-artwork";
import { useAccountSession } from "@/components/workspace/account-session";
import { requestSignIn, signInErrorMessage } from "./sign-in-request";
import { readPromptRecovery } from "@/components/workspace/prompt-recovery";
import "@/styles/auth.css";

export function SignInForm({ configured, overlay = false }: { configured: boolean; overlay?: boolean }) {
  const router = useRouter();
  const { session, signIn, signingIn: submitting } = useAccountSession();
  const emailInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const [error, setError] = useState("");
  const [hasPrompt, setHasPrompt] = useState(false);
  useEffect(() => {
    // Browser-only recovery is read after hydration; credentials stay in the existing form refs.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasPrompt(Boolean(readPromptRecovery()));
  }, []);

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
      router.replace(readPromptRecovery() ? "/" : "/brands");
      router.refresh();
    } else if (result.reason === "failed") {
      setError(signInErrorMessage(result.error));
    }
  }

  const checking = session.status === "checking";
  const signedIn = session.status === "ready";
  return <div className={`auth-guided ${overlay ? "auth-guided-modal" : "page auth-guided-page"}`}>
    <section className="auth-card" aria-labelledby="sign-in-title">
      <header className="auth-guided-heading"><AuthArtwork name="card-mark" /><h1 id="sign-in-title">{signedIn ? "You're signed in" : "Sign in to Fluid"}</h1><p className="auth-intro">{signedIn ? "Continue to your projects and saved work." : "Continue with an existing account."}</p></header>
      {hasPrompt && <div className="prompt-recovery-notice"><p>Your prompt and scope are saved in this browser. Sign in to continue, or return to your prompt.</p><Link className="text-link" href="/">Return to your prompt<Icon name="arrow" size={14} /></Link></div>}
      {signedIn ? <Link className="button primary auth-continue" href={hasPrompt ? "/" : "/brands"}>{hasPrompt ? "Continue your prompt" : "Go to Projects"}<AuthArtwork name="submit-arrow" /></Link> : <>
        {!configured ? <div className="auth-unavailable" role="status"><Icon name="offline" size={18} /><p>Sign-in is not connected. You can continue with browser drafts.</p></div> : null}
        <form method="post" action="/api/auth/sign-in" onSubmit={submit} aria-label="Sign in" aria-busy={submitting}>
          <fieldset disabled={!configured || submitting || checking}>
            <label className="auth-field" htmlFor="sign-in-email">Email<input ref={emailInput} id="sign-in-email" name="email" type="email" placeholder="you@example.com" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={320} required onChange={() => setError("")} /></label>
            <label className="auth-field" htmlFor="sign-in-password">Password<input ref={passwordInput} id="sign-in-password" name="password" type="password" placeholder="Enter your password" autoComplete="current-password" maxLength={1024} required onChange={() => setError("")} aria-describedby={error ? "sign-in-error" : undefined} /></label>
            <button type="submit" className="button primary auth-submit">{submitting ? "Signing in…" : "Sign in"}{submitting ? <span className="auth-progress" aria-hidden="true" /> : <AuthArtwork name="submit-arrow" />}</button>
          </fieldset>
          {checking && configured && !submitting ? <p className="auth-status" role="status">Checking your account…</p> : null}
          {error ? <p className="form-error" id="sign-in-error" role="alert">{error}</p> : null}
        </form>
      </>}
      {!signedIn && <p className="auth-signup-unavailable">Account creation is not available in this workspace.</p>}
    </section>
    <div className="auth-guided-browser"><div className="auth-draft-note"><AuthArtwork name="device" /><p>Your browser drafts stay on this device.</p></div><Link className="auth-browser-link text-link" href="/brands">Continue with browser drafts<AuthArtwork name="browser-arrow" /></Link></div>
  </div>;
}

export default SignInForm;
