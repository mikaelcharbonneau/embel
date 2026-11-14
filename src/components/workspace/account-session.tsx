"use client";

import { createInspirationMemory } from "@/components/inspiration/inspiration-memory";
import { createNamingBrainMemory } from "@/components/naming/naming-brain-memory";
import { createProjectScreeningMemory } from "@/components/naming/project-screening-memory";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { accountSessionSchema } from "@/domain/project-api";
import { accountRequest, AccountRequestError } from "./account-api";
import { SESSION_STATE_HEADER } from "@/components/auth/session-state";
import { SignedOutActions } from "@/components/auth/signed-out-actions";
import { createAccountDraftMemory } from "./account-draft-memory";
import { createAccountProfileMemory } from "./account-profile-memory";
import { createAccountViewCache, type AccountViewCache } from "./account-view-cache";
import { createIdentityDraftMemory } from "@/components/identity/identity-draft-memory";
import { createLogoDraftMemory, LogoDraftMemoryProvider } from "@/components/identity/logo-draft-memory";

import { createLogoInputSession } from "@/features/logo-inputs/client/session";
import { createHomeInputSession } from "@/features/home-inputs/home-input-session";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { InlineMessage } from "@/components/ui/message";

type Session =
  | { status: "checking" | "signed_out" | "unavailable" | "error"; generation: number }
  | { status: "ready"; userId: string; generation: number };
export type VerifiedAccount = Extract<Session, { status: "ready" }>;
type SignOutResult = { ok: true } | { ok: false; reason: "confirmation_required" | "pending" | "failed" };
type SignInResult =
  | { ok: true; confirmationRequired?: true }
  | { ok: false; reason: "pending" }
  | { ok: false; reason: "failed"; error: unknown };
type AccountSession = {
  session: Session;
  refresh: () => void;
  expire: (account: VerifiedAccount) => void;
  isCurrent: (account: VerifiedAccount) => boolean;
  drafts: ReturnType<typeof createAccountDraftMemory>;
  profileDrafts: ReturnType<typeof createAccountProfileMemory>;
  inspirationDrafts: ReturnType<typeof createInspirationMemory>;
  screeningDrafts: ReturnType<typeof createProjectScreeningMemory>;
  namingBrainDrafts: ReturnType<typeof createNamingBrainMemory>;
  identityDrafts: ReturnType<typeof createIdentityDraftMemory>;
  logoDrafts: ReturnType<typeof createLogoDraftMemory>;
  homeInputSession: ReturnType<typeof createHomeInputSession>;
  logoInputSession: ReturnType<typeof createLogoInputSession>;
  /** What the account's lists last showed (D-073). Optional so isolated renders can leave it out. */
  viewCache?: AccountViewCache;
  signIn: (
    attempt: () => Promise<void | "confirmation_required">,
    mode?: "sign-in" | "sign-up",
  ) => Promise<SignInResult>;
  signingIn: boolean;
  signingUp: boolean;
  awaitingConfirmation: boolean;
  dismissConfirmation: () => void;
  signInSlow: boolean;
  signOut: (discardUnsaved?: boolean) => Promise<SignOutResult>;
  signingOut: boolean;
  signOutError: string | null;
};
const initialSession: Session = { status: "checking", generation: 0 };
const SessionContext = createContext<AccountSession | null>(null);
const signedOutSchema = z.strictObject({ authenticated: z.literal(false) });
const sessionStateSchema = z.union([accountSessionSchema, signedOutSchema]);
type SessionState = z.infer<typeof sessionStateSchema>;

/** The shell's own session check, bounded like other account reads. It opts in
 * to the server's ordinary signed-out answer; a 401 still means signed out. */
