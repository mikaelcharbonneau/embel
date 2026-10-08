import "server-only";
import { z } from "zod";
import { ApiError } from "@/server/http/errors";
import type { IdentityConnectionBinding, IdentityConnectionFactory, IdentityTransactionConnection } from "@/server/data/identity-transaction";

/** Supplied only by trusted server configuration, never from an HTTP body. */
export interface IdentityPoolClientPort {
  query(input: { text: string; values: unknown[]; query_timeout: number }): Promise<{ rows: unknown[] }>;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  release(destroy?: boolean): void;
  end(): Promise<void>;
}
/** Pool owner must install the driver pool-level idle error handler when constructing it. */
export interface IdentityPoolPort { connect(): Promise<IdentityPoolClientPort> }
type ConfiguredPool = IdentityConnectionBinding & { pool: IdentityPoolPort };
const bindingSchema = z.strictObject({ ownerId: z.uuid(), roleName: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), roleOid: z.number().int().min(1).max(4_294_967_295) });
const unavailable = () => new ApiError("integration_unavailable");
const forbiddenRoles = new Set(["postgres", "supabase_admin", "service_role", "authenticated", "anon", "authenticator", "fluid_local_worker"]);

/** Uses one checked-out client for each complete transaction. It neither creates
 * credentials nor grants access. SQL helpers still validate the actual login/OID
 * and its owner binding on every trusted operation. Empty configuration is closed.
 * Official lifecycle: https://node-postgres.com/apis/pool#releasing-clients */
export function createPooledIdentityConnectionFactory(configured: readonly ConfiguredPool[], options: { acquireTimeoutMs?: number; queryTimeoutMs?: number } = {}): IdentityConnectionFactory {
  const acquireTimeoutMs = z.number().int().min(1).max(10_000).parse(options.acquireTimeoutMs ?? 10_000);
  const queryTimeoutMs = z.number().int().min(1).max(15_000).parse(options.queryTimeoutMs ?? 15_000);
  const pools = new Map<string, { binding: IdentityConnectionBinding; pool: IdentityPoolPort }>();
  for (const row of configured) {
    const binding = bindingSchema.parse({ ownerId: row.ownerId, roleName: row.roleName, roleOid: row.roleOid });
    binding.ownerId = binding.ownerId.toLowerCase();
    if (forbiddenRoles.has(binding.roleName) || pools.has(binding.ownerId)) throw unavailable();
    pools.set(binding.ownerId, { binding: Object.freeze(binding), pool: row.pool });
  }
  async function destroy(client: IdentityPoolClientPort) {
    // Cover the transition even for an aborted/late checkout that never got a lease.
    const absorb = () => {};
    client.on("error", absorb);
    let coveredByPoolOrClosed = false;
    try { client.release(true); coveredByPoolOrClosed = true; }
    catch { try { await client.end(); coveredByPoolOrClosed = true; } catch { /* Keep the sink if closure cannot be confirmed. */ } }
    finally { if (coveredByPoolOrClosed) client.removeListener("error", absorb); }
  }
  async function closeAfterFailedRelease(client: IdentityPoolClientPort) {
    const absorb = () => {};
    client.on("error", absorb);
    try { await client.end(); client.removeListener("error", absorb); }
    catch { /* Closure is unconfirmed: preserve error coverage on this discarded client. */ }
  }
  return {
    async acquire(owner, signal) {
      if (!z.uuid().safeParse(owner).success || signal?.aborted) throw unavailable();
      const selected = pools.get(owner.toLowerCase());
      if (!selected) throw unavailable();
      const client = await new Promise<IdentityPoolClientPort>((resolve, reject) => {
        let settled = false;
        const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); action(); };
        const abort = () => finish(() => reject(unavailable()));
        const timer = setTimeout(abort, acquireTimeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => selected.pool.connect()).then(value => {
          if (settled || signal?.aborted) { void destroy(value); if (!settled) abort(); return; }
          finish(() => resolve(value));
        }, () => finish(() => reject(unavailable())));
      });
      if (signal?.aborted) { await destroy(client); throw unavailable(); }
      let released = false, inFlight = false, tainted = false;
      const release = async (discard: boolean) => {
        if (released) return;
        released = true; signal?.removeEventListener("abort", abortLease);
        try {
          if (discard || signal?.aborted || inFlight || tainted) { await destroy(client); return; }
          // pg-pool reinstalls its idle listener synchronously before release returns.
          try { client.release(false); } catch { await closeAfterFailedRelease(client); throw unavailable(); }
        } finally { client.removeListener("error", onError); }
      };
      const onError = () => { tainted = true; void release(true).catch(() => {}); };
      client.on("error", onError);
      const abortLease = () => { void release(true); };
      signal?.addEventListener("abort", abortLease, { once: true });
      const connection: IdentityTransactionConnection = {
        async query(text, parameters = []) {
          if (released || signal?.aborted || inFlight) throw unavailable();
          inFlight = true;
          try {
            const result = await client.query({ text, values: [...parameters], query_timeout: queryTimeoutMs });
            if (released || signal?.aborted) throw unavailable();
            return result;
          } catch (error) { tainted = true; throw error; }
          finally { inFlight = false; }
        },
        release,
        discard: () => release(true),
      };
      return { connection, binding: { ...selected.binding } };
    },
  };
}
