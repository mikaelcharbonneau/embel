import "server-only";
import { createHash } from "node:crypto";
import { TLSSocket,checkServerIdentity } from "node:tls";
import type { Pool } from "pg";
import { z } from "zod";
import type { OwnerWorkerProcessDescriptor } from "./adapter";

// Source-only reviewed candidate. Installation and actual session proof remain
// independent; missing/mismatched helpers never become a drain fallback.
export const WORKER_OBSERVATION_BODY_SHA256="b61ac9b65bc7cd8fff803ac80586351fa0a8b1fba8fef3c83fedc1dad350bf04";
const unavailable=()=>Error("Owner worker observation is unavailable");
const statements=new Set([
 "select public.record_logo_provider_response($1,$2,$3) value",
 "select public.complete_logo_job_step($1,$2,$3,$4,$5,$6,$7)",
 "select public.finish_logo_job($1,$2,$3)",
 "select * from public.complete_job_step($1, $2, $3, $4, $5, $6, $7)",
 "select * from public.finish_job($1, $2, $3, $4)",
]);
export function isOwnerWorkerObservationStatement(sql:string){return statements.has(sql.replace(/\s+/gu," ").trim());}
/** Same actual restricted client for frozen observation identity and the one
 * allowlisted receipt/accounting operation. No claim, plan, begin, provider
 * dispatch, retry, asset publication or Storage authorization is exposed. */
export async function queryOwnerWorkerObservation(pool:Pool,descriptor:OwnerWorkerProcessDescriptor,sql:string,values:unknown[]){
 if(!isOwnerWorkerObservationStatement(sql))throw unavailable();const client=await pool.connect();let failed=true;
 try{
  const socket=client.connection.stream;if(!(socket instanceof TLSSocket)||!socket.encrypted||!socket.authorized||socket.authorizationError
   ||!["TLSv1.2","TLSv1.3"].includes(socket.getProtocol()??"")||checkServerIdentity(pool.options.host!,socket.getPeerCertificate()))throw unavailable();
  const metadata=await client.query(`SELECT p.prosrc body,(pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.provolatile='s' AND NOT p.proleakproof
   AND p.proconfig=ARRAY['search_path=""'] AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND has_function_privilege(session_user,p.oid,'EXECUTE')
   AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE (a.grantee=0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role'))) AND a.privilege_type='EXECUTE')) trusted
   FROM pg_proc p WHERE p.oid=to_regprocedure('public.account_worker_observation_principal()')`);
  const meta=z.strictObject({body:z.string(),trusted:z.literal(true)}).parse(metadata.rows[0]);
  if(metadata.rows.length!==1||createHash("sha256").update(meta.body).digest("hex")!==WORKER_OBSERVATION_BODY_SHA256)throw unavailable();
  const proof=await client.query("SELECT public.account_worker_observation_principal() value");
  if(proof.rows.length!==1)throw unavailable();
  const actual=proof.rows[0]?.value,expected=descriptor.binding;
  if(!actual||typeof actual!=="object"||Object.keys(actual).length!==Object.keys(expected).length||Object.entries(expected).some(([key,value])=>Reflect.get(actual,key)!==value))throw unavailable();
  const result=await client.query(sql,values);failed=false;return result;
 }catch{throw unavailable();}finally{client.release(failed?unavailable():undefined);}
}
