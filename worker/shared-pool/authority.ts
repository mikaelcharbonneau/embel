import "server-only";
import { z } from "zod";
import { sharedLaneSchema,type SharedLane } from "./contracts";
import type { SharedSlotDatabase } from "./contracts";
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
export const sharedAuthorityManifestSchema=z.strictObject({version:z.literal(1),packets:z.array(z.strictObject({path:z.string().regex(/^supabase\/candidates\/[a-z0-9_]+\.sql$/u),sha256:hash})).min(1).max(23),
 functions:z.array(z.strictObject({schema:z.enum(["public","fluid_private"]),name:z.string().regex(/^[_a-z][_a-z0-9]{0,62}$/u),argumentTypes:z.string().max(1024),sha256:hash,
  language:z.enum(["sql","plpgsql"]),volatility:z.enum(["i","s","v"]),securityDefiner:z.boolean(),leakproof:z.boolean(),owner:z.string().min(1).max(63),
  searchPath:z.array(z.string()).max(10).nullable(),broadExecute:z.boolean(),lanes:z.array(sharedLaneSchema).max(3)})).min(1).max(512)});
export type SharedAuthorityManifest=z.infer<typeof sharedAuthorityManifestSchema>;
const unavailable=()=>Error("shared_pool_authority_manifest_unavailable");
function key(schema:string,name:string,args:string){return`${schema}.${name}(${args.split(",").map(value=>value.trim()).join(",")})`;}
/** Called inside BEGIN READ ONLY / SET LOCAL search_path=''. One catalog query
 * validates the bounded new/changed source-owned authority graph before any
 * proof RPC. It neither needs private schema USAGE nor calls private functions. */
export async function verifySharedAuthorityCatalog(database:SharedSlotDatabase,lane:SharedLane,rawManifest:unknown){
 const manifest=sharedAuthorityManifestSchema.parse(rawManifest),required=manifest.functions.filter(fn=>fn.lanes.includes(lane));
 if(!required.length||new Set(required.map(fn=>key(fn.schema,fn.name,fn.argumentTypes))).size!==required.length)throw unavailable();
 const result=await database.query(`WITH expected AS (SELECT * FROM pg_catalog.jsonb_to_recordset($1::jsonb) AS e(schema_name text,function_name text,argument_types text))
  SELECT e.schema_name,e.function_name,e.argument_types,p.oid::bigint procedure_oid,
   pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex') body_sha256,l.lanname language,p.provolatile::text volatility,
   p.prosecdef security_definer,p.proleakproof leakproof,pg_catalog.pg_get_userbyid(p.proowner) owner,p.proconfig search_path,
   pg_catalog.has_function_privilege(session_user,p.oid,'EXECUTE') callable,
   EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    WHERE a.privilege_type='EXECUTE' AND (a.grantee=0 OR a.grantee IN(SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN('anon','authenticated','service_role')))) broad_execute
  FROM expected e LEFT JOIN pg_catalog.pg_namespace n ON n.nspname=e.schema_name
  LEFT JOIN pg_catalog.pg_proc p ON p.pronamespace=n.oid AND p.proname=e.function_name AND pg_catalog.oidvectortypes(p.proargtypes)=e.argument_types
  LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang`,[JSON.stringify(required.map(fn=>({schema_name:fn.schema,function_name:fn.name,argument_types:fn.argumentTypes})))]);
 if(result.rows.length!==required.length)throw unavailable();const actual=new Map<string,Record<string,unknown>>();
 for(const row of result.rows){
  if(typeof row.schema_name!=="string"||typeof row.function_name!=="string"||typeof row.argument_types!=="string"||!row.procedure_oid)throw unavailable();
  const id=key(row.schema_name,row.function_name,row.argument_types);if(actual.has(id))throw unavailable();actual.set(id,row);
 }
 for(const expected of required){const row=actual.get(key(expected.schema,expected.name,expected.argumentTypes));
  if(!row||row.body_sha256!==expected.sha256||row.language!==expected.language||row.volatility!==expected.volatility||row.security_definer!==expected.securityDefiner
   ||row.leakproof!==expected.leakproof||row.owner!==expected.owner||row.broad_execute!==expected.broadExecute||JSON.stringify(row.search_path)!==JSON.stringify(expected.searchPath))throw unavailable();
 }
 return {manifest,required,lookup:(schema:string,name:string,args:string)=>actual.get(key(schema,name,args))};
}
