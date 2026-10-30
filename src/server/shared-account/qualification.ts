import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { IdentityTransactionConnection } from "@/server/data/identity-transaction";
import { ApiError } from "@/server/http/errors";
import type { SharedHttpPrincipal } from "./configuration";
import { sharedCustomerStorageHelperHash,sharedLegacyStorageHelperHash,qualifySharedCustomerStoragePolicy } from "./customer-storage-qualification";

/** Exact reviewed source packet; no readiness result is cached. */
export const sharedHttpHelperHashes = Object.freeze({
  "fluid_private.shared_http_customer_storage_live()": sharedCustomerStorageHelperHash,
  "fluid_private.shared_storage_legacy_registry_present()": sharedLegacyStorageHelperHash,
  "fluid_private.shared_account_customer_active(uuid)": "f35bbce1991646f0e34a4af2fdf5f37fd928ea11f5f92d46c6b4567ed2a34fa2",
  "fluid_private.shared_http_context_closed()": "0e889b32656f3d7a208387e61bda53e762323cae239134655dcef3c1ed285404",
  "fluid_private.shared_http_role(text)": "e3eb8a5c3f542c7b3594ea39095ffc379bce1960605263d746a70afdd17ba6d4",
  "fluid_private.shared_http_live(uuid,uuid,timestamptz)": "3975541067c65549a7c75d26b67b7dde1f9bc415bcfbefe82c52ba512e038a60",
  "public.issue_shared_account_request(text,text,jsonb)": "786692f06333a55000e014ab690874254ecab7fde5fa241b86bb59229bd92217",
  "fluid_private.shared_http_redeem(text,text,text,jsonb)": "bf1cb6344be24a9b6b9ca46d1e8c48f911b0fde7ec07b5449918b3791c92c11d",
  "fluid_private.shared_http_context_owner(text)": "ffb18d814fd795d70a60f202f3775308f5afa7159628b932a39a450ff489b354",
  "public.prepare_shared_identity_request(text,uuid,jsonb,boolean)": "d82c963bb2068853da207515b7cc6324ea2812093a0214598f43b3fc266ddaa2",
  "public.commit_shared_identity_request(uuid,jsonb,jsonb)": "13dd220ded08b5f53419a254ab9d4170d40b582744934312363e90a38de7688a",
  "public.finish_shared_identity_request()": "326fad1a1ecb88c9d98f6aac17c850bebef29950409935d71eb48f1d396da265",
  "public.execute_shared_home_request(text,text,jsonb,jsonb)": "064e898d7fb743ef570c3ab6fd5da5b82594cd7aeb4f508c7ef064f7145bc59f",
  "public.shared_account_http_principal()": "64ab03fcab952b474a9e87df58c30d11c862727dd237549da4e0095880cc24cc",
  "fluid_private.identity_web_owner()": "b14fbff21d2585886f46f34a4e5d3911edf433561928d85c788da490f63f6131",
  // Selected-logo boards extend these writers with captured logo-brief evidence.
  "fluid_private.prepare_identity_transaction(uuid,jsonb,boolean)": "7eeebe5a9d06a4cf03eb172017b5287f1cfc728e8280aa9468ef1cb01ffa705d",
  "fluid_private.commit_identity_transaction(uuid,jsonb,jsonb)": "a71ce5e81b90668260cabf1162abf30c9dc299234ce3e459efc25b511eb5d0a3",
  "fluid_private.home_attachment_owner()": "d56e97decff5330b4ad9a0ac36c9e1c56987b9e2ea07f3652c45f5d11b8fc291",
  "fluid_private.prepare_home_attachment(jsonb,bigint)": "c0eb091e034e62845fa67e75e8b8049a066c0677f980ebb7961d95866824a402",
  "fluid_private.observe_home_attachment(uuid,jsonb)": "fce80bafee4f77b9f1985e6d0235b065adeddfe26d3cab01f748f8e29e72edc8",
  "fluid_private.lookup_home_attachment(uuid)": "289abf1c70b7f4fdb9e2e195bb896b71b6f7ad4b22c4b28b1d45d384b38ea206",
  "fluid_private.resolve_home_attachments(uuid[])": "c3d252d83aa79a51c3c294e2b1071fbe2c59ee725af8d72df3a8bc2ebb41d849"
});
const proofSchema = z.strictObject({ version: z.literal(1), lane: z.enum(["home", "identity"]), roleName: z.string(), roleOid: z.coerce.number().int().positive(), origin: z.string() });
const rowSchema = z.strictObject({ signature: z.string(), body: z.string(), owner: z.string(), definer: z.boolean(), language: z.string(), volatility: z.string(), safe_path: z.boolean(), no_public_execute: z.boolean(), http_owner_execute: z.boolean() });
export async function qualifySharedHttpConnection(connection: IdentityTransactionConnection, lane: "home" | "identity", principal: SharedHttpPrincipal, origin: string): Promise<void> {
  const unavailable = () => new ApiError("integration_unavailable");
  const functions = await connection.query(`SELECT expected.signature,p.prosrc AS body,pg_catalog.pg_get_userbyid(p.proowner) AS owner,p.prosecdef AS definer,
    (SELECT lanname FROM pg_catalog.pg_language WHERE oid=p.prolang) AS language,p.provolatile::text AS volatility,
    (p.proconfig=ARRAY['search_path=""'] AND NOT p.proleakproof) AS safe_path,
    NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS no_public_execute,
    EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='postgres') AND a.privilege_type='EXECUTE') AS http_owner_execute
    FROM ROWS FROM(pg_catalog.unnest($1::text[]),pg_catalog.unnest($2::text[])) AS expected(signature,arguments)
    JOIN pg_catalog.pg_namespace n ON n.nspname=pg_catalog.split_part(expected.signature,'.',1)
    JOIN pg_catalog.pg_proc p ON p.pronamespace=n.oid AND p.proname=pg_catalog.split_part(pg_catalog.split_part(expected.signature,'(',1),'.',2)
      AND pg_catalog.oidvectortypes(p.proargtypes)=expected.arguments`, [Object.keys(sharedHttpHelperHashes),
      Object.keys(sharedHttpHelperHashes).map(signature => signature.slice(signature.indexOf("(") + 1, -1).replaceAll("timestamptz", "timestamp with time zone").split(",").join(", "))]);
  if (functions.rows.length !== Object.keys(sharedHttpHelperHashes).length) throw unavailable();
  const seen = new Set<string>();
  for (const raw of functions.rows) {
    const row = rowSchema.parse(raw), hash = sharedHttpHelperHashes[row.signature as keyof typeof sharedHttpHelperHashes];
    const writer = ["fluid_private.prepare_identity_transaction(uuid,jsonb,boolean)", "fluid_private.commit_identity_transaction(uuid,jsonb,jsonb)"].includes(row.signature);
    const sql = ["fluid_private.shared_storage_legacy_registry_present()", "fluid_private.shared_http_live(uuid,uuid,timestamptz)", "fluid_private.shared_account_customer_active(uuid)"].includes(row.signature);
    const stable = ["fluid_private.shared_storage_legacy_registry_present()", "fluid_private.shared_account_customer_active(uuid)", "fluid_private.shared_http_role(text)", "fluid_private.shared_http_context_owner(text)", "public.shared_account_http_principal()",
      "fluid_private.identity_web_owner()", "fluid_private.home_attachment_owner()", "fluid_private.lookup_home_attachment(uuid)", "fluid_private.resolve_home_attachments(uuid[])"].includes(row.signature);
    // The HTTP wrappers run as postgres, but the two writers have a different
    // owner. Supabase's postgres is not a superuser: require the actual nested
    // EXECUTE grant, even when a local superuser would bypass its absence.
    if (!hash || seen.has(row.signature) || createHash("sha256").update(row.body).digest("hex") !== hash || !row.safe_path || !row.no_public_execute
      || (writer && !row.http_owner_execute)
      || row.language !== (sql ? "sql" : "plpgsql") || row.volatility !== (stable ? "s" : "v")
      || row.owner !== (writer ? "fluid_identity_writer_definer_v1" : "postgres") || row.definer !== (row.signature !== "fluid_private.identity_web_owner()")) throw unavailable();
    seen.add(row.signature);
  }
  // Verify callable source before executing even the read-only identity proof.
  await qualifySharedCustomerStoragePolicy(connection);
  const result = await connection.query("SELECT public.shared_account_http_principal() AS value");
  const row = result.rows[0] as { value?: unknown } | undefined, proof = proofSchema.safeParse(row?.value);
  if (result.rows.length !== 1 || !proof.success || proof.data.lane !== lane || proof.data.roleName !== principal.roleName || proof.data.roleOid !== principal.roleOid || proof.data.origin !== origin) throw unavailable();
}
