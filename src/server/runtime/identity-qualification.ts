import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError } from "@/server/http/errors";
import type { IdentityConnectionFactory } from "@/server/data/identity-transaction";
import { readManagedPrincipalProof, type ManagedQualification } from "./managed-principal";

const unavailable = () => new ApiError("integration_unavailable");
const helperOwner = "fluid_identity_writer_definer_v1";
// Reviewed local SQL contract. Runtime never reads or installs test SQL, creates
// a role, or provisions a binding. An operator must qualify these helpers first.
const helpers = {
  identity_web_owner: { hash: "b14fbff21d2585886f46f34a4e5d3911edf433561928d85c788da490f63f6131", definer: false, owner: "postgres", volatility: "s" },
  prepare_identity_transaction: { hash: "7eeebe5a9d06a4cf03eb172017b5287f1cfc728e8280aa9468ef1cb01ffa705d", definer: true, owner: helperOwner, volatility: "v" },
  commit_identity_transaction: { hash: "a71ce5e81b90668260cabf1162abf30c9dc299234ce3e459efc25b511eb5d0a3", definer: true, owner: helperOwner, volatility: "v" },
} as const;

const loginSchema = z.strictObject({ role_name: z.string(), role_oid: z.coerce.number().int().positive(), restricted: z.literal(true), incoming_safe: z.boolean() });
const helperSchema = z.strictObject({
  name: z.string(), body: z.string(), definer: z.boolean(), owner: z.string(), volatility: z.string(),
  safe_path: z.literal(true), no_public_execute: z.literal(true), trusted_owner: z.boolean(), owner_attributes: z.literal(true), callable: z.literal(true),
});
const loginSql = `SELECT session_user::text AS role_name, r.oid::bigint AS role_oid,
  (r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolinherit AND NOT r.rolcreatedb
   AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid)
   AND pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CONNECT')
   AND pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'TEMP')
   AND NOT pg_catalog.has_schema_privilege(r.oid,'public','CREATE')
   AND NOT pg_catalog.has_schema_privilege(r.oid,'fluid_private','CREATE')
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=r.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=r.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname IN ('public','fluid_private','auth','storage') AND c.relkind IN ('r','p','v','m','f')
     AND (pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
       OR pg_catalog.has_table_privilege(r.oid,c.oid,'DELETE,TRUNCATE,TRIGGER')))) AS restricted,
  NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid=r.oid) AS incoming_safe
  FROM pg_catalog.pg_roles r WHERE r.rolname=session_user`;
const helpersSql = `SELECT p.proname AS name,p.prosrc AS body,p.prosecdef AS definer,
  o.rolname::text AS owner,p.provolatile::text AS volatility,
  (p.proname='identity_web_owner' OR pg_catalog.has_function_privilege(session_user,p.oid,'EXECUTE')) AS callable,
  (p.proconfig=ARRAY['search_path=""'] AND NOT p.proleakproof
   AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')) AS safe_path,
  NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
   WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS no_public_execute,
  (NOT p.prosecdef OR (NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolinherit AND NOT o.rolcreatedb
   AND NOT o.rolcreaterole AND NOT o.rolreplication AND NOT o.rolbypassrls
   AND pg_catalog.has_database_privilege(o.oid,pg_catalog.current_database(),'TEMP')
   AND pg_catalog.has_schema_privilege(o.oid,'public','USAGE') AND pg_catalog.has_schema_privilege(o.oid,'fluid_private','USAGE')
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=o.oid))) AS owner_attributes,
  (NOT p.prosecdef OR (NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolinherit AND NOT o.rolcreatedb
   AND NOT o.rolcreaterole AND NOT o.rolreplication AND NOT o.rolbypassrls
   AND pg_catalog.has_database_privilege(o.oid,pg_catalog.current_database(),'TEMP')
   AND pg_catalog.has_schema_privilege(o.oid,'public','USAGE')
   AND pg_catalog.has_schema_privilege(o.oid,'fluid_private','USAGE')
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=o.oid OR m.roleid=o.oid))) AS trusted_owner
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles o ON o.oid=p.proowner
  WHERE p.oid=ANY(ARRAY[
   pg_catalog.to_regprocedure('fluid_private.identity_web_owner()')::oid,
   pg_catalog.to_regprocedure('fluid_private.prepare_identity_transaction(uuid,jsonb,boolean)')::oid,
   pg_catalog.to_regprocedure('fluid_private.commit_identity_transaction(uuid,jsonb,jsonb)')::oid])`;

/** The pinned helper checks actual login/OID and its administrative owner
 * binding before rejecting this deliberately invalid request. That rejection
 * precedes its temporary table, locks, project reads and every mutation. The
 * probe always rolls back, never constructs an Identity result or calls AI. */
export async function qualifyIdentityConnection(factory: IdentityConnectionFactory, ownerId: string, roleName: string, roleOid: number, signal?: AbortSignal, managed?: ManagedQualification) {
  const lease = await factory.acquire(ownerId, signal);
  let began = false, qualified = false;
  try {
    began = true;
    await lease.connection.query("BEGIN");
    await lease.connection.query("SET LOCAL statement_timeout = '5000ms'");
    await lease.connection.query("SET LOCAL lock_timeout = '1500ms'");
    await lease.connection.query("SET LOCAL idle_in_transaction_session_timeout = '5000ms'");
    const login = loginSchema.parse((await lease.connection.query(loginSql)).rows[0]);
    if (login.role_name !== roleName || login.role_oid !== roleOid || lease.binding.ownerId !== ownerId ||
      lease.binding.roleName !== roleName || lease.binding.roleOid !== roleOid) throw unavailable();
    if (!login.incoming_safe && !managed || managed && managed.capability !== "identity_transactions") throw unavailable();
    const proof = managed ? await readManagedPrincipalProof(lease.connection, { ownerId, roleName, roleOid, ...managed }) : null;
    const rows = (await lease.connection.query(helpersSql)).rows.map(row => helperSchema.parse(row));
    if (rows.length !== 3 || new Set(rows.map(row => row.name)).size !== 3) throw unavailable();
    for (const row of rows) {
      const expected = helpers[row.name as keyof typeof helpers];
      if (!expected || createHash("sha256").update(row.body).digest("hex") !== expected.hash ||
        row.definer !== expected.definer || row.owner !== expected.owner || row.volatility !== expected.volatility ||
        !row.trusted_owner && !proof?.identityHelperOwnerQualified) throw unavailable();
    }
    await lease.connection.query("SELECT pg_catalog.set_config('request.jwt.claim.sub',$1,true)", [ownerId]);
    try {
      await lease.connection.query("SELECT fluid_private.prepare_identity_transaction($1::uuid,$2::jsonb,false) AS value",
        ["00000000-0000-4000-8000-000000000000", "{}"]);
    } catch (error) {
      qualified = error !== null && typeof error === "object" && "code" in error && error.code === "22023" &&
        "message" in error && error.message === "invalid_identity_request";
    }
  } finally {
    let clean = false;
    try { if (began) await lease.connection.query("ROLLBACK"); clean = true; }
    finally {
      try { await lease.connection.release(!clean); }
      catch { await lease.connection.discard(); throw unavailable(); }
    }
  }
  if (!qualified || signal?.aborted) throw unavailable();
}
