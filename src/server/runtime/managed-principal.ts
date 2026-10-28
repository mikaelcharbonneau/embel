import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError } from "@/server/http/errors";
import type { IdentityTransactionConnection } from "@/server/data/identity-transaction";

export const MANAGED_PRINCIPAL_BODY_SHA256 = "292a03340b72444ecc248921cc159c0a02a7338a2ab6cb093666d6e78f0e9017";
export const managedQualificationSchema = z.strictObject({ managementVersion: z.literal(2), generation: z.number().int().positive(),
  revision: z.number().int().positive(), operationKey: z.uuid(),
  capability: z.enum(["home_attachments", "identity_transactions", "strategy", "naming", "logo"]),
  managerRoleName: z.literal("embel_account_role_manager"), managerRoleOid: z.number().int().min(1).max(4_294_967_295),
});
export type ManagedQualification = z.infer<typeof managedQualificationSchema>;
export const managedPrincipalProofSchema = z.strictObject({ version: z.literal(2), ownerId: z.uuid(), generation: z.number().int().positive(),
  revision: z.number().int().positive(), operationKey: z.uuid(), capability: managedQualificationSchema.shape.capability,
  roleName: z.string(), roleOid: z.number().int().min(1).max(4_294_967_295),
  managerRoleName: z.literal("embel_account_role_manager"), managerRoleOid: z.number().int().min(1).max(4_294_967_295), identityHelperOwnerQualified: z.boolean(),
});
const unavailable = () => new ApiError("integration_unavailable");

/** Explicit v2 only. Legacy/dev callers never gain an incoming-membership
 * exception. This read-only own-session proof independently validates exactly
 * the retained PG17 ADMIN/noSET/noINHERIT manager edge and current enrollment. */
export async function readManagedPrincipalProof(connection: IdentityTransactionConnection,
  expected: { ownerId: string; roleName: string; roleOid: number } & ManagedQualification) {
  const option = managedQualificationSchema.safeParse({ managementVersion: expected.managementVersion, generation: expected.generation,
    revision: expected.revision, operationKey: expected.operationKey, capability: expected.capability,
    managerRoleName: expected.managerRoleName, managerRoleOid: expected.managerRoleOid });
  if (!option.success) throw unavailable();
  const result = await connection.query(`SELECT p.prosrc AS body,
    (pg_catalog.pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.provolatile='s' AND NOT p.proleakproof
     AND p.proconfig=ARRAY['search_path=""'] AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
     AND pg_catalog.has_function_privilege(session_user,p.oid,'EXECUTE')
     AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
       WHERE a.privilege_type='EXECUTE' AND (a.grantee=0 OR a.grantee IN
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN('anon','authenticated','service_role'))))) AS trusted
    FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure('public.account_enrollment_managed_principal()')`);
  const metadata = z.strictObject({ body: z.string(), trusted: z.literal(true) }).safeParse(result.rows[0]);
  if (result.rows.length !== 1 || !metadata.success || createHash("sha256").update(metadata.data.body).digest("hex") !== MANAGED_PRINCIPAL_BODY_SHA256) throw unavailable();
  const row = z.strictObject({ value: managedPrincipalProofSchema }).safeParse((await connection.query("SELECT public.account_enrollment_managed_principal() AS value")).rows[0]);
  if (!row.success) throw unavailable();
  const proof = row.data.value;
  if (proof.ownerId !== expected.ownerId.toLowerCase() || proof.roleName !== expected.roleName || proof.roleOid !== expected.roleOid ||
    proof.generation !== expected.generation || proof.revision !== expected.revision || proof.operationKey !== expected.operationKey.toLowerCase() ||
    proof.capability !== expected.capability || proof.managerRoleName !== expected.managerRoleName || proof.managerRoleOid !== expected.managerRoleOid) throw unavailable();
  return proof;
}
