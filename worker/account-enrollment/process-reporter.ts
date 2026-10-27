import "server-only";
import JavaScriptClient from "pg/lib/client.js";
import JavaScriptPool from "pg-pool";
import { TLSSocket,checkServerIdentity } from "node:tls";
import { z } from "zod";
import type { OwnerWorkerBinding } from "./adapter";
import type { OwnerWorkerDatabaseSecret } from "./process-contracts";
import { restrictedOwnerPoolOptions } from "./process-qualification";

const unavailable=()=>Error("Owner worker reporter is unavailable");
/** Separate registered restricted launcher identity; never the enrollment
 * operator, account role manager or owner worker. No connection until report. */
export function createOwnerWorkerProcessReporter(configuration:{database:OwnerWorkerDatabaseSecret;roleName:string;roleOid:number;trustedCreatorRoleOid:number}){
 if(!/^embel_worker_launcher_[a-z0-9_]{1,40}$/u.test(configuration.roleName)||!z.number().int().positive().safeParse(configuration.roleOid).success
  ||!z.number().int().positive().safeParse(configuration.trustedCreatorRoleOid).success)throw unavailable();
 const options=restrictedOwnerPoolOptions(configuration.roleName,configuration.database,"embel-worker-launcher-reporter");
 const pool=new JavaScriptPool({...options,Client:JavaScriptClient});pool.on("error",()=>{});
 async function invoke(sql:string,values:unknown[],signal?:AbortSignal){
   signal?.throwIfAborted();const client=await pool.connect();let failed=true;
   try{
    const socket=client.connection.stream;if(!(socket instanceof TLSSocket)||!socket.encrypted||!socket.authorized||socket.authorizationError
     ||!["TLSv1.2","TLSv1.3"].includes(socket.getProtocol()??"")||checkServerIdentity(options.host!,socket.getPeerCertificate()))throw unavailable();
    const result=await client.query(`SELECT session_user::text role_name,current_user::text active_role,r.oid::bigint role_oid,
     r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolbypassrls,r.rolreplication,r.rolcanlogin,
     (EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR (m.roleid=r.oid AND NOT(m.member=$1::oid AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option)))
      OR (SELECT count(*) FROM pg_auth_members WHERE roleid=r.oid)>1) memberships,
     EXISTS(SELECT 1 FROM pg_roles creator WHERE creator.oid=$1::oid AND creator.rolname='postgres') creator_qualified,
     EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public','fluid_private','auth','storage') AND has_schema_privilege(session_user,n.oid,'CREATE')) schema_create,
     EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname IN ('public','fluid_private','auth','storage')
      AND has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) direct_access
     FROM pg_roles r WHERE rolname=session_user`,[configuration.trustedCreatorRoleOid]),row=result.rows[0];
    if(result.rows.length!==1||row.role_name!==configuration.roleName||row.active_role!==configuration.roleName||Number(row.role_oid)!==configuration.roleOid
     ||row.rolcanlogin!==true||row.creator_qualified!==true||["rolsuper","rolinherit","rolcreaterole","rolcreatedb","rolbypassrls","rolreplication","memberships","schema_create","direct_access"].some(k=>row[k]!==false))throw unavailable();
    // SQL independently requires exact registered reporter OID, current binding,
    // bounded fresh observation and immutable receipt; no caller owner override.
    const report=await client.query(sql,values);
    if(report.rows.length!==1)throw unavailable();signal?.throwIfAborted();failed=false;return report.rows[0]?.value as unknown;
   }catch{throw unavailable();}finally{client.release(failed?unavailable():undefined);}
 }
 return{
  async report(binding:OwnerWorkerBinding,state:"running"|"stopped",receipt:string,observedAt:string,signal?:AbortSignal){
   const value=await invoke("SELECT public.report_account_worker_process($1::jsonb,$2,$3,$4::timestamptz) value",[JSON.stringify(binding),state,receipt,observedAt],signal);if(value!==true)throw unavailable();
  },
  async strategyRoute(message:unknown,signal?:AbortSignal){return invoke("SELECT public.get_account_worker_strategy_route($1::jsonb) value",[JSON.stringify(message)],signal);},
  async close(){await pool.end();},
 };
}
