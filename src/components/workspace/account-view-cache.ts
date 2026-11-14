/**
 * What the account's lists last showed, kept in memory for this tab only, so returning to Home, Projects or a card
 * shows it at once while a quiet refresh runs (D-073). Entries belong to one verified owner and session generation:
 * binding any other session (sign-out, another account, a reverified session with a new generation) drops them and
 * releases every private preview URL they hold. Nothing here is written to storage.
 */
type Release = () => void;
type Entry = { value: unknown; release?: Release };

const LIMIT = 200;

export function createAccountViewCache() {
  let scope: string | null = null;
  const entries = new Map<string, Entry>();

  function drop(key: string) {
    const entry = entries.get(key);
    entries.delete(key);
    entry?.release?.();
  }
  function clear() {
    for (const key of [...entries.keys()]) drop(key);
  }
  const keyFor = (account: { userId: string; generation: number }, key: string) =>
    `${account.userId}:${account.generation}:${key}`;
  const inScope = (account: { userId: string; generation: number }) =>
    scope === `${account.userId}:${account.generation}`;

  return {
    /** Called whenever the session changes; anything kept for another session is released. */
    bind(account: { userId: string; generation: number } | null) {
      const next = account ? `${account.userId}:${account.generation}` : null;
      if (next === scope) return;
      scope = next;
      clear();
    },
    get<T>(account: { userId: string; generation: number }, key: string): T | undefined {
      if (!inScope(account)) return undefined;
      const full = keyFor(account, key);
      const entry = entries.get(full);
      if (!entry) return undefined;
      // Most recently used last, so the oldest entry is released first when the cache is full.
      entries.delete(full);
      entries.set(full, entry);
      return entry.value as T;
    },
    /** Keeps `value`; `release` frees what it holds (a private object URL) when it is replaced or dropped. A value
     * for a session that is no longer bound is released at once and not kept. */
    set(account: { userId: string; generation: number }, key: string, value: unknown, release?: Release) {
      if (!inScope(account)) {
        release?.();
        return false;
      }
      const full = keyFor(account, key);
      const previous = entries.get(full);
      entries.delete(full);
      entries.set(full, { value, release });
      if (previous?.release && previous.release !== release) previous.release();
      while (entries.size > LIMIT) drop(entries.keys().next().value!);
      return true;
    },
    delete(account: { userId: string; generation: number }, key: string) {
      if (inScope(account)) drop(keyFor(account, key));
    },
    /** Every kept value whose key starts with `prefix`, for updating lists that share a project. */
    update<T>(account: { userId: string; generation: number }, prefix: string, change: (value: T) => T) {
      if (!inScope(account)) return;
      const start = keyFor(account, prefix);
      for (const [key, entry] of entries) if (key.startsWith(start)) entry.value = change(entry.value as T);
    },
    clear,
  };
}

export type AccountViewCache = ReturnType<typeof createAccountViewCache>;