function readSessionState(signal: AbortSignal): Promise<SessionState> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const controller = new AbortController();
  return new Promise<SessionState>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      action();
    };
    const abort = () => {
      finish(() => reject(signal.reason));
      controller.abort(signal.reason);
    };
    const timer = setTimeout(() => {
      finish(() => reject(new AccountRequestError(408)));
      controller.abort();
    }, 30_000);
    signal.addEventListener("abort", abort, { once: true });
    void fetch("/api/session", {
      method: "GET",
      credentials: "same-origin",
      mode: "same-origin",
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json", [SESSION_STATE_HEADER]: "1" },
    })
      .then(async (response) => {
        if (!response.ok) throw new AccountRequestError(response.status);
        const parsed = sessionStateSchema.safeParse(await response.json().catch(() => undefined));
        if (!parsed.success) throw new AccountRequestError(502);
        return parsed.data;
      })
      .then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
  });
}
const failureStatus = (error: unknown): "signed_out" | "unavailable" | "error" =>
  error instanceof AccountRequestError && error.status === 401
    ? "signed_out"
    : error instanceof AccountRequestError && error.status === 503
      ? "unavailable"
      : "error";

export function AccountSessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session>(initialSession);
  const current = useRef<Session>(initialSession);
  const request = useRef<AbortController | null>(null);
  const signOutRequest = useRef<AbortController | null>(null);
  const signInPending = useRef(false);
  const suppressAutomaticRefresh = useRef(false);
  const previousOwner = useRef<string | null>(null);
  const [drafts] = useState(createAccountDraftMemory);
  const [profileDrafts] = useState(createAccountProfileMemory);
  const [inspirationDrafts] = useState(createInspirationMemory);
  const [screeningDrafts] = useState(createProjectScreeningMemory);
  const [namingBrainDrafts] = useState(createNamingBrainMemory);
  const [identityDrafts] = useState(createIdentityDraftMemory);
  const [logoDrafts] = useState(createLogoDraftMemory);
  const [homeInputSession] = useState(createHomeInputSession);
  const [logoInputSession] = useState(createLogoInputSession);
  const [viewCache] = useState(createAccountViewCache);
  const [signingOut, setSigningOut] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [signingUp, setSigningUp] = useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const dismissConfirmation = useCallback(() => setAwaitingConfirmation(false), []);
  const [signInSlow, setSignInSlow] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const publish = useCallback(
    (next: Session) => {
      // Fence the previous account before notifying private-memory subscribers.
      current.current = next;
      // Hide retained edits before any subscribers run. Reverification of the same
      // owner restores the buffer; binding a confirmed different owner clears it.
      inspirationDrafts.bind(next.status === "ready" ? next : null);
      screeningDrafts.bind(next.status === "ready" ? next : null);
      namingBrainDrafts.bind(next.status === "ready" ? next : null);
      profileDrafts.bind(next.status === "ready" ? next : null);
      homeInputSession.bind(next.status === "ready" ? next : null);
      logoInputSession.bind(next.status === "ready" ? next : null);
      logoDrafts.bind(next.status === "ready" ? { ownerId: next.userId, generation: next.generation } : null);
      viewCache.bind(next.status === "ready" ? next : null);
      if (next.status === "ready") {
        if (previousOwner.current && previousOwner.current !== next.userId) {
          drafts.clear();
          identityDrafts.clear();
        }
        previousOwner.current = next.userId;
      }
      setSession(next);
    },
    [
      drafts,
      profileDrafts,
      inspirationDrafts,
      screeningDrafts,
      namingBrainDrafts,
      identityDrafts,
      logoDrafts,
      homeInputSession,
      logoInputSession,
      viewCache,
    ],
  );
  const isCurrent = useCallback(
    (account: VerifiedAccount) =>
      current.current.status === "ready" &&
      current.current.userId === account.userId &&
      current.current.generation === account.generation,
    [],
  );
  const refresh = useCallback(() => {
    if (signOutRequest.current || signInPending.current) return;
    suppressAutomaticRefresh.current = false;
    setSignOutError(null);
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const generation = current.current.generation + 1;
    publish({ status: "checking", generation });
    void readSessionState(controller.signal)
      .then((state) => {
        if (controller.signal.aborted || current.current.generation !== generation) return;
        if ("authenticated" in state) {
          publish({ status: "signed_out", generation });
          return;
        }
        publish({ status: "ready", userId: state.user.id, generation });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || current.current.generation !== generation) return;
        publish({ status: failureStatus(error), generation });
      })
      .finally(() => {
        if (request.current === controller) request.current = null;
      });
  }, [publish]);
  // A routine focus check must not tear down an already verified workspace.
  // Every API still authenticates its own request and checks the expected owner.
  // Explicit authentication changes retain the hard privacy fence in refresh/signIn/signOut.
  const revalidate = useCallback(() => {
    const before = current.current;
    if (before.status !== "ready") {
      refresh();
      return;
    }
    if (signOutRequest.current || signInPending.current) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    void readSessionState(controller.signal)
      .then((state) => {
        if (controller.signal.aborted || request.current !== controller || current.current !== before) return;
        if ("authenticated" in state) {
          publish({ status: "signed_out", generation: before.generation + 1 });
          return;
        }
        const { user } = state;
        if (user.id !== before.userId) publish({ status: "ready", userId: user.id, generation: before.generation + 1 });
        // Same owner: preserve the object, generation, drafts, focus and scroll.
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || request.current !== controller || current.current !== before) return;
        publish({ status: failureStatus(error), generation: before.generation + 1 });
      })
      .finally(() => {
        if (request.current === controller) request.current = null;
      });
  }, [publish, refresh]);
  const expire = useCallback(
    (account: VerifiedAccount) => {
      if (!isCurrent(account)) return;
      request.current?.abort();
      publish({ status: "signed_out", generation: current.current.generation + 1 });
    },
    [isCurrent, publish],
  );

  useEffect(() => {
    namingBrainDrafts.setUnauthorized((account) => expire({ ...account, status: "ready" }));
  }, [namingBrainDrafts, expire]);

  const signIn = useCallback(
    async (
      attempt: () => Promise<void | "confirmation_required">,
      mode: "sign-in" | "sign-up" = "sign-in",
    ): Promise<SignInResult> => {
      if (signInPending.current || signOutRequest.current) return { ok: false, reason: "pending" };
      signInPending.current = true;
      suppressAutomaticRefresh.current = true;
      request.current?.abort();
      const generation = current.current.generation + 1;
      publish({ status: "checking", generation });
      setSigningIn(true);
      setSigningUp(mode === "sign-up");
      setSignInSlow(false);
      setSignOutError(null);
      const slowNotice = window.setTimeout(() => setSignInSlow(true), 30_000);
      let result: SignInResult;
      try {
        // Hold admission until the POST settles, even if the form unmounts. Aborting or
        // ignoring its callback cannot safely order the response's cookie side effect.
        const outcome = await attempt();
        if (outcome === "confirmation_required") {
          // An accepted signup is not a session. Retain the privacy fence until
          // explicit verification or a later successful sign-in; never expose an
          // earlier account whose cookies may still exist in this browser.
          setAwaitingConfirmation(true);
          publish({ status: "signed_out", generation });
          result = { ok: true, confirmationRequired: true };
        } else {
          setAwaitingConfirmation(false);
          result = { ok: true };
        }
      } catch (error: unknown) {
        publish({ status: "error", generation });
        result = { ok: false, reason: "failed", error };
      } finally {
        window.clearTimeout(slowNotice);
        signInPending.current = false;
        setSigningIn(false);
        setSigningUp(false);
        setSignInSlow(false);
      }
      if (result.ok && !result.confirmationRequired) refresh();
      return result;
    },
    [publish, refresh],
  );

  const signOut = useCallback(
    async (discardUnsaved = false): Promise<SignOutResult> => {
      if (signOutRequest.current || signInPending.current) return { ok: false, reason: "pending" };
      if (
        (drafts.hasUnsaved() ||
          profileDrafts.hasUnsaved() ||
          inspirationDrafts.hasUnsaved() ||
          screeningDrafts.hasUnsaved() ||
          namingBrainDrafts.hasUnsaved() ||
          identityDrafts.hasUnsaved() ||
          logoDrafts.hasUnsaved() ||
          homeInputSession.hasUnsaved() ||
          logoInputSession.hasUnsaved()) &&
        !discardUnsaved
      )
        return { ok: false, reason: "confirmation_required" };
      request.current?.abort();
      const controller = new AbortController();
      signOutRequest.current = controller;
      suppressAutomaticRefresh.current = true;
      const generation = current.current.generation + 1;
      // isCurrent() stops accepting outstanding private responses in this same event turn.
      publish({ status: "checking", generation });
      setSigningOut(true);
      setSignOutError(null);
      const timeout = window.setTimeout(() => controller.abort(), 30_000);
      try {
        await accountRequest("/api/auth/sign-out", signedOutSchema, {
          method: "POST",
          body: {},
          signal: controller.signal,
        });
        if (signOutRequest.current !== controller) return { ok: false, reason: "failed" };
        if (controller.signal.aborted) throw new Error("Sign-out request interrupted");
        drafts.clear();
        profileDrafts.clear();
        inspirationDrafts.clear();
        screeningDrafts.clear();
        namingBrainDrafts.clear();
        identityDrafts.clear();
        logoDrafts.clear();
        homeInputSession.clear();
        logoInputSession.clear();
        previousOwner.current = null;
        setAwaitingConfirmation(false);
        suppressAutomaticRefresh.current = false;
        publish({ status: "signed_out", generation });
        return { ok: true };
      } catch {
        if (signOutRequest.current !== controller) return { ok: false, reason: "failed" };
        // Keep both the privacy fence and the owner's edits until an explicit recovery action.
        publish({ status: "error", generation });
        setSignOutError(
          "Sign-out couldn’t be confirmed. Your account content stays hidden and unsaved edits remain in this tab. Retry sign-out, or use Check account in the account menu.",
        );
        return { ok: false, reason: "failed" };
      } finally {
        window.clearTimeout(timeout);
        if (signOutRequest.current === controller) {
          signOutRequest.current = null;
          setSigningOut(false);
        }
      }
    },
    [
      drafts,
      profileDrafts,
      inspirationDrafts,
      screeningDrafts,
      namingBrainDrafts,
      identityDrafts,
      logoDrafts,
      homeInputSession,
      logoInputSession,
      publish,
    ],
  );

  useEffect(() => {
    // Start asynchronously so all private consumers share this one verification.
    // Focus and visibility commonly arrive together. Only events within one
    // activation share a pending check; leaving the tab invalidates its read so
    // a later return cannot restore an account verified before a cookie change.
    // Startup/explicit reads while inactive cannot consume that return fence.
    let needsActivationCheck = document.visibilityState === "hidden";
    const automaticRefresh = (activation = false) => {
      if (suppressAutomaticRefresh.current || signOutRequest.current || signInPending.current) return;
      if (request.current && !request.current.signal.aborted && !(activation && needsActivationCheck)) return;
      if (activation) needsActivationCheck = false;
      if (activation) revalidate();
      else refresh();
    };
    const onInactive = () => {
      needsActivationCheck = true;
      request.current?.abort();
    };
    const onFocus = () => {
      if (document.visibilityState === "visible") automaticRefresh(true);
    };
    const startup = window.setTimeout(() => automaticRefresh(), 0);
    const onVisible = () => {
      if (document.visibilityState === "visible") automaticRefresh(true);
      else onInactive();
    };
    const retainEdits = (event: BeforeUnloadEvent) => {
      if (
        drafts.hasUnsaved() ||
        profileDrafts.hasUnsaved() ||
        inspirationDrafts.hasUnsaved() ||
        screeningDrafts.hasUnsaved() ||
        namingBrainDrafts.hasUnsaved() ||
        identityDrafts.hasUnsaved() ||
        logoDrafts.hasUnsaved() ||
        homeInputSession.hasUnsaved() ||
        logoInputSession.hasUnsaved()
      )
        event.preventDefault();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onInactive);
    window.addEventListener("beforeunload", retainEdits);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(startup);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onInactive);
      window.removeEventListener("beforeunload", retainEdits);
      document.removeEventListener("visibilitychange", onVisible);
      namingBrainDrafts.bind(null);
      viewCache.clear();
      request.current?.abort();
      signOutRequest.current?.abort();
      signOutRequest.current = null;
    };
  }, [
    refresh,
    revalidate,
    drafts,
    profileDrafts,
    inspirationDrafts,
    screeningDrafts,
    namingBrainDrafts,
    identityDrafts,
    logoDrafts,
    homeInputSession,
    logoInputSession,
    viewCache,
  ]);

  return (
    <SessionContext.Provider
      value={{
        session,
        refresh,
        expire,
        isCurrent,
        drafts,
        profileDrafts,
        inspirationDrafts,
        screeningDrafts,
        namingBrainDrafts,
        identityDrafts,
        logoDrafts,
        homeInputSession,
        logoInputSession,
        viewCache,
        signIn,
        signingIn,
        signingUp,
        awaitingConfirmation,
        dismissConfirmation,
        signInSlow,
        signOut,
        signingOut,
        signOutError,
      }}
    >
      <LogoDraftMemoryProvider memory={logoDrafts}>{children}</LogoDraftMemoryProvider>
    </SessionContext.Provider>
  );
}

