import type { PGlite } from "@electric-sql/pglite";
import type { IdentityConnectionFactory } from "../../../src/server/data/identity-transaction";
import { identityFixturePrincipals } from "../../database/identity-trusted-replacement-database";

/** NEW disposable single-backend adapter. Every application statement reaches
 * PostgreSQL unchanged. Test hooks observe/fail real transport boundaries only. */
type Phase = "available" | "acquiring" | "leased" | "releasing" | "quarantined" | "closed";
type Outcome = "none" | "active" | "committed" | "rolled_back" | "unknown";
type Event = { kind: string; generation: number; sql?: string };
type Hooks = {
  afterQuery?: (sql: string) => void | Promise<void>;
  beforeResetVerification?: () => void | Promise<void>;
  beforeCleanup?: () => void | Promise<void>;
  afterCleanup?: () => void | Promise<void>;
  beforeDispose?: () => void | Promise<void>;
};
type Token = {
  generation: number;
  outcome: Outcome;
  pending: number;
  applicationPending: boolean;
  poisoned: boolean;
  retired: boolean;
  signal?: AbortSignal;
  onAbort: () => void;
  deadline?: number;
  release?: Promise<void>;
  disposal?: Promise<void>;
  cleanReceipt?: Readonly<Record<string, unknown>>;
};
type Registry = { phase: Phase; generation: number; active?: Token; disposalFailed: boolean; cleanGeneration?: number };
const registries = new WeakMap<PGlite, Registry>();
const BOUND_MS = 5000;
function registryFor(db: PGlite): Registry {
  let registry = registries.get(db);
  if (!registry) {
    registry = { phase: "available", generation: 0, disposalFailed: false };
    registries.set(db, registry);
  }
  return registry;
}
function unavailable(message: string) {
  return new Error(`Identity replacement connection ${message}`);
}
async function bounded<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(unavailable("deadline exceeded")), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
export function createIdentityTrustedConnectionFixture(db: PGlite) {
  const registry = registryFor(db),
    events: Event[] = [],
    hooks: Hooks = {};
  const failures: Array<{ sql: string; code: string; message: string }> = [];
  const owns = (token: Token) => registry.active === token && registry.generation === token.generation;
  const event = (token: Token, kind: string, sql?: string) => {
    events.push({ kind, generation: token.generation, ...(sql ? { sql } : {}) });
  };
  function poison(token: Token) {
    if (!owns(token) || token.retired) return;
    token.poisoned = true;
    registry.phase = "quarantined";
  }
  async function direct(token: Token, sql: string, parameters: readonly unknown[] = []) {
    if (
      !owns(token) ||
      token.retired ||
      token.pending !== 0 ||
      (token.deadline !== undefined && Date.now() >= token.deadline)
    )
      throw unavailable("stale, expired or overlapping SQL");
    token.pending++;
    try {
      return await db.query(sql, [...parameters]);
    } finally {
      token.pending--;
    }
  }
  async function reset(token: Token, observeVerification = false) {
    if (!owns(token) || token.retired || token.pending !== 0) throw unavailable("reset has outstanding SQL");
    if (db.isInTransaction()) {
      await direct(token, "ROLLBACK");
      event(token, "cleanup_rollback");
    }
    await direct(token, "DISCARD ALL");
    // PGlite starts with an empty original session_authorization setting. Its
    // RESET does not establish real-login behavior; restore this local bootstrap explicitly.
    await direct(token, "SET SESSION AUTHORIZATION postgres");
    if (observeVerification) await hooks.beforeResetVerification?.();
    const observed = await direct(
      token,
      `select session_user::text session_name,current_user::text current_name,
      coalesce(current_setting('request.jwt.claim.sub',true),'') claim,
      coalesce(current_setting('fluid.identity.validated',true),'') validation,
      not exists(select 1 from pg_catalog.pg_class where relnamespace=pg_catalog.pg_my_temp_schema() and relname='identity_transaction_preparation') no_preparation,
      not exists(select 1 from pg_catalog.pg_locks where pid=pg_catalog.pg_backend_pid() and locktype='advisory' and granted) no_advisory`,
    );
    const row = observed.rows[0] as
      | {
          session_name: string;
          current_name: string;
          claim: string;
          validation: string;
          no_preparation: boolean;
          no_advisory: boolean;
        }
      | undefined;
    if (
      db.isInTransaction() ||
      !row ||
      row.session_name !== "postgres" ||
      row.current_name !== "postgres" ||
      row.claim !== "" ||
      row.validation !== "" ||
      !row.no_preparation ||
      !row.no_advisory
    )
      throw unavailable("reset verification failed");
    event(token, "reset_verified");
    return Object.freeze({ ...row, idle: true, outcome: token.outcome, generation: token.generation });
  }
  function dispose(token: Token): Promise<void> {
    if (token.retired || !owns(token)) return Promise.resolve();
    poison(token);
    if (token.disposal) return token.disposal;
    token.deadline ??= Date.now() + BOUND_MS;
    const deadline = token.deadline;
    token.disposal = (async () => {
      try {
        if (Date.now() >= deadline) throw unavailable("disposal deadline exhausted");
        await bounded(
          (async () => {
            if (token.pending !== 0) throw unavailable("disposal has unresolved SQL");
            // Diagnostic inspection is permitted only after actual idle/reset
            // checks, with application admission already permanently closed.
            let resetFailure: unknown;
            try {
              await reset(token);
            } catch (error) {
              resetFailure = error;
            }
            // A failed reset never rehabilitates this backend. Attempt physical
            // close within the remaining bound, without privileged diagnostic access.
            if (resetFailure === undefined) await hooks.beforeDispose?.();
            if (!owns(token) || token.retired || Date.now() >= deadline) throw unavailable("stale disposal");
            event(token, "dispose");
            await db.close();
            if (owns(token)) registry.phase = "closed";
            if (resetFailure !== undefined) throw resetFailure;
          })(),
          deadline,
        );
      } catch (error) {
        if (owns(token)) {
          registry.disposalFailed = true;
          if (registry.phase !== "closed") registry.phase = "quarantined";
        }
        event(token, "disposal_failed");
        throw error;
      } finally {
        token.signal?.removeEventListener("abort", token.onAbort);
      }
    })();
    return token.disposal;
  }
  const factory: IdentityConnectionFactory = {
    async acquire(owner, signal) {
      const role = identityFixturePrincipals[owner];
      if (!role || signal?.aborted) throw unavailable("unknown owner or aborted acquisition");
      if (registry.phase !== "available")
        throw unavailable(
          registry.phase === "quarantined" || registry.phase === "closed" ? "quarantined backend" : "busy backend",
        );
      const token: Token = {
        generation: ++registry.generation,
        outcome: "none",
        pending: 0,
        applicationPending: false,
        poisoned: false,
        retired: false,
        signal,
        onAbort: () => poison(token),
      };
      registry.active = token;
      registry.phase = "acquiring";
      signal?.addEventListener("abort", token.onAbort, { once: true });
      event(token, "acquire");
      try {
        const login = await bounded(
          (async () => {
            await direct(token, `SET SESSION AUTHORIZATION ${role}`);
            if (token.poisoned || signal?.aborted) throw unavailable("aborted acquisition");
            return direct(
              token,
              "SELECT session_user::text AS role_name, pg_catalog.to_regrole(session_user)::oid::bigint AS role_oid",
            );
          })(),
          Date.now() + BOUND_MS,
        );
        if (!owns(token) || token.poisoned || signal?.aborted) throw unavailable("late acquisition");
        const identity = login.rows[0] as { role_name: string; role_oid: number } | undefined;
        if (!identity || identity.role_name !== role || !Number.isSafeInteger(Number(identity.role_oid)))
          throw unavailable("login verification failed");
        registry.phase = "leased";
        return {
          binding: { ownerId: owner, roleName: identity.role_name, roleOid: Number(identity.role_oid) },
          connection: {
            async query(sql, parameters = []) {
              const command = sql.trim().replace(/;$/, "").toUpperCase();
              const rollback = command === "ROLLBACK";
              if (
                !owns(token) ||
                token.retired ||
                token.pending !== 0 ||
                token.applicationPending ||
                (registry.phase !== "leased" && !(rollback && registry.phase === "quarantined"))
              )
                throw unavailable("stale or quarantined lease");
              if (token.poisoned && !rollback) throw unavailable("poisoned lease");
              token.applicationPending = true;
              try {
                if (!owns(token) || token.retired || (token.poisoned && !rollback))
                  throw unavailable("aborted before dispatch");
                event(
                  token,
                  sql.includes("prepare_identity_transaction")
                    ? "prepare"
                    : sql.includes("commit_identity_transaction")
                      ? "commit_helper"
                      : command,
                  sql,
                );
                if (command === "BEGIN") token.outcome = "active";
                const result = await direct(token, sql, parameters);
                if (command === "COMMIT") token.outcome = "committed";
                if (rollback) token.outcome = "rolled_back";
                await hooks.afterQuery?.(sql);
                return result;
              } catch (error) {
                const detail = error as { code?: unknown; message?: unknown };
                failures.push({ sql, code: String(detail?.code ?? ""), message: String(detail?.message ?? error) });
                if (command === "COMMIT" || rollback || command === "BEGIN") {
                  token.outcome = "unknown";
                  poison(token);
                }
                throw error;
              } finally {
                token.applicationPending = false;
              }
            },
            release(discard) {
              if (token.retired || !owns(token)) return Promise.resolve();
              if (discard) poison(token);
              if (token.release) return token.release;
              token.deadline ??= Date.now() + BOUND_MS;
              if (!token.poisoned) registry.phase = "releasing";
              token.release = (async () => {
                if (token.poisoned || token.outcome === "unknown") {
                  await dispose(token);
                  return;
                }
                try {
                  if (token.pending || token.applicationPending || token.outcome === "active")
                    throw unavailable("unknown terminal transaction state");
                  const receipt = await bounded(
                    (async () => {
                      await hooks.beforeCleanup?.();
                      const result = await reset(token, true);
                      await hooks.afterCleanup?.();
                      return result;
                    })(),
                    token.deadline!,
                  );
                  // Atomic handoff: no await between the final checks, listener
                  // removal, retirement and publication. Old generations never close new ones.
                  if (
                    !owns(token) ||
                    token.pending ||
                    token.applicationPending ||
                    token.poisoned ||
                    signal?.aborted ||
                    Date.now() >= token.deadline! ||
                    db.isInTransaction()
                  )
                    throw unavailable("unclean handoff");
                  token.cleanReceipt = receipt;
                  signal?.removeEventListener("abort", token.onAbort);
                  token.retired = true;
                  registry.cleanGeneration = token.generation;
                  registry.active = undefined;
                  registry.phase = "available";
                  event(token, "clean_handoff");
                } catch (error) {
                  poison(token);
                  try {
                    await dispose(token);
                  } catch {
                    /* Tombstone persists; preserve release failure. */
                  }
                  throw error;
                }
              })();
              return token.release;
            },
            discard() {
              return dispose(token);
            },
          },
        };
      } catch (error) {
        poison(token);
        try {
          await dispose(token);
        } catch {
          /* Never rehabilitate failed acquisition. */
        }
        throw error;
      }
    },
  };
  return {
    factory,
    hooks,
    events,
    failures,
    inspect: () =>
      Object.freeze({
        phase: registry.phase,
        generation: registry.generation,
        cleanGeneration: registry.cleanGeneration,
        disposalFailed: registry.disposalFailed,
        pending: registry.active?.pending ?? 0,
        poisoned: registry.active?.poisoned ?? false,
      }),
  };
}
