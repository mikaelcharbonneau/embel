import {
  initialSessionMode,
  isCreatingAccount,
  isSigningIn,
  sessionModeReducer,
  type SessionMode,
  type SessionModeEvent,
} from "@/components/workspace/session-view";

/** What the account is doing in a test's stand-in for `useAccountSession`, in a word. */
export type SessionDoing = "nothing" | "signing_in" | "creating_account" | "signing_out" | "sign_out_unconfirmed";

/** The small description a stand-in may carry; everything else it holds (session, drafts, isCurrent …) is passed on
 * untouched. Left out, the account is doing nothing and awaits no email link. */
type SessionStandInDescription = {
  doing?: SessionDoing;
  /** With "signing_in" or "creating_account": 30 seconds have passed without an answer. */
  slow?: boolean;
  /** An account was created and its email link has not been opened yet. */
  awaitingConfirmation?: boolean;
};

const UNCONFIRMED = "Sign-out couldn’t be confirmed.";

function events({ doing = "nothing", slow = false, awaitingConfirmation = false }: SessionStandInDescription) {
  const list: SessionModeEvent[] = [];
  if (awaitingConfirmation) {
    list.push({ type: "sign_in_started", as: "sign-up" });
    list.push({ type: "sign_in_finished", outcome: "confirmation_required" });
  }
  if (doing === "signing_in") list.push({ type: "sign_in_started", as: "sign-in" });
  if (doing === "creating_account") list.push({ type: "sign_in_started", as: "sign-up" });
  if (doing === "signing_out" || doing === "sign_out_unconfirmed") list.push({ type: "sign_out_started" });
  if (doing === "sign_out_unconfirmed") list.push({ type: "sign_out_unconfirmed", message: UNCONFIRMED });
  if (slow) list.push({ type: "sign_in_slow" });
  return list;
}

/** One mode per description, so a stand-in hands the same `activity` object to every render, as the provider does. */
const modes = new Map<string, SessionMode>();
function modeFor(description: SessionStandInDescription): SessionMode {
  const key = `${description.doing ?? "nothing"}|${Boolean(description.slow)}|${Boolean(description.awaitingConfirmation)}`;
  let mode = modes.get(key);
  if (!mode) {
    // The real reducer, fed the events the provider would send to get there.
    mode = events(description).reduce(sessionModeReducer, initialSessionMode);
    modes.set(key, mode);
  }
  return mode;
}

/** Completes a stand-in for `useAccountSession` with what the real provider reports about the account's activity
 * (`activity`, `awaitingConfirmation` and the two values read from them), from the real session machine, so a test
 * never writes an activity down by hand and a screen that asks about it never meets a stand-in without one. */
export function sessionStandIn<T extends object>(fixture: T & SessionStandInDescription) {
  const { doing, slow, awaitingConfirmation, ...rest } = fixture;
  const mode = modeFor({ doing, slow, awaitingConfirmation });
  return {
    ...(rest as Omit<T, keyof SessionStandInDescription>),
    activity: mode.activity,
    awaitingConfirmation: mode.awaitingConfirmation,
    signingIn: isSigningIn(mode.activity),
    signingUp: isCreatingAccount(mode.activity),
  };
}
