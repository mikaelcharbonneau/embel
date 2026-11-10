import "server-only";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig } from "pg";
import JavaScriptClient from "pg/lib/client.js";
import JavaScriptPool from "pg-pool";
import type { AuthenticatedContext } from "@/server/auth/context";
import type { IdentityConnectionFactory } from "@/server/data/identity-transaction";
import type { LogoRequestServiceResolution } from "@/server/runtime/logo-request-services";
import { ApiError } from "@/server/http/errors";
import { getLogoWorkspace } from "@/server/data/logo-workspace";
import { logoId, logoOwner } from "@/server/data/logo-transaction";
import { createPooledIdentityConnectionFactory } from "@/server/runtime/identity-pool";
import { createLogoOwnerStorageTransport } from "@/server/runtime/logo-owner-storage";
import { createSupabasePrivateAssetStorage } from "@/server/runtime/private-asset-storage";
import { readSharedLogoHttpConfiguration } from "./logo-configuration";
import { issueSharedLogoRequest, type SharedLogoAction } from "./logo-request";
import { qualifySharedLogoConnection } from "./logo-qualification";
import type { SharedAccountHttpDependencies } from "./runtime";

type Environment = Readonly<Record<string, string | undefined>>;
const unavailable = () => new ApiError("integration_unavailable");
const defaults: SharedAccountHttpDependencies = {
  createPool: (config) => new JavaScriptPool({ ...config, Client: JavaScriptClient }),
  readCertificate: () => readFileSync(join(process.cwd(), "scripts/certs/supabase-prod-ca-2021.crt"), "utf8"),
  fetch: (...args) => globalThis.fetch(...args),
};
const certificateHash = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
/** A separate finite web verifier. It never receives worker/provider/Admin keys,
 * customer passwords or per-owner SQL login/publication records. */
