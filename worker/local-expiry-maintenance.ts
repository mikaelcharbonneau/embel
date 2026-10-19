import type { Pool } from "pg";
import type { JobDatabase } from "./postgres-store";

type ExpiryRole = "strategy" | "naming";

/** SET LOCAL and the RPC must use one backend transaction through the pooler.
 * A client-side read timeout alone does not cancel a PostgreSQL statement. */
export async function runLocalExpiryTransaction(pool: Pick<Pool, "connect">, signal: AbortSignal,
  work: (database: JobDatabase) => Promise<number>): Promise<number> {
  signal.throwIfAborted();
  const client = await pool.connect();
  let began = false, reusable = false;
  try {
    signal.throwIfAborted();
    await client.query("BEGIN"); began = true;
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    signal.throwIfAborted();
    const count = await work(client);
    await client.query("COMMIT"); reusable = true;
    return count;
  } catch (error) {
    if (began) {
      try { await client.query("ROLLBACK"); reusable = true; }
      catch { /* Destroy the connection when transaction settlement is unknown. */ }
    }
    throw error;
  } finally { client.release(!reusable); }
}

/** Both local loops share one serial lane. Successful, failed and busy scans
 * wait at least ten seconds before that role can submit another expiry RPC. */
export function createLocalExpiryCoordinator(now: () => number = Date.now) {
  let tail = Promise.resolve();
  const pending = new Map<ExpiryRole, Promise<number>>(), nextAt = new Map<ExpiryRole, number>();
  return {
    run(role: ExpiryRole, signal: AbortSignal, work: () => Promise<number>): Promise<number> {
      const existing = pending.get(role);
      if (existing) return existing;
      const result = tail.then(async () => {
        signal.throwIfAborted();
        if (now() < (nextAt.get(role) ?? 0)) return 0;
        try { return await work(); }
        finally { nextAt.set(role, now() + 10_000); }
      });
      tail = result.then(() => {}, () => {});
      pending.set(role, result);
      void result.finally(() => { if (pending.get(role) === result) pending.delete(role); }).catch(() => {});
      return result;
    },
  };
}
