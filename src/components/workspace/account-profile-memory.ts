import { sameProfileValues, type AccountProfile, type AccountProfileValues } from "@/domain/account-profile";

type Account = { userId: string; generation: number };
export type ProfileWorkspace = {
  saved: AccountProfile;
  values: AccountProfileValues;
  latest: AccountProfile | null;
  // An interrupted write must be checked before another write is admitted.
  mustReload: boolean;
};
export function profileHasEdits(workspace: ProfileWorkspace) {
  return workspace.mustReload || !sameProfileValues(workspace.saved.values, workspace.values);
}

/** One private, in-memory edit buffer. Never persisted in browser storage. */
export function createAccountProfileMemory() {
  let bound: Account | null = null;
  let owner: string | null = null;
  let workspace: ProfileWorkspace | null = null;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const admits = (account: Account) => bound?.userId === account.userId && bound.generation === account.generation;
  return {
    bind(account: Account | null) {
      bound = account;
      if (account && owner !== account.userId) { owner = account.userId; workspace = null; }
      notify();
    },
    get: (account: Account) => admits(account) ? workspace : null,
    set(account: Account, next: ProfileWorkspace) {
      if (!admits(account) || next.saved.ownerId !== account.userId || (next.latest && next.latest.ownerId !== account.userId)) return false;
      workspace = { ...next, values: { ...next.values } }; notify(); return true;
    },
    clear() { workspace = null; owner = null; bound = null; notify(); },
    hasUnsaved: () => workspace !== null && profileHasEdits(workspace),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export function receiveAccountProfile(previous: ProfileWorkspace | null, saved: AccountProfile): ProfileWorkspace {
  if (!previous || !profileHasEdits(previous) || sameProfileValues(previous.values, saved.values)) {
    return { saved, values: saved.values, latest: null, mustReload: false };
  }
  if (previous.mustReload || previous.saved.revision !== saved.revision || previous.latest) {
    return { ...previous, latest: saved, mustReload: false };
  }
  return { ...previous, saved };
}
