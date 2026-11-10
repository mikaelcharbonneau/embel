import "server-only";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig } from "pg";
import JavaScriptClient from "pg/lib/client.js";
import JavaScriptPool from "pg-pool";
import { z } from "zod";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ApiError } from "@/server/http/errors";
import { createIdentityTransactionService, type IdentityConnectionFactory } from "@/server/data/identity-transaction";
import {
  createHomeAttachmentService,
  homeAttachmentReservationSchema,
  type HomeAttachmentBackend,
} from "@/server/home-attachments";
import {
  attachedProjectDraftReceiptSchema,
  ownedAttachmentRefSchema,
  requestLookupSchema,
  PROPOSED_HOME_ATTACHMENT_POLICY,
} from "@/domain/attachments";
import { createAccountHomeStorageTransport } from "@/server/runtime/account-home-storage";
import { createSupabasePrivateAssetStorage } from "@/server/runtime/private-asset-storage";
import { createPooledIdentityConnectionFactory, type IdentityPoolPort } from "@/server/runtime/identity-pool";
import { readSharedAccountHttpConfiguration, type SharedHttpPrincipal } from "./configuration";
import { issueSharedAccountRequest } from "./request";
import { qualifySharedHttpConnection } from "./qualification";

type Environment = Readonly<Record<string, string | undefined>>;
type Pool = IdentityPoolPort & { on(event: "error", listener: (error: Error) => void): unknown; end(): Promise<void> };
export type SharedAccountHttpDependencies = {
  createPool(config: PoolConfig): Pool;
  readCertificate(): string;
  fetch: typeof fetch;
};
const unavailable = () => new ApiError("integration_unavailable");
const defaults: SharedAccountHttpDependencies = {
  createPool: (config) => new JavaScriptPool({ ...config, Client: JavaScriptClient }),
  readCertificate: () => readFileSync(join(process.cwd(), "scripts/certs/supabase-prod-ca-2021.crt"), "utf8"),
  fetch: (...args) => globalThis.fetch(...args),
};
const certificateHash = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
const active = (signal?: AbortSignal) => {
  if (signal?.aborted) throw unavailable();
};
const noRelease = async () => {};
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw unavailable();
  return result.data;
}
function sqlError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  throw new ApiError(
    code === "P0002"
      ? "not_found"
      : ["PT409", "23505", "40001"].includes(code)
        ? "conflict"
        : ["22023", "22P02", "23514"].includes(code)
          ? "invalid_input"
          : "integration_unavailable",
  );
}

/** Shared fixed pools retain no customer auth/session/context. Every actual
 * operation obtains independent PostgREST ownership delegation and SQL verifies
 * it under the actual fixed login. No owner GUC grants authority. */
