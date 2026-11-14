"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { accountProfileValuesSchema, sameProfileValues, type AccountProfileValues } from "@/domain/account-profile";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { AccountRequestError } from "./account-api";
import { loadProfile, saveProfile } from "./account-profile-client";
import { profileHasEdits, receiveAccountProfile, type ProfileWorkspace } from "./account-profile-memory";

type ProfileContext = {
  workspace: ProfileWorkspace | null;
  /** Reading or saving. Reading locks the fields; edits made while a save runs are kept for the next save. */
  busy: boolean;
  /** A save request is in flight. */
  saving: boolean;
  /** The server confirmed the values shown. Cleared by the next edit. */
  confirmed: boolean;
  error: string | null;
  edit: (values: AccountProfileValues) => void;
  /** Reads the stored settings; after a failed save this is "Try again" (an unlanded save then runs again). */
  reload: () => void;
  save: () => void;
  discard: () => void;
  keepEdits: () => void;
};
const ProfileContext = createContext<ProfileContext | null>(null);
const emptyStatus = { busy: false, saving: false, confirmed: false, error: null };
export const PROFILE_SAVE_FAILED = "Couldn’t save. Check your connection.";

export function AccountProfileProvider({ children }: { children: React.ReactNode }) {
  const { session, profileDrafts, isCurrent, expire } = useAccountSession();
  const workspace = useSyncExternalStore(
    profileDrafts.subscribe,
    () => (session.status === "ready" ? profileDrafts.get(session) : null),
    () => null,
  );
  const [status, setStatus] = useState<{
    generation: number;
    busy: boolean;
    saving: boolean;
    confirmed: boolean;
    error: string | null;
  }>({ generation: -1, ...emptyStatus });
  const request = useRef<AbortController | null>(null);
  // The controller of the save in flight, if any.
  const saving = useRef<AbortController | null>(null);

  const read = useCallback(
    (account: VerifiedAccount) => {
      request.current?.abort();
      saving.current = null;
      const controller = new AbortController();
      request.current = controller;
      setStatus({ generation: account.generation, ...emptyStatus, busy: true });
      void loadProfile(controller.signal)
        .then((saved) => {
          if (controller.signal.aborted || !isCurrent(account)) return;
          if (saved.ownerId !== account.userId) {
            expire(account);
            return;
          }
          const previous = profileDrafts.get(account);
          const next = receiveAccountProfile(previous, saved);
          profileDrafts.set(account, next);
          setStatus({
            generation: account.generation,
            ...emptyStatus,
            // An interrupted save that the read shows was stored is confirmed by the server.
            confirmed: Boolean(previous?.mustReload && !profileHasEdits(next)),
          });
        })
        .catch((error) => {
          if (controller.signal.aborted || !isCurrent(account)) return;
          if (error instanceof AccountRequestError && error.status === 401) {
            expire(account);
            return;
          }
          setStatus({
            generation: account.generation,
            ...emptyStatus,
            error: "Your profile couldn’t be loaded. Check your connection, then try again.",
          });
        })
        .finally(() => {
          if (request.current === controller) request.current = null;
        });
    },
    [profileDrafts, isCurrent, expire],
  );

  useEffect(() => {
    if (session.status !== "ready") return;
    // Defer startup to avoid synchronous effect-state writes. There is no mutation here.
    const timer = setTimeout(() => read(session), 0);
    return () => {
      clearTimeout(timer);
      request.current?.abort();
      request.current = null;
      saving.current = null;
    };
  }, [session, read]);

  const visibleStatus =
    session.status === "ready" && status.generation === session.generation
      ? status
      : { ...emptyStatus, busy: session.status === "ready" };
  function edit(values: AccountProfileValues) {
    if (session.status !== "ready" || !isCurrent(session) || (visibleStatus.busy && !saving.current)) return;
    const current = profileDrafts.get(session);
    if (!current || current.latest) return;
    profileDrafts.set(session, { ...current, values });
    // A running save keeps its status; a failed one keeps its message until "Try again".
    if (!saving.current && !current.mustReload) setStatus({ generation: session.generation, ...emptyStatus });
  }
  function save() {
    if (session.status !== "ready" || !isCurrent(session) || request.current || visibleStatus.busy) return;
    const account = session,
      current = profileDrafts.get(account);
    if (!current || current.mustReload || current.latest || !profileHasEdits(current)) return;
    const values = accountProfileValuesSchema.safeParse(current.values);
    if (!values.success) {
      setStatus({
        generation: account.generation,
        ...emptyStatus,
        error: "Use a full name of up to 100 characters, without control characters.",
      });
      return;
    }
    const sent = values.data;
    const controller = new AbortController();
    request.current = controller;
    saving.current = controller;
    profileDrafts.set(account, { ...current, mustReload: true });
    setStatus({ generation: account.generation, ...emptyStatus, busy: true, saving: true });
    void saveProfile(account, { expectedRevision: current.saved.revision, values: sent }, controller.signal)
      .then((saved) => {
        if (controller.signal.aborted || !isCurrent(account)) return;
        if (saved.ownerId !== account.userId) {
          expire(account);
          return;
        }
        // Edits typed while the save ran stay in memory for the next save.
        const draft = profileDrafts.get(account)?.values;
        const values = draft && !sameProfileValues(draft, sent) ? draft : saved.values;
        profileDrafts.set(account, { saved, values, latest: null, mustReload: false });
        setStatus({ generation: account.generation, ...emptyStatus, confirmed: true });
      })
      .catch((error) => {
        if (controller.signal.aborted || !isCurrent(account)) return;
        if (error instanceof AccountRequestError && error.status === 401) {
          expire(account);
          return;
        }
        if (error instanceof AccountRequestError && error.status === 409) {
          // Changed in another session: read the stored version so the choice can be shown.
          if (request.current === controller) request.current = null;
          read(account);
          return;
        }
        // The edits stay; "Try again" reads first, so a save that did land is never sent twice.
        setStatus({ generation: account.generation, ...emptyStatus, error: PROFILE_SAVE_FAILED });
      })
      .finally(() => {
        if (request.current === controller) request.current = null;
        if (saving.current === controller) saving.current = null;
      });
  }
  function resolve(keep: boolean) {
    if (session.status !== "ready" || !isCurrent(session) || visibleStatus.busy) return;
    const current = profileDrafts.get(session);
    if (!current || current.mustReload) return;
    const saved = current.latest ?? current.saved;
    profileDrafts.set(session, {
      saved,
      values: keep ? current.values : saved.values,
      latest: null,
      mustReload: false,
    });
    setStatus({ generation: session.generation, ...emptyStatus });
  }
  return (
    <ProfileContext.Provider
      value={{
        workspace,
        ...visibleStatus,
        edit,
        reload: () => {
          if (session.status === "ready" && isCurrent(session) && !request.current) read(session);
        },
        save,
        discard: () => resolve(false),
        keepEdits: () => resolve(true),
      }}
    >
      {children}
    </ProfileContext.Provider>
  );
}

/** Optional so standalone browser-only views keep their normal device date display. */
export function useAccountProfile() {
  return useContext(ProfileContext);
}
