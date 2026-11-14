import "server-only";

export const sharedCustomerStorageHelperHash = "063abd63edbfb2608e3fea7ffbdb59dda98e1c3df18369fc3d03e6bd6c6d4866";
export const sharedLegacyStorageHelperHash = "3a3607b99aaaddc0b5fc5922a327a6538192b3ac50036732c68f64b04bc5c063";

/** Pure catalog qualification shared by fixed web and worker connections. No
 * configuration, credential, HTTP, driver construction or proof RPC imports. */
const sharedStoragePolicyQualificationSql = `WITH shared_storage_required(policy_name,helper_name,body_sha256,language_name,volatility,expression) AS (VALUES
 ('embel_shared_customer_storage_live','shared_http_customer_storage_live','${sharedCustomerStorageHelperHash}','plpgsql','v',
  $customer$((bucket_id <> 'fluid-assets'::text) OR ( SELECT fluid_private.shared_http_customer_storage_live() AS shared_http_customer_storage_live))$customer$),
 ('embel_shared_legacy_storage_registry_fence','shared_storage_legacy_registry_present','${sharedLegacyStorageHelperHash}','sql','s',
  $legacy$((bucket_id <> 'fluid-assets'::text) OR ( SELECT fluid_private.shared_storage_legacy_registry_present() AS shared_storage_legacy_registry_present))$legacy$)
 ) SELECT count(*)=2 AND coalesce(bool_and((
  c.relrowsecurity AND NOT policy.polpermissive AND policy.polcmd='*'
  AND policy.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='authenticated')]
  AND pg_catalog.pg_get_expr(policy.polqual,policy.polrelid)=required.expression
  AND pg_catalog.pg_get_expr(policy.polwithcheck,policy.polrelid)=required.expression
  AND pg_catalog.pg_get_userbyid(helper.proowner)='postgres' AND helper.prosecdef AND NOT helper.proleakproof
  AND helper.proconfig=ARRAY['search_path=""'] AND helper.provolatile::text=required.volatility
  AND language.lanname=required.language_name
  AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(helper.prosrc,'UTF8')),'hex')=required.body_sha256
  AND EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(helper.proacl,pg_catalog.acldefault('f',helper.proowner))) acl
   WHERE acl.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='authenticated') AND acl.privilege_type='EXECUTE' AND NOT acl.is_grantable)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(helper.proacl,pg_catalog.acldefault('f',helper.proowner))) acl
   WHERE acl.grantee<>helper.proowner AND NOT(acl.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='authenticated') AND acl.privilege_type='EXECUTE' AND NOT acl.is_grantable))
 ) IS TRUE),false) AS valid
 FROM shared_storage_required required
 JOIN pg_catalog.pg_namespace n ON n.nspname='storage'
 JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname='objects'
 JOIN pg_catalog.pg_policy policy ON policy.polrelid=c.oid AND policy.polname=required.policy_name
 JOIN pg_catalog.pg_namespace private_namespace ON private_namespace.nspname='fluid_private'
 JOIN pg_catalog.pg_proc helper ON helper.pronamespace=private_namespace.oid AND helper.proname=required.helper_name AND helper.pronargs=0
 JOIN pg_catalog.pg_language language ON language.oid=helper.prolang`;

export async function qualifySharedStoragePolicies(connection: {
  query(sql: string): Promise<{ rows: unknown[] }>;
}): Promise<void> {
  const result = await connection.query(sharedStoragePolicyQualificationSql);
  if (result.rows.length !== 1 || (result.rows[0] as { valid?: unknown }).valid !== true)
    throw new Error("shared_storage_policy_unavailable");
}
