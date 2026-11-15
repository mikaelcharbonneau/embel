/** The session machine (docs/state-machines.md, J6): what the account is doing besides its status, and
 * what a person is told and offered for each situation. The provider in `account-session.tsx` runs it. */

import { SignInRequestError } from "@/components/auth/sign-in-request";
import { SignUpRequestError } from "@/components/auth/sign-up-request";

export type SessionStatus = "checking" | "signed_out" | "unavailable" | "error" | "ready";

/** What the account is doing right now. One thing at a time: a sign-in and a sign-out refuse each other. */
export type SessionActivity =
  | { kind: "idle" }
  /** A sign-in or account creation request is on its way. `slow`: it has taken 30 seconds. */
  | { kind: "signing_in"; as: "sign-in" | "sign-up"; slow: boolean }
  | { kind: "signing_out" }
  /** The sign-out request failed or was not answered. Stays until sign-out is retried or the account is checked. */
  | { kind: "sign_out_unconfirmed"; message: string };

export type SessionMode = {
  activity: SessionActivity;
  /** An account was created and its email link has not been opened yet. */
  awaitingConfirmation: boolean;
};

export type SessionModeEvent =
  | { type: "sign_in_started"; as: "sign-in" | "sign-up" }
  /** 30 seconds passed without an answer. */
  | { type: "sign_in_slow" }
  | { type: "sign_in_finished"; outcome: "signed_in" | "confirmation_required" | "failed" }
  | { type: "sign_out_started" }
  | { type: "sign_out_confirmed" }
  | { type: "sign_out_unconfirmed"; message: string }
  /** The account is being checked again, which also ends sign-out recovery. */
  | { type: "check_started" }
  /** A check found a signed-in account. */
  | { type: "account_verified" }
  /** "Use another email" on the confirmation notice. */
  | { type: "confirmation_dismissed" };

const idle: SessionActivity = { kind: "idle" };
export const initialSessionMode: SessionMode = { activity: idle, awaitingConfirmation: false };

/** Returns the same object when nothing changes, so an event that changes nothing renders nothing. */
export function sessionModeReducer(state: SessionMode, event: SessionModeEvent): SessionMode {
  switch (event.type) {
    case "sign_in_started":
      return { ...state, activity: { kind: "signing_in", as: event.as, slow: false } };
    case "sign_in_slow":
      return state.activity.kind === "signing_in" && !state.activity.slow
        ? { ...state, activity: { ...state.activity, slow: true } }
        : state;
    case "sign_in_finished":
      return {
        activity: idle,
        awaitingConfirmation:
          event.outcome === "confirmation_required"
            ? true
            : event.outcome === "signed_in"
              ? false
              : state.awaitingConfirmation,
      };
    case "sign_out_started":
      return { ...state, activity: { kind: "signing_out" } };
    case "sign_out_confirmed":
      return { activity: idle, awaitingConfirmation: false };
    case "sign_out_unconfirmed":
      return { ...state, activity: { kind: "sign_out_unconfirmed", message: event.message } };
    case "check_started":
      return state.activity.kind === "sign_out_unconfirmed" ? { ...state, activity: idle } : state;
    case "account_verified":
      // A signed-in account is not waiting for its email link.
      return state.awaitingConfirmation ? { ...state, awaitingConfirmation: false } : state;
    case "confirmation_dismissed":
      return state.awaitingConfirmation ? { ...state, awaitingConfirmation: false } : state;
  }
}

/* The questions screens ask about the activity. A screen imports these instead of comparing `activity.kind`
 * itself, so the context carries one value and no copies of it. */

/** A sign-in or an account creation request is on its way. */
export const isSigningIn = (activity: SessionActivity): boolean => activity.kind === "signing_in";
/** The request on its way creates an account. */
export const isCreatingAccount = (activity: SessionActivity): boolean =>
  activity.kind === "signing_in" && activity.as === "sign-up";
export const isSigningOut = (activity: SessionActivity): boolean => activity.kind === "signing_out";
/** A sign-out was asked for and not confirmed: the account stays hidden until it is retried or checked. */
export const isSignOutUnconfirmed = (activity: SessionActivity): boolean => activity.kind === "sign_out_unconfirmed";

/** What a disabled button says while a sign-in or account creation is on its way. */
export const signingInLabel = (activity: SessionActivity): string =>
  isCreatingAccount(activity) ? "Creating account…" : "Signing in…";

