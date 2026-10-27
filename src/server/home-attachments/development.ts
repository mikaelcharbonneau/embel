import "server-only";
import type { ClientConfig } from "pg";
import JavaScriptClient from "pg/lib/client.js";
import { z } from "zod";
import type { AuthenticatedContext } from "@/server/auth/context";
import { getSupabaseConfiguration } from "@/server/config";
import { readDevelopmentConfiguration } from "@/server/development/config";
import type { IdentityConnectionFactory } from "@/server/data/identity-transaction";
import { ApiError } from "@/server/http/errors";
import { createSupabasePrivateAssetStorage } from "@/server/runtime/private-asset-storage";
import { PROPOSED_HOME_ATTACHMENT_POLICY } from "@/domain/attachments";
import { createHomeAttachmentService } from "./index";
import { createPostgresHomeAttachmentBackend } from "./postgres";

type Environment = Record<string, string | undefined>;
type AttachmentConfiguration = {
  ownerId: string; roleName: string; roleOid: number;
  database: ClientConfig & { replication: "false" }; supabaseUrl: string; publishableKey: string;
};
const unavailable = () => new ApiError("integration_unavailable");
const bindingSchema = z.object({
  ownerId: z.uuid(), roleName: z.string().regex(/^embel_dev_attachments_[a-z0-9_]+$/).max(63),
  roleOid: z.coerce.number().int().min(1).max(4_294_967_295),
});

/** Only a separately supplied local restricted principal; never creates roles,
 * reads a credential file, uses a service key or changes production routing. */
export function readDevelopmentAttachmentConfiguration(env: Environment = process.env): AttachmentConfiguration | null {
  const development = readDevelopmentConfiguration(env);
  if (!development) return null;
  try {
    const binding = bindingSchema.parse({ ownerId: env.EMBEL_DEVELOPMENT_ATTACHMENTS_OWNER_ID,
      roleName: env.EMBEL_DEVELOPMENT_ATTACHMENTS_ROLE_NAME, roleOid: env.EMBEL_DEVELOPMENT_ATTACHMENTS_ROLE_OID });
    if (!/^[1-9][0-9]*$/.test(env.EMBEL_DEVELOPMENT_ATTACHMENTS_ROLE_OID ?? "")) return null;
    const value = env.EMBEL_DEVELOPMENT_ATTACHMENTS_DATABASE_URL;
    if (!value || value.length > 8192 || /[\s\x00-\x1f\x7f]/.test(value) || !/@127\.0\.0\.1:[1-9][0-9]{3,4}\/postgres$/.test(value)) return null;
    const url = new URL(value), publicConfiguration = getSupabaseConfiguration(env);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1" ||
      !url.port || !/^[1-9][0-9]*$/.test(url.port) || Number(url.port) < 1024 || Number(url.port) > 65535 ||
      [new URL(development.supabaseUrl).port, new URL(development.origin).port].includes(url.port) ||
      url.pathname !== "/postgres" || url.search || url.hash || decodeURIComponent(url.username) !== binding.roleName ||
      !url.password || /[\x00-\x1f\x7f]/.test(decodeURIComponent(url.password)) || publicConfiguration.url !== development.supabaseUrl) return null;
    return { ...binding, ownerId: binding.ownerId.toLowerCase(), supabaseUrl: development.supabaseUrl,
      publishableKey: publicConfiguration.publishableKey, database: { host: "127.0.0.1", port: Number(url.port),
        database: "postgres", user: binding.roleName, password: decodeURIComponent(url.password), ssl: false,
        options: "-c row_security=on", client_encoding: "UTF8", replication: "false",
        connectionTimeoutMillis: 3000, statement_timeout: 5000, query_timeout: 5000,
        application_name: "embel-development-attachments" } };
  } catch { return null; }
}

export function createDevelopmentAttachmentConnectionFactory(configuration: AttachmentConfiguration): IdentityConnectionFactory {
  return { async acquire(ownerId, signal) {
    if (ownerId !== configuration.ownerId || signal?.aborted) throw unavailable();
    const client = new JavaScriptClient(configuration.database);
    // Client errors can retain connection properties. No raw error escapes.
    client.on("error", () => {});
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", abort);
      try { await client.end(); } catch { throw unavailable(); }
    };
    const abort = () => { void close().catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await client.connect();
      if (closed || signal?.aborted) throw unavailable();
      return { binding: { ownerId: configuration.ownerId, roleName: configuration.roleName, roleOid: configuration.roleOid },
        connection: {
          async query(sql, parameters) {
            if (closed || signal?.aborted) throw unavailable();
            try { const result = await client.query(sql, parameters ? [...parameters] : undefined);
              if (closed || signal?.aborted) throw unavailable(); return { rows: result.rows as unknown[] };
            } catch (error) {
              const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
              if (typeof code === "string" && ["P0002","23505","40001","PT409","22023","22P02","23514","23502"].includes(code))
                throw Object.assign(new Error("Development attachment operation failed"), { code });
              throw unavailable();
            }
          },
          release: close, discard: close,
        } };
    } catch { await close(); throw unavailable(); }
  } };
}

