"use client";

import { createInspirationMemory } from "@/components/inspiration/inspiration-memory";
import { createVisualDirectionMemory } from "@/features/identity-directions/components/visual-direction-memory";
import { createProjectScreeningMemory } from "@/components/naming/project-screening-memory";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { z } from "zod";
import { accountSessionSchema } from "@/domain/project-api";
import { accountRequest, AccountRequestError } from "./account-api";
import { createAccountDraftMemory } from "./account-draft-memory";
import { createAccountProfileMemory } from "./account-profile-memory";
import { createIdentityDraftMemory } from "@/components/identity/identity-draft-memory";
import { createLogoDraftMemory, LogoDraftMemoryProvider } from "@/components/identity/logo-draft-memory";
import { createIdeaDraftMemory } from "@/components/ideas/ideas-draft-memory";
import { createStandaloneDraftMemory } from "@/components/tools/standalone-draft-memory";

import { createLifecycleIntentMemory } from "@/features/brand-lifecycle/intent-memory";
import { createLogoInputSession } from "@/features/logo-inputs/client/session";
import { createHomeInputSession } from "@/features/home-inputs/home-input-session";

type Session = { status: "checking" | "signed_out" | "unavailable" | "error"; generation: number } | { status: "ready"; userId: string; generation: number };
export type VerifiedAccount = Extract<Session, { status: "ready" }>;
type SignOutResult = { ok: true } | { ok: false; reason: "confirmation_required" | "pending" | "failed" };
type SignInResult = { ok: true; confirmationRequired?: true } | { ok: false; reason: "pending" } | { ok: false; reason: "failed"; error: unknown };
type AccountSession = {
  session: Session;
  refresh: () => void;
  expire: (account: VerifiedAccount) => void;
  isCurrent: (account: VerifiedAccount) => boolean;
  drafts: ReturnType<typeof createAccountDraftMemory>;
  profileDrafts: ReturnType<typeof createAccountProfileMemory>;
  inspirationDrafts: ReturnType<typeof createInspirationMemory>;
  visualDirectionDrafts: ReturnType<typeof createVisualDirectionMemory>;
  screeningDrafts: ReturnType<typeof createProjectScreeningMemory>;
  identityDrafts: ReturnType<typeof createIdentityDraftMemory>;
  logoDrafts: ReturnType<typeof createLogoDraftMemory>;
  ideaDrafts: ReturnType<typeof createIdeaDraftMemory>;
  standaloneDrafts: ReturnType<typeof createStandaloneDraftMemory>;
  lifecycleMemory: ReturnType<typeof createLifecycleIntentMemory>;
  homeInputSession: ReturnType<typeof createHomeInputSession>;
  logoInputSession: ReturnType<typeof createLogoInputSession>;
  signIn: (attempt: () => Promise<void | "confirmation_required">, mode?: "sign-in" | "sign-up") => Promise<SignInResult>;
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
  const [visualDirectionDrafts] = useState(createVisualDirectionMemory);
  const [screeningDrafts] = useState(createProjectScreeningMemory);
  const [identityDrafts] = useState(createIdentityDraftMemory);
  const [logoDrafts] = useState(createLogoDraftMemory);
  const [ideaDrafts] = useState(createIdeaDraftMemory);
  const [standaloneDrafts] = useState(createStandaloneDraftMemory);
  const [lifecycleMemory] = useState(createLifecycleIntentMemory);
  const [homeInputSession] = useState(createHomeInputSession);
  const [logoInputSession] = useState(createLogoInputSession);
  const [signingOut, setSigningOut] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [signingUp, setSigningUp] = useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const dismissConfirmation = useCallback(() => setAwaitingConfirmation(false), []);
  const [signInSlow, setSignInSlow] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const publish = useCallback((next: Session) => {
    // Fence the previous account before notifying private-memory subscribers.
    current.current = next;
    // Hide retained edits before any subscribers run. Reverification of the same
    // owner restores the buffer; binding a confirmed different owner clears it.
    inspirationDrafts.bind(next.status === "ready" ? next : null);
    visualDirectionDrafts.bind(next.status === "ready" ? next : null);
    screeningDrafts.bind(next.status === "ready" ? next : null);
    profileDrafts.bind(next.status === "ready" ? next : null);
    lifecycleMemory.bind(next.status === "ready" ? next : null);
    homeInputSession.bind(next.status === "ready" ? next : null);
    logoInputSession.bind(next.status === "ready" ? next : null);
    standaloneDrafts.bind(next.status === "ready" ? next : null);
    logoDrafts.bind(next.status === "ready" ? { ownerId: next.userId, generation: next.generation } : null);
    if (next.status === "ready") {
      if (previousOwner.current && previousOwner.current !== next.userId) { drafts.clear(); identityDrafts.clear(); ideaDrafts.clear(); }
      previousOwner.current = next.userId;
    }
    setSession(next);
  }, [drafts, profileDrafts, inspirationDrafts, visualDirectionDrafts, screeningDrafts, identityDrafts, logoDrafts, ideaDrafts, standaloneDrafts, lifecycleMemory, homeInputSession, logoInputSession]);
  const isCurrent = useCallback((account: VerifiedAccount) => current.current.status === "ready" && current.current.userId === account.userId && current.current.generation === account.generation, []);
  const refresh = useCallback(() => {
    if (signOutRequest.current || signInPending.current) return;
    suppressAutomaticRefresh.current = false;
    setSignOutError(null);
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const generation = current.current.generation + 1;
    publish({ status: "checking", generation });
    void accountRequest("/api/session", accountSessionSchema, { signal: controller.signal }).then(({ user }) => {
      if (!controller.signal.aborted && current.current.generation === generation) publish({ status: "ready", userId: user.id, generation });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || current.current.generation !== generation) return;
      publish({ status: error instanceof AccountRequestError && error.status === 401 ? "signed_out" : error instanceof AccountRequestError && error.status === 503 ? "unavailable" : "error", generation });
    });
  }, [publish]);
  const expire = useCallback((account: VerifiedAccount) => {
    if (!isCurrent(account)) return;
    request.current?.abort();
    publish({ status: "signed_out", generation: current.current.generation + 1 });
  }, [isCurrent, publish]);

  const signIn = useCallback(async (attempt: () => Promise<void | "confirmation_required">, mode: "sign-in" | "sign-up" = "sign-in"): Promise<SignInResult> => {
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
  }, [publish, refresh]);

  const signOut = useCallback(async (discardUnsaved = false): Promise<SignOutResult> => {
    if (signOutRequest.current || signInPending.current) return { ok: false, reason: "pending" };
    if ((drafts.hasUnsaved() || profileDrafts.hasUnsaved() || inspirationDrafts.hasUnsaved() || visualDirectionDrafts.hasUnsaved() || screeningDrafts.hasUnsaved() || identityDrafts.hasUnsaved() || logoDrafts.hasUnsaved() || ideaDrafts.hasUnsaved() || standaloneDrafts.hasUnsaved() || lifecycleMemory.hasUnsaved() || homeInputSession.hasUnsaved() || logoInputSession.hasUnsaved()) && !discardUnsaved) return { ok: false, reason: "confirmation_required" };
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
      await accountRequest("/api/auth/sign-out", signedOutSchema, { method: "POST", body: {}, signal: controller.signal });
      if (signOutRequest.current !== controller) return { ok: false, reason: "failed" };
      if (controller.signal.aborted) throw new Error("Sign-out request interrupted");
      drafts.clear();
      profileDrafts.clear();
      inspirationDrafts.clear();
      visualDirectionDrafts.clear();
      screeningDrafts.clear();
      identityDrafts.clear();
      logoDrafts.clear();
      ideaDrafts.clear();
      standaloneDrafts.clear();
      lifecycleMemory.clear();
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
      setSignOutError("Sign-out couldn't be confirmed. Account content is hidden and unsaved account edits remain in this tab. Retry sign-out, or use Check account to verify your session.");
      return { ok: false, reason: "failed" };
    } finally {
      window.clearTimeout(timeout);
      if (signOutRequest.current === controller) { signOutRequest.current = null; setSigningOut(false); }
    }
  }, [drafts, profileDrafts, inspirationDrafts, visualDirectionDrafts, screeningDrafts, identityDrafts, logoDrafts, ideaDrafts, standaloneDrafts, lifecycleMemory, homeInputSession, logoInputSession, publish]);

  useEffect(() => {
    // Start asynchronously so all private consumers share this one verification.
    const automaticRefresh = () => { if (!suppressAutomaticRefresh.current && !signOutRequest.current && !signInPending.current) refresh(); };
    const startup = window.setTimeout(automaticRefresh, 0);
    const onVisible = () => { if (document.visibilityState === "visible") automaticRefresh(); };
    const retainEdits = (event: BeforeUnloadEvent) => { if (drafts.hasUnsaved() || profileDrafts.hasUnsaved() || inspirationDrafts.hasUnsaved() || visualDirectionDrafts.hasUnsaved() || screeningDrafts.hasUnsaved() || identityDrafts.hasUnsaved() || logoDrafts.hasUnsaved() || ideaDrafts.hasUnsaved() || standaloneDrafts.hasUnsaved() || lifecycleMemory.hasUnsaved() || homeInputSession.hasUnsaved() || logoInputSession.hasUnsaved()) event.preventDefault(); };
    window.addEventListener("focus", automaticRefresh);
    window.addEventListener("beforeunload", retainEdits);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(startup);
      window.removeEventListener("focus", automaticRefresh);
      window.removeEventListener("beforeunload", retainEdits);
      document.removeEventListener("visibilitychange", onVisible);
      request.current?.abort();
      signOutRequest.current?.abort();
      signOutRequest.current = null;
    };
  }, [refresh, drafts, profileDrafts, inspirationDrafts, visualDirectionDrafts, screeningDrafts, identityDrafts, logoDrafts, ideaDrafts, standaloneDrafts, lifecycleMemory, homeInputSession, logoInputSession]);

  return <SessionContext.Provider value={{ session, refresh, expire, isCurrent, drafts, profileDrafts, inspirationDrafts, visualDirectionDrafts, screeningDrafts, identityDrafts, logoDrafts, ideaDrafts, standaloneDrafts, lifecycleMemory, homeInputSession, logoInputSession, signIn, signingIn, signingUp, awaitingConfirmation, dismissConfirmation, signInSlow, signOut, signingOut, signOutError }}><LogoDraftMemoryProvider memory={logoDrafts}>{children}</LogoDraftMemoryProvider></SessionContext.Provider>;
}

export function useAccountSession() {
  const account = useContext(SessionContext);
  if (!account) throw new Error("Account session provider is required.");
  return account;
}

export function AccountStatus({ retainedEdits = false }: { retainedEdits?: boolean }) {
  const { session, signingIn, signingUp, signingOut, signOutError } = useAccountSession();
  if (session.status === "ready") return null;
  const message = signingIn ? `${signingUp ? "Creating your account" : "Signing in"}… Account content is hidden while the request completes.` : signingOut ? "Signing out… Account content is hidden while the request completes." : signOutError ? "Account content remains hidden until your session is verified." : session.status === "checking" ? "Checking your account…" : session.status === "unavailable" ? "Account saving is unavailable. Browser drafts remain available." : session.status === "signed_out" ? "No verified account session. Sign in to view your account projects." : "Your account session could not be verified. Check your connection and try again.";
  return <div className="account-notice" role="status"><p>{message}</p>{session.status === "signed_out" && <Link className="text-link" href="/sign-in">Sign in</Link>}{retainedEdits && <p>Unsaved account edits are held in this tab. Check your account after restoring the same session to recover them.</p>}</div>;
}
