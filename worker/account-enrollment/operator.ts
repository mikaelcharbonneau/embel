import "server-only";
import JavaScriptClient from "pg/lib/client.js";
import JavaScriptPool from "pg-pool";
import { TLSSocket,checkServerIdentity } from "node:tls";
import { z } from "zod";
import type { EnrollmentOperatorPort } from "../../src/server/account-enrollment/contracts";
import { EnrollmentEffectUnavailable } from "../../src/server/account-enrollment/contracts";
import type { OwnerWorkerDatabaseSecret } from "./process-contracts";
import { restrictedOwnerPoolOptions } from "./process-qualification";

const names:Readonly<Record<string,number>>={claim_account_service_enrollment:1,read_account_service_enrollment_claim:2,record_account_service_enrollment:5,
 provision_account_enrollment_http:5,revoke_account_enrollment_http:3,acknowledge_account_enrollment_revocation:4,finish_account_service_enrollment:3,
 provision_account_worker_enrollment:6,adopt_account_worker_enrollment:5,publish_account_worker_enrollment:4,verify_account_worker_enrollment:4,
 disable_account_worker_enrollment:3,verify_account_worker_revocation:3,verify_account_http_revocation:4,register_account_worker_storage_actor:5,revoke_account_worker_storage_actor:5,reserve_account_worker_storage_actor:5,prove_unprovisioned_account_worker_storage_actor:5,
 read_account_worker_enrollment:3,suspend_account_worker_enrollment:4,resume_account_worker_enrollment:3};
const unavailable=()=>new EnrollmentEffectUnavailable("provision_unavailable",true);
export function validateEnrollmentOperatorCall(sql:string,values:readonly unknown[]){
 const call=/^SELECT public\.([a-z_]+)\(([^()]*)\) (?:AS )?value$/iu.exec(sql.trim());
 if(!call||names[call[1]!]===undefined)throw unavailable();const args=call[2]!.split(",").map(v=>v.trim());
 if(args.length!==names[call[1]!]||values.length!==args.length||args.some((value,index)=>!new RegExp(`^\\$${index+1}(?:::(?:uuid|integer|text(?:\\[\\])?|jsonb|timestamptz))?$`,"u").test(value)))throw unavailable();
}
/** Exact fixed outer lease RPCs only. No arbitrary role, owner, grants, SQL,
 * process receipt or provider action is available through this connection. */
export function createConfiguredEnrollmentOperator(configuration:{database:OwnerWorkerDatabaseSecret;roleName:string;roleOid:number;trustedCreatorRoleOid:number}):EnrollmentOperatorPort&{close():Promise<void>}{
 if(!/^embel_account_operator_[a-z0-9_]{1,35}$/u.test(configuration.roleName)||!z.number().int().positive().safeParse(configuration.roleOid).success
  ||!z.number().int().positive().safeParse(configuration.trustedCreatorRoleOid).success)throw unavailable();
 const options=restrictedOwnerPoolOptions(configuration.roleName,configuration.database,"embel-account-enrollment-operator"),pool=new JavaScriptPool({...options,Client:JavaScriptClient});pool.on("error",()=>{});
 return{async query(sql,values=[]){
  validateEnrollmentOperatorCall(sql,values);
  const client=await pool.connect();let failed=true;
  try{
   const socket=client.connection.stream;if(!(socket instanceof TLSSocket)||!socket.encrypted||!socket.authorized||socket.authorizationError
    ||!["TLSv1.2","TLSv1.3"].includes(socket.getProtocol()??"")||checkServerIdentity(options.host!,socket.getPeerCertificate()))throw unavailable();
   const actual=await client.query(`SELECT session_user::text role_name,current_user::text active_role,r.oid::bigint role_oid,r.rolcanlogin,
    r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolbypassrls,r.rolreplication,
    EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR (m.roleid=r.oid AND NOT(m.member=$2::oid AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option))) unsafe_membership,
    EXISTS(SELECT 1 FROM pg_roles creator WHERE creator.oid=$2::oid AND creator.rolname='postgres') creator_qualified,
    EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid) OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid) owns_objects,
    EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public','fluid_private','auth','storage') AND has_schema_privilege(session_user,n.oid,'CREATE')) schema_create,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname IN ('public','fluid_private','auth','storage')
     AND has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) direct_access
    FROM pg_roles r WHERE r.oid=$1::oid AND r.rolname=session_user`,[configuration.roleOid,configuration.trustedCreatorRoleOid]);
   const row=actual.rows[0];if(actual.rows.length!==1||row.role_name!==configuration.roleName||row.active_role!==configuration.roleName||Number(row.role_oid)!==configuration.roleOid||row.rolcanlogin!==true||row.creator_qualified!==true
    ||["rolsuper","rolinherit","rolcreaterole","rolcreatedb","rolbypassrls","rolreplication","unsafe_membership","owns_objects","schema_create","direct_access"].some(k=>row[k]!==false))throw unavailable();
   const result=await client.query(sql,[...values]);failed=false;return{rows:result.rows};
  }catch{throw unavailable();}finally{client.release(failed?unavailable():undefined);}
 },async close(){await pool.end();}};
}