export function useAccountSession() {
  const account = useContext(SessionContext);
  if (!account) throw new Error("Account session provider is required.");
  return account;
}

/** Shared account state for pages that need a signed-in account. Signed out,
 * it invites the visitor in; `signedOut` names what signing in shows, for
 * example "Sign in to see your projects." */
export function AccountStatus({
  retainedEdits = false,
  signedOut = "Sign in to see and save your work.",
}: {
  retainedEdits?: boolean;
  signedOut?: string;
}) {
  const { session, refresh, signingIn, signingUp, signingOut, signOutError } = useAccountSession();
  const retryGeneration = useRef<number | null>(null);
  if (session.status === "ready") return null;
  const canRetry = (session.status === "error" || session.status === "unavailable") && !signingIn && !signingOut;
  function checkAccount() {
    // Guard repeated activation before React renders the checking state. Only
    // the existing session refresh can verify identity or release private views.
    if (!canRetry || retryGeneration.current === session.generation) return;
    retryGeneration.current = session.generation;
    refresh();
  }
  const invite = session.status === "signed_out" && !signingIn && !signingOut && !signOutError;
  const message = signingIn
    ? `${signingUp ? "Creating your account" : "Signing in"}… Account content is hidden while the request completes.`
    : signingOut
      ? "Signing out… Account content is hidden while the request completes."
      : signOutError
        ? "Account content remains hidden until your session is verified."
        : session.status === "checking"
          ? "Checking your account…"
          : session.status === "unavailable"
            ? "Account saving is unavailable. Check your connection and try again. Unsaved edits are kept in this tab."
            : invite
              ? signedOut
              : "Your account session could not be verified. Check your connection and try again.";
  if (invite)
    return (
      <EmptyState
        icon="lock"
        title={signedOut.replace(/\.$/u, "")}
        text="Your brands, logos and files are saved in your account."
        action={<SignedOutActions placement="page" />}
      />
    );
  return (
    <InlineMessage
      tone={signOutError || (session.status !== "checking" && !signingIn && !signingOut) ? "warning" : "neutral"}
      actions={
        canRetry ? (
          <Button size="sm" onClick={checkAccount}>
            Check account
          </Button>
        ) : undefined
      }
    >
      <p>{message}</p>
      {retainedEdits && (
        <p>
          Unsaved account edits are held in this tab. Check your account after restoring the same session to recover
          them.
        </p>
      )}
    </InlineMessage>
  );
}
