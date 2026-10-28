import "server-only";
import { z } from "zod";
import type { LogoWorkerConnection } from "../src/server/data/logo-jobs";
import { createPooledIdentityConnectionFactory, type IdentityPoolClientPort, type IdentityPoolPort } from "../src/server/runtime/identity-pool";
import { readDevelopmentConfiguration } from "../src/server/development/config";

export type LogoProductionConnectionInput = {
  ownerId: string; roleName: string; roleOid: number; pool: IdentityPoolPort | null;
  acquireTimeoutMs?: number; queryTimeoutMs?: number; disposalTimeoutMs?: number;
};
export type LogoProductionConnection = Readonly<LogoWorkerConnection & {
  query<Row>(sql: string, parameters?: unknown[], signal?: AbortSignal): Promise<{ rows: Row[] }>;
  close(): Promise<void>;
}>;
const unavailable = () => new Error("Logo production connection is unavailable.");
const unconfirmed = () => new Error("Logo production connection drain is unconfirmed.");
const principalSql = "SELECT session_user::text AS role_name, current_user::text AS active_role, pg_catalog.to_regrole(session_user)::oid::bigint AS role_oid, fluid_private.logo_worker_owner()::text AS owner_id";
const developmentPrincipalSql = "SELECT session_user::text AS role_name, current_user::text AS active_role, pg_catalog.to_regrole(session_user)::oid::bigint AS role_oid, public.check_development_worker_binding('logo',$1,$2)::text AS owner_id";
const configurationSchema = z.strictObject({
  ownerId: z.uuid(), roleName: z.string().max(63).regex(/^fluid_logo_worker(?:_[a-z0-9_]+)?$/), roleOid: z.number().int().min(1).max(4_294_967_295),
  acquireTimeoutMs: z.number().int().min(1).max(10_000), queryTimeoutMs: z.number().int().min(1).max(15_000), disposalTimeoutMs: z.number().int().min(1).max(15_000),
});

/** Pure construction around an already supplied pool. Never reads credentials,
 * changes roles, creates a pool or disposes the caller's pool. Each operation
 * validates its actual SQL principal and owner on the SAME acquired client.
 * close fences synchronously; only a resolved close confirms the drain. */
export function createLogoProductionConnection(input: LogoProductionConnectionInput | null = null): LogoProductionConnection | null {
  return createConnection(input, false);
}

export function createDevelopmentLogoConnection(input: LogoProductionConnectionInput | null = null): LogoProductionConnection | null {
  return readDevelopmentConfiguration() ? createConnection(input, true) : null;
}