const qualification = `SELECT session_user::text AS role_name, current_user::text AS effective_role,
  r.oid::bigint AS role_oid, fluid_private.home_attachment_owner() AS owner_id,
  r.rolcanlogin AND NOT (r.rolinherit OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication) AS restricted,
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS no_memberships,
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner = r.oid) AS owns_no_relations,
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner = r.oid) AS owns_no_schemas,
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public','fluid_private','storage','auth') AND c.relkind IN ('r','p','v','m','f')
      AND pg_catalog.has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS no_direct_data_access,
  (SELECT count(*) = 5 FROM unnest(ARRAY['fluid_private.home_attachment_owner()',
    'fluid_private.prepare_home_attachment(jsonb,bigint)','fluid_private.observe_home_attachment(uuid,jsonb)',
    'fluid_private.lookup_home_attachment(uuid)','fluid_private.resolve_home_attachments(uuid[])']) AS helpers(signature)
    WHERE pg_catalog.to_regprocedure(signature) IS NOT NULL
      AND pg_catalog.has_function_privilege(current_user,pg_catalog.to_regprocedure(signature),'EXECUTE')) AS helpers_available
  FROM pg_catalog.pg_roles r WHERE r.rolname = session_user`;
const qualifiedSchema = z.strictObject({ role_name: z.string(), effective_role: z.string(), role_oid: z.coerce.number(), owner_id: z.uuid(),
  restricted: z.literal(true), no_memberships: z.literal(true), owns_no_relations: z.literal(true), owns_no_schemas: z.literal(true),
  no_direct_data_access: z.literal(true), helpers_available: z.literal(true) });

/** Readiness is actual read-only principal/helper qualification, not env presence.
 * Storage authorization is independently enforced by the caller's verified JWT
 * and provider RLS on each create-only upload and bounded authenticated read. */
export async function getDevelopmentHomeAttachmentService(auth: AuthenticatedContext) {
  const configuration = readDevelopmentAttachmentConfiguration();
  if (!configuration || auth.userId.toLowerCase() !== configuration.ownerId) return null;
  const factory = createDevelopmentAttachmentConnectionFactory(configuration);
  let lease: Awaited<ReturnType<IdentityConnectionFactory["acquire"]>> | undefined;
  try {
    lease = await factory.acquire(configuration.ownerId);
    const result = await lease.connection.query(qualification);
    if (result.rows.length !== 1) return null;
    const principal = qualifiedSchema.parse(result.rows[0]);
    if (principal.owner_id !== configuration.ownerId || principal.role_name !== configuration.roleName ||
      principal.effective_role !== configuration.roleName || principal.role_oid !== configuration.roleOid) return null;
    await lease.connection.release(false); lease = undefined;
    const { data, error } = await auth.client.auth.getSession();
    // getUser() already established auth.userId. Session is used only as a token
    // selector, never as an independent authorization source.
    const session = data.session;
    if (error || !session || session.user.id.toLowerCase() !== configuration.ownerId ||
      !/^[A-Za-z0-9._-]{1,16384}$/.test(session.access_token)) return null;
    const token = session.access_token;
    const storage = createSupabasePrivateAssetStorage({ scope: { kind: "home", ownerId: configuration.ownerId },
      developmentSupabaseUrl: configuration.supabaseUrl,
      transport: async (url, init) => {
        if (readDevelopmentConfiguration()?.supabaseUrl !== configuration.supabaseUrl ||
          !url.startsWith(`${configuration.supabaseUrl}/storage/v1/object/fluid-assets/`)) throw unavailable();
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${token}`); headers.set("apikey", configuration.publishableKey);
        return fetch(url, { ...init, headers });
      } });
    return createHomeAttachmentService({ backend: createPostgresHomeAttachmentBackend(factory), storage, policy: PROPOSED_HOME_ATTACHMENT_POLICY });
  } catch { return null; }
  finally { try { await lease?.connection.release(false); } catch { /* Remain unavailable; no credential diagnostics. */ } }
}
