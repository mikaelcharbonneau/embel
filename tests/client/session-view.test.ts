import { describe, expect, it } from "vitest";
import { SignInRequestError } from "@/components/auth/sign-in-request";
import { SignUpRequestError } from "@/components/auth/sign-up-request";
import {
  initialSessionMode,
  sessionMenuLine,
  sessionModeReducer,
  sessionPageSentence,
  sessionView,
  signInFailure,
  type SessionActivity,
  type SessionMode,
  type SessionModeEvent,
  type SessionStatus,
} from "@/components/workspace/session-view";

const idle: SessionActivity = { kind: "idle" };
const signingIn: SessionActivity = { kind: "signing_in", as: "sign-in", slow: false };
const creating: SessionActivity = { kind: "signing_in", as: "sign-up", slow: false };
const signingOut: SessionActivity = { kind: "signing_out" };
const signOutFailed: SessionActivity = { kind: "sign_out_unconfirmed", message: "Sign-out couldn’t be confirmed." };
const run = (events: SessionModeEvent[], from: SessionMode = initialSessionMode) =>
  events.reduce(sessionModeReducer, from);

describe("what a person is told about their account (J6)", () => {
  it("shows nothing over a verified account, whatever else is going on", () => {
    for (const activity of [idle, signingIn, signingOut, signOutFailed])
      expect(sessionView({ status: "ready", activity })).toEqual({
        notice: null,
        invite: false,
        canCheck: false,
        warning: false,
      });
  });

  it("puts a request under way before the status, and offers no Check account meanwhile", () => {
    for (const status of ["checking", "signed_out", "error", "unavailable"] as SessionStatus[]) {
      expect(sessionView({ status, activity: signingIn })).toMatchObject({ notice: "signing_in", canCheck: false });
      expect(sessionView({ status, activity: creating })).toMatchObject({ notice: "creating_account" });
      expect(sessionView({ status, activity: signingOut })).toMatchObject({
        notice: "signing_out",
        canCheck: false,
        invite: false,
        warning: false,
      });
    }
  });

  it("keeps sign-out recovery ahead of the status and offers Check account", () => {
    expect(sessionView({ status: "error", activity: signOutFailed })).toEqual({
      notice: "sign_out_unconfirmed",
      invite: false,
      canCheck: true,
      warning: true,
    });
  });

  it("reads the status when nothing else is going on", () => {
    expect(sessionView({ status: "checking", activity: idle })).toEqual({
      notice: "checking",
      invite: false,
      canCheck: false,
      warning: false,
    });
    expect(sessionView({ status: "unavailable", activity: idle })).toMatchObject({
      notice: "unavailable",
      canCheck: true,
      warning: true,
    });
    expect(sessionView({ status: "error", activity: idle })).toMatchObject({
      notice: "check_failed",
      canCheck: true,
      invite: false,
    });
    // Signed out is an invitation, never a failed check.
    expect(sessionView({ status: "signed_out", activity: idle })).toMatchObject({
      notice: "signed_out",
      invite: true,
      canCheck: false,
    });
  });

  it("has one sentence for a page and one line for the account menu", () => {
    expect(sessionPageSentence("signed_out", "Sign in to see your projects.")).toBe("Sign in to see your projects.");
    expect(sessionPageSentence("creating_account", "")).toBe(
      "Creating your account… Account content is hidden while the request completes.",
    );
    expect(sessionPageSentence("check_failed", "")).toBe(
      "Your account session could not be verified. Check your connection and try again.",
    );
    expect(sessionMenuLine("creating_account")).toBe("Creating account…");
    expect(sessionMenuLine("signing_out")).toBe("Checking your account…");
    expect(sessionMenuLine("sign_out_unconfirmed")).toBe("Sign-out didn’t finish. Try again, or check your account.");
    for (const notice of ["unavailable", "check_failed"] as const)
      expect(sessionMenuLine(notice)).toBe("Your account couldn’t be checked. Check your connection and try again.");
  });
});

describe("the session's activity", () => {
  it("does one thing at a time: creating an account is always a sign-in under way", () => {
    const state = run([{ type: "sign_in_started", as: "sign-up" }, { type: "sign_in_slow" }]);
    expect(state.activity).toEqual({ kind: "signing_in", as: "sign-up", slow: true });
    expect(run([{ type: "sign_in_finished", outcome: "failed" }], state).activity).toEqual(idle);
    // The slow notice of a request that already ended changes nothing.
    expect(run([{ type: "sign_in_slow" }])).toBe(initialSessionMode);
  });

  it("waits for the email link only after an account was created, until someone is signed in", () => {
    const waiting = run([
      { type: "sign_in_started", as: "sign-up" },
      { type: "sign_in_finished", outcome: "confirmation_required" },
    ]);
    expect(waiting).toEqual({ activity: idle, awaitingConfirmation: true });
    // A failed resend keeps waiting.
    expect(
      run(
        [
          { type: "sign_in_started", as: "sign-up" },
          { type: "sign_in_finished", outcome: "failed" },
        ],
        waiting,
      ).awaitingConfirmation,
    ).toBe(true);
    for (const event of [
      { type: "sign_in_finished", outcome: "signed_in" },
      { type: "account_verified" },
      { type: "sign_out_confirmed" },
      { type: "confirmation_dismissed" },
    ] as SessionModeEvent[])
      expect(run([event], waiting).awaitingConfirmation).toBe(false);
  });

  it("keeps sign-out recovery until sign-out is retried, a sign-in starts or the account is checked", () => {
    const failed = run([{ type: "sign_out_started" }, { type: "sign_out_unconfirmed", message: "Not confirmed." }]);
    expect(failed.activity).toEqual({ kind: "sign_out_unconfirmed", message: "Not confirmed." });
    expect(run([{ type: "check_started" }], failed).activity).toEqual(idle);
    expect(run([{ type: "sign_out_started" }], failed).activity).toEqual(signingOut);
    expect(run([{ type: "sign_in_started", as: "sign-in" }], failed).activity).toEqual(signingIn);
    // A check never interrupts a request.
    const busy = run([{ type: "sign_out_started" }]);
    expect(run([{ type: "check_started" }], busy)).toBe(busy);
  });
});

describe("what a failed sign-in says about the account", () => {
  it("treats an answer that signed nobody in as a refusal, not a failed account check", () => {
    for (const status of [400, 401, 403, 413, 422, 429]) {
      expect(signInFailure(new SignInRequestError(status))).toBe("refused");
      expect(signInFailure(new SignUpRequestError(status))).toBe("refused");
    }
  });
  it("treats no answer, a timeout or a server error as unknown", () => {
    for (const status of [408, 500, 502, 503])
      expect(signInFailure(new SignInRequestError(status))).toBe("unconfirmed");
    expect(signInFailure(new TypeError("Failed to fetch"))).toBe("unconfirmed");
    expect(signInFailure(undefined)).toBe("unconfirmed");
  });
});