/** What the Sign out control says. It is disabled while `isSigningOut`. */
export const signOutLabel = (activity: SessionActivity): string =>
  isSigningOut(activity) ? "Signing out…" : isSignOutUnconfirmed(activity) ? "Retry sign-out" : "Sign out";

/** The one thing a person is told while their account content is not shown. */
export type SessionNotice =
  | "signing_in"
  | "creating_account"
  | "signing_out"
  | "sign_out_unconfirmed"
  | "checking"
  /** Account saving answered that it is unavailable (503). */
  | "unavailable"
  /** Nobody is signed in: the invitation to sign in or create an account. */
  | "signed_out"
  /** The account could not be checked (network or server). */
  | "check_failed";

export type SessionSituation = { status: SessionStatus; activity: SessionActivity };
export type SessionView = {
  /** Null when the account is verified and its content shows. */
  notice: SessionNotice | null;
  /** Show the signed-out invitation with Sign in and Create account. */
  invite: boolean;
  /** Offer "Check account". */
  canCheck: boolean;
  /** Something needs the person's attention, as opposed to a request that is simply under way. */
  warning: boolean;
};

/** The order of the checks is the priority. */
export function sessionView({ status, activity }: SessionSituation): SessionView {
  const view: SessionView = { notice: null, invite: false, canCheck: false, warning: false };
  if (status === "ready") return view;
  if (activity.kind === "signing_in")
    return { ...view, notice: activity.as === "sign-up" ? "creating_account" : "signing_in" };
  if (activity.kind === "signing_out") return { ...view, notice: "signing_out" };
  const canCheck = status === "error" || status === "unavailable";
  if (activity.kind === "sign_out_unconfirmed")
    return { ...view, notice: "sign_out_unconfirmed", canCheck, warning: true };
  if (status === "checking") return { ...view, notice: "checking" };
  if (status === "unavailable") return { ...view, notice: "unavailable", canCheck, warning: true };
  if (status === "signed_out") return { ...view, notice: "signed_out", invite: true, warning: true };
  return { ...view, notice: "check_failed", canCheck, warning: true };
}

/** The sentence a page shows in place of account content. `signedOut` names what signing in shows. */
export function sessionPageSentence(notice: SessionNotice, signedOut: string): string {
  switch (notice) {
    case "signing_in":
      return "Signing in… Account content is hidden while the request completes.";
    case "creating_account":
      return "Creating your account… Account content is hidden while the request completes.";
    case "signing_out":
      return "Signing out… Account content is hidden while the request completes.";
    case "sign_out_unconfirmed":
      return "Account content remains hidden until your session is verified.";
    case "checking":
      return "Checking your account…";
    case "unavailable":
      return "Account saving is unavailable. Check your connection and try again. Unsaved edits are kept in this tab.";
    case "signed_out":
      return signedOut;
    case "check_failed":
      return "Your account session could not be verified. Check your connection and try again.";
  }
}

/** The line at the top of the account menu while no account is shown. */
export function sessionMenuLine(notice: SessionNotice): string {
  switch (notice) {
    case "signing_in":
      return "Signing in…";
    case "creating_account":
      return "Creating account…";
    // The menu's Sign out row already says "Signing out…".
    case "signing_out":
    case "checking":
      return "Checking your account…";
    case "sign_out_unconfirmed":
      return "Sign-out didn’t finish. Try again, or check your account.";
    // Signed out, the pill shows Sign in and Create account instead of the menu.
    case "signed_out":
      return "You’re signed out.";
    case "unavailable":
    case "check_failed":
      return "Your account couldn’t be checked. Check your connection and try again.";
  }
}

/**
 * What a failed sign-in or account creation says about the session.
 *
 * "refused"     the server answered and signed nobody in: a wrong password, a failed security check, too
 *               many attempts. This is not a failed account check.
 * "unconfirmed" no answer, or one that cannot be trusted (network, timeout, server error): someone may
 *               have been signed in, so the account has to be checked before anything is shown.
 */
export function signInFailure(error: unknown): "refused" | "unconfirmed" {
  if (!(error instanceof SignInRequestError) && !(error instanceof SignUpRequestError)) return "unconfirmed";
  return error.status >= 400 && error.status < 500 && error.status !== 408 ? "refused" : "unconfirmed";
}
