"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { accountProfileValuesSchema, type AccountProfileValues } from "@/domain/account-profile";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { AccountRequestError } from "./account-api";
import { loadProfile, saveProfile } from "./account-profile-client";
import { profileHasEdits, receiveAccountProfile, type ProfileWorkspace } from "./account-profile-memory";

type ProfileContext = {
  workspace: ProfileWorkspace | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  edit: (values: AccountProfileValues) => void;
  reload: () => void;
  save: () => void;
  discard: () => void;
  keepEdits: () => void;
};
const ProfileContext = createContext<ProfileContext | null>(null);
const emptyStatus = { busy: false, error: null, notice: null };

export function AccountProfileProvider({ children }: { children: React.ReactNode }) {
  const { session, profileDrafts, isCurrent, expire } = useAccountSession();
  const workspace = useSyncExternalStore(profileDrafts.subscribe, () => session.status === "ready" ? profileDrafts.get(session) : null, () => null);
  const [status, setStatus] = useState<{ generation: number; busy: boolean; error: string | null; notice: string | null }>({ generation: -1, ...emptyStatus });
  const request = useRef<AbortController | null>(null);

  const read = useCallback((account: VerifiedAccount) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setStatus({ generation: account.generation, busy: true, error: null, notice: null });
    void loadProfile(controller.signal).then(saved => {
      if (controller.signal.aborted || !isCurrent(account)) return;
      if (saved.ownerId !== account.userId) { expire(account); return; }
      const previous = profileDrafts.get(account);
      const next = receiveAccountProfile(previous, saved);
      profileDrafts.set(account, next);
      setStatus({ generation: account.generation, busy: false, error: null,
        notice: next.latest ? null : previous?.mustReload ? "Saved settings checked. The current saved values are shown." : null });
    }).catch(error => {
      if (controller.signal.aborted || !isCurrent(account)) return;
      if (error instanceof AccountRequestError && error.status === 401) { expire(account); return; }
      setStatus({ generation: account.generation, busy: false, notice: null, error: "Your profile could not be loaded. Your edits are kept in this tab. Check your connection and try again." });
    }).finally(() => { if (request.current === controller) request.current = null; });
  }, [profileDrafts, isCurrent, expire]);

  useEffect(() => {
    if (session.status !== "ready") return;
    // Defer startup to avoid synchronous effect-state writes. There is no mutation here.
    const timer = setTimeout(() => read(session), 0);
    return () => { clearTimeout(timer); request.current?.abort(); request.current = null; };
  }, [session, read]);

  const visibleStatus = session.status === "ready" && status.generation === session.generation ? status : { ...emptyStatus, busy: session.status === "ready" };
  function edit(values: AccountProfileValues) {
    if (session.status !== "ready" || !isCurrent(session) || visibleStatus.busy) return;
    const current = profileDrafts.get(session);
    if (!current || current.mustReload || current.latest) return;
    profileDrafts.set(session, { ...current, values });
    setStatus({ generation: session.generation, ...emptyStatus });
  }
  function save() {
    if (session.status !== "ready" || !isCurrent(session) || request.current || visibleStatus.busy) return;
    const account = session, current = profileDrafts.get(account);
    if (!current || current.mustReload || current.latest || !profileHasEdits(current)) return;
    const values = accountProfileValuesSchema.safeParse(current.values);
    if (!values.success) { setStatus({ generation: account.generation, ...emptyStatus, error: "Use a full name of up to 100 characters without control characters, and choose the supported date settings." }); return; }
    const controller = new AbortController(); request.current = controller;
    profileDrafts.set(account, { ...current, mustReload: true });
    setStatus({ generation: account.generation, busy: true, error: null, notice: "Saving your profile and preferences…" });
    void saveProfile(account, { expectedRevision: current.saved.revision, values: values.data }, controller.signal).then(saved => {
      if (controller.signal.aborted || !isCurrent(account)) return;
      if (saved.ownerId !== account.userId) { expire(account); return; }
      profileDrafts.set(account, { saved, values: saved.values, latest: null, mustReload: false });
      setStatus({ generation: account.generation, busy: false, error: null, notice: "Profile and date preferences saved to your account." });
    }).catch(error => {
      if (controller.signal.aborted || !isCurrent(account)) return;
      if (error instanceof AccountRequestError && error.status === 401) { expire(account); return; }
      const conflict = error instanceof AccountRequestError && error.status === 409;
      setStatus({ generation: account.generation, busy: false, notice: null,
        error: conflict ? "Your settings changed in another session. Check the saved settings before choosing which version to keep. Your edits are still here."
          : "Saving could not be confirmed. Your edits are still here. Check the saved settings before trying another save." });
    }).finally(() => { if (request.current === controller) request.current = null; });
  }
  function resolve(keep: boolean) {
    if (session.status !== "ready" || !isCurrent(session) || visibleStatus.busy) return;
    const current = profileDrafts.get(session);
    if (!current || current.mustReload) return;
    const saved = current.latest ?? current.saved;
    profileDrafts.set(session, { saved, values: keep ? current.values : saved.values, latest: null, mustReload: false });
    setStatus({ generation: session.generation, ...emptyStatus, notice: keep ? "Your edits are ready to save over the version shown." : "Saved settings loaded." });
  }
  return <ProfileContext.Provider value={{ workspace, ...visibleStatus, edit, reload: () => { if (session.status === "ready" && isCurrent(session) && !request.current) read(session); }, save, discard: () => resolve(false), keepEdits: () => resolve(true) }}>{children}</ProfileContext.Provider>;
}

/** Optional so standalone browser-only views keep their normal device date display. */
export function useAccountProfile() { return useContext(ProfileContext); }
