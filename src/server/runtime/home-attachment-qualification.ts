import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { IdentityConnectionFactory } from "@/server/data/identity-transaction";
import { ApiError } from "@/server/http/errors";
import { readManagedPrincipalProof, type ManagedQualification } from "./managed-principal";

const unavailable = () => new ApiError("integration_unavailable");
const helpers = {
  home_attachment_owner: { hash: "d56e97decff5330b4ad9a0ac36c9e1c56987b9e2ea07f3652c45f5d11b8fc291", volatility: "s" },
  prepare_home_attachment: { hash: "c0eb091e034e62845fa67e75e8b8049a066c0677f980ebb7961d95866824a402", volatility: "v" },
  observe_home_attachment: { hash: "fce80bafee4f77b9f1985e6d0235b065adeddfe26d3cab01f748f8e29e72edc8", volatility: "v" },
  lookup_home_attachment: { hash: "289abf1c70b7f4fdb9e2e195bb896b71b6f7ad4b22c4b28b1d45d384b38ea206", volatility: "s" },
  resolve_home_attachments: { hash: "c3d252d83aa79a51c3c294e2b1071fbe2c59ee725af8d72df3a8bc2ebb41d849", volatility: "s" },
} as const;
const principalSchema = z.strictObject({ role_name: z.string(), effective_role: z.string(), role_oid: z.coerce.number().int().positive(), restricted: z.literal(true), incoming_safe: z.boolean() });
const helperSchema = z.strictObject({ name: z.string(), body: z.string(), owner: z.literal("postgres"), volatility: z.string(),
  definer: z.literal(true), safe_path: z.literal(true), callable: z.literal(true), no_public_execute: z.literal(true) });
const principalSql = `SELECT session_user::text AS role_name,current_user::text AS effective_role,r.oid::bigint AS role_oid,
 (r.rolcanlogin AND NOT (r.rolinherit OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=r.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=r.oid)
  AND NOT pg_catalog.has_schema_privilege(r.oid,'public','CREATE')
  AND NOT pg_catalog.has_schema_privilege(r.oid,'fluid_private','CREATE')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','fluid_private','storage','auth') AND c.relkind IN ('r','p','v','m','f')
    AND (pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
      OR pg_catalog.has_table_privilege(r.oid,c.oid,'DELETE,TRUNCATE,TRIGGER')))) AS restricted,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid=r.oid) AS incoming_safe
 FROM pg_catalog.pg_roles r WHERE r.rolname=session_user`;
const helpersSql = `SELECT p.proname AS name,p.prosrc AS body,pg_catalog.pg_get_userbyid(p.proowner) AS owner,
 p.provolatile::text AS volatility,p.prosecdef AS definer,
 (p.proconfig=ARRAY['search_path=""'] AND NOT p.proleakproof
  AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')) AS safe_path,
 pg_catalog.has_function_privilege(session_user,p.oid,'EXECUTE') AS callable,
 NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
  WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS no_public_execute
 FROM pg_catalog.pg_proc p WHERE p.oid=ANY(ARRAY[
  pg_catalog.to_regprocedure('fluid_private.home_attachment_owner()')::oid,
  pg_catalog.to_regprocedure('fluid_private.prepare_home_attachment(jsonb,bigint)')::oid,
  pg_catalog.to_regprocedure('fluid_private.observe_home_attachment(uuid,jsonb)')::oid,
  pg_catalog.to_regprocedure('fluid_private.lookup_home_attachment(uuid)')::oid,
  pg_catalog.to_regprocedure('fluid_private.resolve_home_attachments(uuid[])')::oid])`;

/** Catalog and actual owner proof only, inside a bounded read-only transaction.
 * No attachment is prepared/observed, no credential or grant is installed. */
export async function qualifyHomeAttachmentConnection(factory: IdentityConnectionFactory, ownerId: string, roleName: string, roleOid: number, signal?: AbortSignal, managed?: ManagedQualification) {
  const lease = await factory.acquire(ownerId, signal);
  let began = false;
  try {
    began = true;
    await lease.connection.query("BEGIN READ ONLY");
    await lease.connection.query("SET LOCAL statement_timeout = '5000ms'");
    await lease.connection.query("SET LOCAL idle_in_transaction_session_timeout = '5000ms'");
    const login = principalSchema.parse((await lease.connection.query(principalSql)).rows[0]);
    if (login.role_name !== roleName || login.effective_role !== roleName || login.role_oid !== roleOid ||
      lease.binding.ownerId !== ownerId || lease.binding.roleName !== roleName || lease.binding.roleOid !== roleOid) throw unavailable();
    if (!login.incoming_safe && !managed || managed && managed.capability !== "home_attachments") throw unavailable();
    if (managed) await readManagedPrincipalProof(lease.connection, { ownerId, roleName, roleOid, ...managed });
    const rows = (await lease.connection.query(helpersSql)).rows.map(row => helperSchema.parse(row));
    if (rows.length !== 5 || new Set(rows.map(row => row.name)).size !== 5) throw unavailable();
    for (const row of rows) {
      const expected = helpers[row.name as keyof typeof helpers];
      if (!expected || expected.volatility !== row.volatility || createHash("sha256").update(row.body).digest("hex") !== expected.hash) throw unavailable();
    }
    const owner = z.strictObject({ owner_id: z.uuid() }).parse((await lease.connection.query("SELECT fluid_private.home_attachment_owner() AS owner_id")).rows[0]);
    if (owner.owner_id.toLowerCase() !== ownerId || signal?.aborted) throw unavailable();
  } finally {
    let clean = false;
    try { if (began) await lease.connection.query("ROLLBACK"); clean = true; }
    finally {
      try { await lease.connection.release(!clean); }
      catch { await lease.connection.discard(); throw unavailable(); }
    }
  }
  if (signal?.aborted) throw unavailable();
}