function createConnection(input: LogoProductionConnectionInput | null, development: boolean): LogoProductionConnection | null {
  if (!input || typeof input.pool?.connect !== "function") return null;
  const developmentOrigin = development ? readDevelopmentConfiguration()?.supabaseUrl : undefined;
  const developmentDeployment = development ? process.env.EMBEL_DEVELOPMENT_WORKER_DEPLOYMENT_ID : undefined;
  if (development && (!developmentOrigin || !/^embel-dev-[A-Za-z0-9._:-]{1,170}$/u.test(developmentDeployment ?? ""))) return null;
  const developmentActive = () => !development || readDevelopmentConfiguration()?.supabaseUrl === developmentOrigin
    && process.env.EMBEL_DEVELOPMENT_WORKER_DEPLOYMENT_ID === developmentDeployment;
  const parsed = (development ? configurationSchema.safeExtend({ roleName: z.literal("embel_development_logo_worker") }) : configurationSchema).safeParse({ ownerId: input.ownerId, roleName: input.roleName, roleOid: input.roleOid,
    acquireTimeoutMs: input.acquireTimeoutMs ?? 10_000, queryTimeoutMs: input.queryTimeoutMs ?? 15_000, disposalTimeoutMs: input.disposalTimeoutMs ?? 15_000 });
  if (!parsed.success) return null;
  const configuration = parsed.data, ownerId = configuration.ownerId.toLowerCase(), connect = input.pool.connect.bind(input.pool);
  const pending = new Set<Promise<unknown>>(), acquiring = new Set<Promise<unknown>>(), borrowed = new Set<object>();
  const changed = new Set<() => void>();
  let closed = false, closing: Promise<void> | undefined;
  const notify = () => { for (const check of changed) check(); };
  function track<T>(set: Set<Promise<unknown>>, promise: Promise<T>): Promise<T> {
    set.add(promise);
    void promise.then(() => { set.delete(promise); notify(); }, () => { set.delete(promise); notify(); });
    return promise;
  }
  // Track raw checkouts as well as factory operations. IdentityPoolPort cannot
  // cancel connect(); a late client must actually be discarded before drain is
  // confirmed. Returning a timeout alone is never disposal evidence.
  const pool: IdentityPoolPort = { connect: () => track(acquiring, Promise.resolve().then(connect).then(client => {
    const marker = {}; borrowed.add(marker);
    const released = () => { borrowed.delete(marker); notify(); };
    const wrapped: IdentityPoolClientPort = {
      query: client.query.bind(client), on: client.on.bind(client), removeListener: client.removeListener.bind(client),
      release(discard) { client.release(discard); released(); },
      async end() { await client.end(); released(); },
    };
    return wrapped;
  })) };
  const factory = createPooledIdentityConnectionFactory([{ ownerId, roleName: configuration.roleName, roleOid: configuration.roleOid, pool }], configuration);
  const principalSchema = z.strictObject({ role_name: z.literal(configuration.roleName), active_role: z.literal(configuration.roleName),
    role_oid: z.union([z.number().int(), z.string().regex(/^[1-9][0-9]*$/).transform(Number)]).refine(oid => oid === configuration.roleOid), owner_id: z.literal(ownerId) });
  function bounded<T>(promise: Promise<T>, milliseconds: number, timedOut?: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { timedOut?.(); reject(unavailable()); }, milliseconds); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    return closing = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); changed.delete(check); if (error) reject(error); else resolve(); };
      const check = () => { if (!pending.size && !acquiring.size && !borrowed.size) finish(); };
      const timer = setTimeout(() => finish(unconfirmed()), configuration.disposalTimeoutMs);
      changed.add(check); check();
    });
  }
  return Object.freeze({
    query<Row>(sql: string, parameters: unknown[] = [], signal?: AbortSignal): Promise<{ rows: Row[] }> {
      if (!developmentActive()) closed = true;
      if (closed || signal?.aborted) return Promise.reject(unavailable());
      const values = [...parameters];
      return track(pending, (async () => {
        const controller = new AbortController();
        const lifetime = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
        let acquired: Awaited<ReturnType<typeof factory.acquire>> | undefined, discard = false, validated = false;
        try {
          acquired = await factory.acquire(ownerId, lifetime);
          const actual = await bounded(acquired.connection.query(development ? developmentPrincipalSql : principalSql,
            development ? [ownerId, developmentDeployment] : []), configuration.queryTimeoutMs, () => controller.abort());
          if (lifetime.aborted || !developmentActive() || actual.rows.length !== 1 || !principalSchema.safeParse(actual.rows[0]).success) throw unavailable();
          validated = true;
          const result = await bounded(acquired.connection.query(sql, values), configuration.queryTimeoutMs, () => controller.abort()) as { rows: Row[] };
          if (!developmentActive()) throw unavailable();
          return result;
        } catch (error) {
          discard = true;
          // This is the runner's sole durable-plan control signal. Never pass
          // arbitrary driver codes, causes, message substrings or detail fields.
          if (validated && !lifetime.aborted && sql === "select public.register_logo_job_plan($1,$2,$3)" && error instanceof Error && error.message === "plan_conflict") throw new Error("plan_conflict");
          throw unavailable();
        } finally {
          if (acquired) {
            try { await bounded(Promise.resolve(acquired.connection.release(discard)), configuration.disposalTimeoutMs, () => controller.abort()); }
            catch { controller.abort(); throw unavailable(); }
          }
        }
      })());
    }, close,
  });
}
