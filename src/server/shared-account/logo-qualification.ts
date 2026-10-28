import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { IdentityTransactionConnection } from "@/server/data/identity-transaction";
import type { SharedHttpPrincipal } from "./configuration";
import { ApiError } from "@/server/http/errors";
import { sharedCustomerStorageHelperHash,sharedLegacyStorageHelperHash,qualifySharedCustomerStoragePolicy } from "./customer-storage-qualification";
export const sharedLogoAdvancedHelperSignatures: readonly string[] = Object.freeze([
  "fluid_private.shared_logo_read_proposal_command(uuid,jsonb)",
  "fluid_private.shared_logo_apply_proposal_command(uuid,jsonb,jsonb)",
  "fluid_private.shared_logo_quote_vector_proposal(uuid,jsonb)",
]);
const invokerHelpers = new Set(sharedLogoAdvancedHelperSignatures.slice(0, 2));
export const sharedLogoHttpHelperHashes: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "fluid_private.shared_http_customer_storage_live()": [sharedCustomerStorageHelperHash],
  "fluid_private.shared_storage_legacy_registry_present()": [sharedLegacyStorageHelperHash],
  "fluid_private.quote_logo_vector_proposal(uuid,jsonb)": ["c5795a597d0c03bbebd7b07b8edffd99faf94f70b25282984f3711a7a51ac35d"],
  "fluid_private.shared_logo_http_context_closed()": [
    "4b3427e1bd7e819438006da374765b76be5c9edd92e5e897b634c0beda8c727e"
  ],
  "fluid_private.shared_logo_http_role(text)": [
    "441ec8b4cb37b3028e58e961d6d12e29aa156db40ccd078cd735c96212d6eb51"
  ],
  "fluid_private.shared_logo_http_live(uuid,uuid,timestamptz)": [
    "3975541067c65549a7c75d26b67b7dde1f9bc415bcfbefe82c52ba512e038a60"
  ],
  "public.issue_shared_logo_request(text,jsonb)": [
    "c3bb5c57ef7a489d0dad9a215f2fcc09092cce035f3964af0769770bcfdc8c39"
  ],
  "fluid_private.shared_logo_http_redeem(text,text,text,jsonb)": [
    "d4a2a8938ad6bd395a793d007b98fa4261da097706a75393b0eeaccb812611cd"
  ],
  "fluid_private.shared_logo_http_context_owner(text)": [
    "0112e44ac8f7bb233e7c5383dfb328b7e15f7b99d48221471889a4871df7f85b"
  ],
  "public.execute_shared_logo_request(text,text,jsonb,jsonb)": [
    "24f89a8859e6c06fc92f15375c80347576b5ee1715ede9ac202c89520d92d851"
  ],
  "fluid_private.shared_logo_read_proposal_command(uuid,jsonb)": [
    "f172a06b6bceacee4ebffbee9b76139a92939688d36fcfa0ec4a239e2bc75394"
  ],
  "fluid_private.shared_logo_apply_proposal_command(uuid,jsonb,jsonb)": [
    "7f22e0c3539ef2957307b48cacc3afca30f7e1c55bb59940ef766608ec74e137"
  ],
  "fluid_private.shared_logo_quote_vector_proposal(uuid,jsonb)": [
    "c72b42196280e5b783473092de72f011215bd0cb2c1ad2d43f634545c150f5f6"
  ],
  "public.shared_logo_http_principal()": [
    "92cbd3fcbd0f8dcbd170802704da243f8580db41e4f8c2fbba90ba94d08a67ef"
  ],
  "fluid_private.logo_asset_web_owner()": [
    "4ab7d0233949f8f484eae4ec77a77520d362ee27a1e8001de6dd417e2a0c8c30"
  ],
  "fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid)": [
    "95367a355663f4035d5df7aacc04855af132ca34304f38e6ff61b80f07b29f71"
  ],
  "fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid)": [
    "a87f2e9aafabbfc89e08357f48b6a81df038023211566c40962d09347fceb95c"
  ],
  "fluid_private.prepare_logo_input(uuid,jsonb)": [
    "5cfb4864f38af2ac2ec7ae2fc21f7f9b4e1a3b9f2b876eb22b13bba84a67ffa6"
  ],
  "fluid_private.commit_logo_input(uuid,jsonb,jsonb,jsonb)": [
    "6e429e8d3851a9a25d67d60cbecf0ee1e8cbe4a9e4aed71409424a9a6f8b0c8c"
  ],
  "fluid_private.shared_account_customer_active(uuid)": [
    "f35bbce1991646f0e34a4af2fdf5f37fd928ea11f5f92d46c6b4567ed2a34fa2"
  ],
  "fluid_private.read_logo_trusted_request(uuid,jsonb)": [
    "76711bfe2bc73d344d182f37030301cf2fb97b78245542c42432977db31572fb",
    "2cedc3568f7f73675c194efd06fa4c0c9e2e8ed62ee91226ac0b766ee4d7d5b6"
  ],
  "fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb)": [
    "15f472a5352e6a28eaaac104ab345c93cf0aeb5afee8c43c4ab99c17bcb24fd4",
    "e255a6c50b7b532e8a328043ef554227bb73c3e691f36d4252887f3f5f6f377b"
  ]
});
const rowSchema = z.strictObject({ signature:z.string(),body:z.string(),owner:z.literal("postgres"),definer:z.boolean(),language:z.string(),volatility:z.string(),safe_path:z.literal(true),no_public_execute:z.literal(true) });
const proofSchema=z.strictObject({version:z.literal(1),lane:z.literal("logo"),roleName:z.string(),roleOid:z.coerce.number().int().positive(),origin:z.string()});
export async function qualifySharedLogoConnection(connection:IdentityTransactionConnection,principal:SharedHttpPrincipal,origin:string) {
 const unavailable=()=>new ApiError("integration_unavailable"),signatures=Object.keys(sharedLogoHttpHelperHashes);
 const rows=await connection.query(`SELECT expected.signature,p.prosrc body,pg_catalog.pg_get_userbyid(p.proowner) owner,p.prosecdef definer,
  (SELECT lanname FROM pg_catalog.pg_language WHERE oid=p.prolang) AS language,p.provolatile::text volatility,
  (p.proconfig=ARRAY['search_path=""'] AND NOT p.proleakproof) safe_path,
  NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') no_public_execute
  FROM ROWS FROM(pg_catalog.unnest($1::text[]),pg_catalog.unnest($2::text[])) expected(signature,arguments)
  JOIN pg_catalog.pg_namespace n ON n.nspname=pg_catalog.split_part(expected.signature,'.',1)
  JOIN pg_catalog.pg_proc p ON p.pronamespace=n.oid AND p.proname=pg_catalog.split_part(pg_catalog.split_part(expected.signature,'(',1),'.',2)
   AND pg_catalog.oidvectortypes(p.proargtypes)=expected.arguments`,[signatures,signatures.map(s=>s.slice(s.indexOf("(")+1,-1).replaceAll("timestamptz","timestamp with time zone").split(",").join(", "))]);
 const optionalQuote="fluid_private.quote_logo_vector_proposal(uuid,jsonb)";
 const optionalSignatures=new Set([optionalQuote,...sharedLogoAdvancedHelperSignatures]);
 if(rows.rows.length<signatures.length-optionalSignatures.size||rows.rows.length>signatures.length)throw unavailable();
 const seen=new Map<string,string>();
 for(const raw of rows.rows){
  const row=rowSchema.parse(raw),hash=createHash("sha256").update(row.body).digest("hex");
  const sql=["fluid_private.shared_storage_legacy_registry_present()","fluid_private.shared_logo_http_live(uuid,uuid,timestamptz)","fluid_private.shared_account_customer_active(uuid)"].includes(row.signature);
  const stable=["fluid_private.shared_storage_legacy_registry_present()","fluid_private.shared_logo_http_role(text)","fluid_private.shared_logo_http_context_owner(text)","public.shared_logo_http_principal()","fluid_private.logo_asset_web_owner()","fluid_private.read_logo_trusted_request(uuid,jsonb)","fluid_private.shared_account_customer_active(uuid)"].includes(row.signature);
  if(seen.has(row.signature)||!sharedLogoHttpHelperHashes[row.signature]?.includes(hash)||row.definer!==!invokerHelpers.has(row.signature)||row.language!==(sql?"sql":"plpgsql")||row.volatility!==(stable?"s":"v"))throw unavailable();
  seen.set(row.signature,hash);
 }
 if(signatures.some(signature=>!optionalSignatures.has(signature)&&!seen.has(signature)))throw unavailable();
 // Baseline-only installs have no advanced delegates. An advanced install must
 // qualify the complete fixed group even when no worker is running.
 const advancedCount=sharedLogoAdvancedHelperSignatures.filter(signature=>seen.has(signature)).length;
 if(advancedCount!==0&&advancedCount!==sharedLogoAdvancedHelperSignatures.length)throw unavailable();
 // Baseline and materialization versions are qualified pairs, never a mixed historical/new contract.
 if(sharedLogoHttpHelperHashes["fluid_private.read_logo_trusted_request(uuid,jsonb)"]!.indexOf(seen.get("fluid_private.read_logo_trusted_request(uuid,jsonb)")!)
  !==sharedLogoHttpHelperHashes["fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb)"]!.indexOf(seen.get("fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb)")!))throw unavailable();
 await qualifySharedCustomerStoragePolicy(connection);
 const result=await connection.query("SELECT public.shared_logo_http_principal() AS value"),proof=proofSchema.safeParse((result.rows[0] as {value?:unknown}|undefined)?.value);
 if(result.rows.length!==1||!proof.success||proof.data.roleName!==principal.roleName||proof.data.roleOid!==principal.roleOid||proof.data.origin!==origin)throw unavailable();
}