export function createSharedAccountHttpRuntime(
  env: Environment,
  dependencies: SharedAccountHttpDependencies = defaults,
) {
  const config = readSharedAccountHttpConfiguration(env);
  if (!config) return null;
  const ca = dependencies.readCertificate();
  if (createHash("sha256").update(ca).digest("hex") !== certificateHash) throw unavailable();
  const pools: Pool[] = [];
  let closed = false,
    closure: Promise<void> | undefined;
  function prepare(principal: SharedHttpPrincipal | undefined) {
    if (!principal) return undefined;
    const pool = dependencies.createPool({
      host: principal.host,
      port: principal.port,
      database: "postgres",
      user: principal.user,
      password: () => principal.password,
      ssl: principal.tls ? { ca, rejectUnauthorized: true, servername: principal.host, minVersion: "TLSv1.2" } : false,
      sslnegotiation: "postgres",
      replication: "false",
      application_name: "embel-shared-account-http",
      client_encoding: "UTF8",
      max: 2,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 5000,
      query_timeout: 5000,
      lock_timeout: 1500,
      idle_in_transaction_session_timeout: 5000,
      options:
        "-c row_security=on -c statement_timeout=5000 -c lock_timeout=1500 -c idle_in_transaction_session_timeout=5000",
    } as PoolConfig);
    pool.on("error", () => {});
    pools.push(pool);
    return { principal, pool };
  }
  let identity: ReturnType<typeof prepare>, home: ReturnType<typeof prepare>;
  try {
    identity = prepare(config.identity);
    home = prepare(config.homeVerifier);
  } catch {
    for (const pool of pools) void pool.end().catch(() => {});
    throw unavailable();
  }
  function factory(binding: NonNullable<typeof identity>, auth: AuthenticatedContext): IdentityConnectionFactory {
    return createPooledIdentityConnectionFactory([
      {
        ownerId: auth.userId.toLowerCase(),
        roleName: binding.principal.roleName,
        roleOid: binding.principal.roleOid,
        pool: binding.pool,
      },
    ]);
  }
  async function qualify(
    binding: NonNullable<typeof identity>,
    auth: AuthenticatedContext,
    lane: "identity" | "home",
    signal?: AbortSignal,
  ) {
    const base = factory(binding, auth),
      lease = await base.acquire(auth.userId, signal);
    let discard = false;
    try {
      await qualifySharedHttpConnection(lease.connection, lane, binding.principal, config!.origin);
    } catch {
      discard = true;
      throw unavailable();
    } finally {
      await lease.connection.release(discard);
    }
  }
  function identityFactory(
    binding: NonNullable<typeof identity>,
    auth: AuthenticatedContext,
  ): IdentityConnectionFactory {
    const base = factory(binding, auth);
    return {
      async acquire(owner, signal) {
        if (closed || owner !== auth.userId.toLowerCase()) throw unavailable();
        const lease = await base.acquire(owner, signal);
        let prepared = false,
          transaction = false;
        return {
          binding: lease.binding,
          connection: {
            async query(sql, parameters = []) {
              active(signal);
              if (closed) throw unavailable();
              if (sql === "BEGIN") {
                transaction = true;
                return lease.connection.query(sql);
              }
              if (sql === "COMMIT") {
                if (prepared) await lease.connection.query("SELECT public.finish_shared_identity_request() AS value");
                const result = await lease.connection.query(sql);
                transaction = false;
                return result;
              }
              if (sql === "ROLLBACK") {
                const result = await lease.connection.query(sql);
                transaction = false;
                return result;
              }
              if (!transaction) throw unavailable();
              if (
                sql === "SELECT fluid_private.prepare_identity_transaction($1::uuid,$2::jsonb,$3::boolean) AS value"
              ) {
                const [project, raw, refinement] = parameters;
                const request: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
                const token = await issueSharedAccountRequest(
                  auth,
                  "identity",
                  "identity",
                  [project, request, refinement],
                  signal,
                );
                const result = await lease.connection.query(
                  "SELECT public.prepare_shared_identity_request($1::text,$2::uuid,$3::jsonb,$4::boolean) AS value",
                  [token, project, JSON.stringify(request), refinement],
                );
                prepared = true;
                return result;
              }
              if (sql === "SELECT fluid_private.commit_identity_transaction($1::uuid,$2::jsonb,$3::jsonb) AS value")
                return lease.connection.query(
                  "SELECT public.commit_shared_identity_request($1::uuid,$2::jsonb,$3::jsonb) AS value",
                  parameters,
                );
              if (
                [
                  "SET LOCAL statement_timeout = '5000ms'",
                  "SET LOCAL lock_timeout = '1500ms'",
                  "SET LOCAL idle_in_transaction_session_timeout = '5000ms'",
                  "SELECT session_user::text AS role_name, pg_catalog.to_regrole(session_user)::oid::bigint AS role_oid",
                  "SELECT pg_catalog.set_config('request.jwt.claim.sub',$1,true)",
                ].includes(sql)
              )
                return lease.connection.query(sql, parameters);
              throw unavailable();
            },
            release: (discard) => lease.connection.release(discard || transaction),
            discard: () => lease.connection.discard(),
          },
        };
      },
    };
  }
  function backend(binding: NonNullable<typeof home>): HomeAttachmentBackend {
    async function call(
      auth: AuthenticatedContext,
      action: "prepare" | "lookup" | "resolve" | "readback" | "save" | "lookup_project",
      args: unknown[],
      observation: unknown = null,
      signal?: AbortSignal,
    ) {
      active(signal);
      if (closed) throw unavailable();
      const token = await issueSharedAccountRequest(auth, "home", action, args, signal),
        lease = await factory(binding, auth).acquire(auth.userId, signal);
      let discard = false;
      try {
        const result = await lease.connection.query(
          "SELECT public.execute_shared_home_request($1::text,$2::text,$3::jsonb,$4::jsonb) AS value",
          [token, action, JSON.stringify(args), observation === null ? null : JSON.stringify(observation)],
        );
        active(signal);
        return parse(z.strictObject({ value: z.unknown() }), result.rows[0]).value;
      } catch (error) {
        discard = true;
        sqlError(error);
      } finally {
        await lease.connection.release(discard);
      }
    }
    return {
      prepare: async (auth, input, length, signal) =>
        parse(homeAttachmentReservationSchema, await call(auth, "prepare", [input, length], null, signal)),
      lookup: async (auth, key, signal) =>
        parse(homeAttachmentReservationSchema.nullable(), await call(auth, "lookup", [key], null, signal)),
      observe: async (auth, id, observation, signal) =>
        parse(ownedAttachmentRefSchema, await call(auth, "readback", [id], observation, signal)),
      resolve: async (auth, ids, signal) =>
        parse(z.array(homeAttachmentReservationSchema).max(5), await call(auth, "resolve", [ids], null, signal)),
      save: async (auth, input, signal) =>
        parse(
          attachedProjectDraftReceiptSchema,
          await call(auth, "save", [input, JSON.stringify(input.project.context)], null, signal),
        ),
      lookupProject: async (auth, key, signal) =>
        parse(
          requestLookupSchema(attachedProjectDraftReceiptSchema),
          await call(auth, "lookup_project", [key], null, signal),
        ),
    };
  }
  return {
    async acquireIdentity(auth: AuthenticatedContext, signal?: AbortSignal) {
      try {
        if (closed || !identity) return { configured: true, value: null, release: noRelease };
        active(signal);
        await qualify(identity, auth, "identity", signal);
        return {
          configured: true,
          value: {
            transactions: createIdentityTransactionService(identityFactory(identity, auth)),
            saveAvailability: { status: "available" as const },
          },
          release: noRelease,
        };
      } catch {
        return { configured: true, value: null, release: noRelease };
      }
    },
    async acquireHome(auth: AuthenticatedContext, signal?: AbortSignal) {
      try {
        if (closed || !home) return { configured: true, value: null, release: noRelease };
        active(signal);
        await qualify(home, auth, "home", signal);
        const transport = await createAccountHomeStorageTransport(
          auth,
          { publishableKey: config.publishableKey, fetch: dependencies.fetch, sharedSupabaseOrigin: config.origin },
          signal,
        );
        const storage = createSupabasePrivateAssetStorage({
          scope: { kind: "home", ownerId: auth.userId },
          transport,
          sharedSupabaseOrigin: config.origin,
        });
        return {
          configured: true,
          value: createHomeAttachmentService({
            backend: backend(home),
            storage,
            policy: PROPOSED_HOME_ATTACHMENT_POLICY,
          }),
          release: noRelease,
        };
      } catch {
        return { configured: true, value: null, release: noRelease };
      }
    },
    close() {
      closed = true;
      return (closure ??= Promise.allSettled(pools.map((pool) => pool.end())).then((result) => {
        if (result.some((entry) => entry.status === "rejected")) throw unavailable();
      }));
    },
  };
}
