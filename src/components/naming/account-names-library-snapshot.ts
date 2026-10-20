import type { VerifiedAccount } from "@/components/workspace/account-session";
import type { AccountNameEntry } from "@/domain/project-naming";

export type AccountNamesLibraryClient = {
  namesDrafts: object;
  isCurrent: (account: VerifiedAccount) => boolean;
  expire: (account: VerifiedAccount) => void;
};
type DisplaySnapshot = { items: readonly AccountNameEntry[]; hasMore: boolean; query: string; projectFilter: string };
let nextSnapshotKey = 0;

/** Passive tab-return presentation only. No cursor, request, intent or write authority. */
export function createAccountNamesLibrarySnapshot(account: VerifiedAccount, client: AccountNamesLibraryClient) {
  const owner = { ...account }, authority = { ...client };
  let display: DisplaySnapshot | null = null;
  function matches(current: VerifiedAccount, currentClient: AccountNamesLibraryClient) {
    return current.userId === owner.userId && current.generation === owner.generation &&
      currentClient.namesDrafts === authority.namesDrafts && currentClient.isCurrent === authority.isCurrent && currentClient.expire === authority.expire && authority.isCurrent(owner);
  }
  return {
    key: ++nextSnapshotKey,
    matches,
    read(current: VerifiedAccount, currentClient: AccountNamesLibraryClient) { return matches(current, currentClient) ? display : null; },
    remember(current: VerifiedAccount, currentClient: AccountNamesLibraryClient, next: DisplaySnapshot) {
      if (matches(current, currentClient)) display = { ...next, items: [...next.items] };
    },
    rememberView(current: VerifiedAccount, currentClient: AccountNamesLibraryClient, view: Pick<DisplaySnapshot, "query" | "projectFilter">) {
      if (display && matches(current, currentClient)) display = { ...display, ...view };
    },
    invalidate() { display = null; },
  };
}
export type AccountNamesLibrarySnapshot = ReturnType<typeof createAccountNamesLibrarySnapshot>;