export function createSharedLogoHttpRuntime(env: Environment, dependencies: SharedAccountHttpDependencies = defaults) {
  const config = readSharedLogoHttpConfiguration(env);
  if (!config) return null;
  const ca = dependencies.readCertificate();
  if (createHash("sha256").update(ca).digest("hex") !== certificateHash) throw unavailable();
  const p = config.principal,
    pool = dependencies.createPool({
      host: p.host,
      port: p.port,
      database: "postgres",
      user: p.user,
      password: () => p.password,
      ssl: p.tls ? { ca, rejectUnauthorized: true, servername: p.host, minVersion: "TLSv1.2" } : false,
      sslnegotiation: "postgres",
      replication: "false",
      binary: false,
      application_name: "embel-shared-logo-http",
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
  let closed = false,
    closure: Promise<void> | undefined;
  const baseFactory = (auth: AuthenticatedContext) =>
    createPooledIdentityConnectionFactory([
      { ownerId: logoOwner(auth), roleName: p.roleName, roleOid: p.roleOid, pool },
    ]);
  function factory(auth: AuthenticatedContext, project: string): IdentityConnectionFactory {
    const base = baseFactory(auth);
    return {
      async acquire(owner, signal) {
        if (closed || owner !== logoOwner(auth) || signal?.aborted) throw unavailable();
        const lease = await base.acquire(owner, signal);
        let transaction = false;
        return {
          binding: lease.binding,
          connection: {
            async query(sql, args = []) {
              if (closed || signal?.aborted) throw unavailable();
              if (sql === "BEGIN") {
                transaction = true;
                return lease.connection.query(sql);
              }
              if (sql === "COMMIT" || sql === "ROLLBACK") {
                const result = await lease.connection.query(sql);
                transaction = false;
                return result;
              }
              if (
                [
                  "SELECT session_user::text AS role_name, pg_catalog.to_regrole(session_user)::oid::bigint AS role_oid",
                  "SET LOCAL statement_timeout = '5000ms'",
                  "SET LOCAL lock_timeout = '1500ms'",
                  "SET LOCAL idle_in_transaction_session_timeout = '5000ms'",
                ].includes(sql)
              )
                return lease.connection.query(sql, args);
              const json = (raw: unknown): unknown => (typeof raw === "string" ? JSON.parse(raw) : raw);
              let action: SharedLogoAction,
                intent: unknown,
                evidence: unknown = null;
              if (
                sql === "SELECT fluid_private.prepare_logo_asset($1::uuid,$2::jsonb,$3::uuid,$4::uuid) AS value" &&
                args.length === 4 &&
                args[2] === null &&
                args[3] === null
              ) {
                action = "asset_prepare";
                intent = json(args[1]);
              } else if (
                sql === "SELECT fluid_private.observe_logo_asset($1::uuid,$2::jsonb,$3::uuid,$4::uuid) AS value" &&
                args.length === 4 &&
                args[2] === null &&
                args[3] === null
              ) {
                action = "asset_readback";
                intent = args[0];
                evidence = json(args[1]);
              } else if (
                sql === "SELECT fluid_private.read_logo_trusted_request($1::uuid,$2::jsonb) AS value" &&
                args.length === 2
              ) {
                action = "command_read";
                intent = json(args[1]);
              } else if (
                sql === "SELECT fluid_private.apply_logo_trusted_command($1::uuid,$2::jsonb,$3::jsonb) AS value" &&
                args.length === 3 &&
                transaction
              ) {
                action = "command_apply";
                intent = json(args[1]);
                evidence = json(args[2]);
              } else if (
                sql === "SELECT fluid_private.prepare_logo_input($1::uuid,$2::jsonb) AS value" &&
                args.length === 2
              ) {
                action = "input_prepare";
                intent = json(args[1]);
              } else if (
                sql === "SELECT fluid_private.commit_logo_input($1::uuid,$2::jsonb,$3::jsonb,$4::jsonb) AS value" &&
                args.length === 4
              ) {
                action = "input_commit";
                intent = json(args[1]);
                evidence = { receipt: json(args[2]), evidence: json(args[3]) };
              } else if (
                sql === "SELECT fluid_private.quote_logo_vector_proposal($1::uuid,$2::jsonb) AS value" &&
                args.length === 2
              ) {
                action = "proposal_quote";
                evidence = json(args[1]);
                if (!evidence || typeof evidence !== "object" || !("request" in evidence)) throw unavailable();
                intent = evidence.request;
              } else throw unavailable();
              if (action !== "asset_readback" && args[0] !== project) throw new ApiError("not_found");
              const token = await issueSharedLogoRequest(auth, action, project, intent, signal);
              return lease.connection.query(
                "SELECT public.execute_shared_logo_request($1::text,$2::text,$3::jsonb,$4::jsonb) AS value",
                [token, action, JSON.stringify([project, intent]), evidence === null ? null : JSON.stringify(evidence)],
              );
            },
            release: (discard) => lease.connection.release(discard || transaction),
            discard: () => lease.connection.discard(),
          },
        };
      },
    };
  }
  return {
    async resolve(
      auth: AuthenticatedContext,
      projectId: string,
      signal?: AbortSignal,
    ): Promise<LogoRequestServiceResolution | null> {
      if (closed || signal?.aborted) throw unavailable();
      const ownerId = logoOwner(auth);
      projectId = logoId(projectId);
      // Ordinary account proof precedes any privileged dependency or Storage token.
      await getLogoWorkspace(auth, projectId, signal);
      const connections = factory(auth, projectId),
        lease = await baseFactory(auth).acquire(ownerId, signal);
      let discard = false;
      try {
        await qualifySharedLogoConnection(lease.connection, p, config!.origin);
      } catch {
        discard = true;
        throw unavailable();
      } finally {
        await lease.connection.release(discard);
      }
      const transport = await createLogoOwnerStorageTransport(
        auth,
        projectId,
        { publishableKey: config!.publishableKey, fetch: dependencies.fetch, sharedSupabaseOrigin: config!.origin },
        signal,
      );
      const storage = createSupabasePrivateAssetStorage({
        scope: { kind: "identity", ownerId, projectId },
        transport,
        sharedSupabaseOrigin: config!.origin,
      });
      return { ownerId, projectId, dependencies: { connections, storage } };
    },
    close() {
      closed = true;
      return (closure ??= pool.end().catch(() => {
        throw unavailable();
      }));
    },
  };
}
