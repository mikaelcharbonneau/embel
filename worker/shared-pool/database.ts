import "server-only";
import { TLSSocket,checkServerIdentity } from "node:tls";
import JavaScriptClient from "pg/lib/client.js";
import JavaScriptPool from "pg-pool";
import type { Pool,PoolConfig } from "pg";
import type { SharedPoolConfiguration,SharedPoolSlot } from "./configuration";
import { assertSharedSlotSecret,type SharedSlotSecret } from "./secrets";
import type { SharedSlotDatabase } from "./contracts";
import { verifySharedAuthorityCatalog } from "./authority";
import authorityManifest from "./authority-manifest.json";
import { qualifySharedStoragePolicies } from "../../src/server/runtime/shared-storage-policy-qualification";
export interface SharedSlotPool extends SharedSlotDatabase {qualify():Promise<void>;close():Promise<void>;}
const unavailable=()=>Error("shared_slot_database_unavailable");
export function sharedSlotPoolOptions(config:SharedPoolConfiguration,slot:SharedPoolSlot,secret:SharedSlotSecret):PoolConfig {
 assertSharedSlotSecret(config,slot,secret);const url=new URL(secret.databaseUrl);
 return {host:url.hostname,port:Number(url.port),database:"postgres",user:decodeURIComponent(url.username),password:()=>decodeURIComponent(url.password),
  ssl:config.target.kind==="vercel"?{ca:secret.caPem,rejectUnauthorized:true,servername:url.hostname,minVersion:"TLSv1.2"}:false,
  sslnegotiation:"postgres",options:"-c row_security=on -c statement_timeout=15000 -c lock_timeout=1500 -c idle_in_transaction_session_timeout=5000",
  replication:"false",binary:false,client_encoding:"UTF8",application_name:`embel-shared-${slot.lane}`,fallback_application_name:`embel-shared-${slot.lane}`,
  max:2,connectionTimeoutMillis:5000,idleTimeoutMillis:10_000,allowExitOnIdle:true,statement_timeout:15_000,query_timeout:15_000,lock_timeout:1500,idle_in_transaction_session_timeout:5000} as PoolConfig;
}
/** A fixed number of explicit slot pools. These are never keyed by a customer,
 * and no privileged/default Postgres credential can substitute for a slot. */
export function createSharedSlotPool(config:SharedPoolConfiguration,slot:SharedPoolSlot,secret:SharedSlotSecret):SharedSlotPool {
 const options=sharedSlotPoolOptions(config,slot,secret),pool:Pool=new JavaScriptPool({...options,Client:JavaScriptClient});pool.on("error",()=>{});
 let closed=false;
 return {async query(sql,values=[]){if(closed)throw unavailable();return pool.query(sql,values);},
  async qualify(){
   if(closed)throw unavailable();const client=await pool.connect();let failed=true,transaction=false;
   // pg-pool removes its idle error listener on checkout. pg rejects active
   // queries AND emits a client error on disconnect, including after VM sleep.
   let disconnected=false;
   const onDisconnect=()=>{disconnected=true;};
   client.on("error",onDisconnect);
   try{
    if(config.target.kind==="vercel"){
     const socket=client.connection.stream;
     if(!(socket instanceof TLSSocket)||!socket.encrypted||!socket.authorized||socket.authorizationError||!["TLSv1.2","TLSv1.3"].includes(socket.getProtocol()??"")||checkServerIdentity(options.host!,socket.getPeerCertificate()))throw unavailable();
    }
    await client.query("BEGIN READ ONLY");transaction=true;await client.query("SET LOCAL search_path=''");
    const result=await client.query(`SELECT session_user::text role_name,current_user::text active_role,r.oid::bigint role_oid,r.rolcanlogin,r.rolconnlimit,
     r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolbypassrls,r.rolreplication,
     EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR (m.roleid=r.oid AND NOT(m.member=to_regrole('postgres')::oid AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option))) unsafe_membership,
     EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=r.oid AND deptype='o') owns_objects,
     EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public','fluid_private','auth','storage') AND has_schema_privilege(r.oid,n.oid,'CREATE')) schema_create,
     EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname IN ('public','fluid_private','auth','storage')
      AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) direct_access,
     has_schema_privilege(r.oid,'fluid_private','USAGE') private_usage FROM pg_roles r WHERE r.rolname=session_user`);
    const row=result.rows[0];if(result.rows.length!==1||row.role_name!==slot.roleName||row.active_role!==slot.roleName||Number(row.role_oid)!==slot.roleOid||row.rolcanlogin!==true||row.rolconnlimit!==4
     ||["rolsuper","rolinherit","rolcreaterole","rolcreatedb","rolbypassrls","rolreplication","unsafe_membership","owns_objects","schema_create","direct_access","private_usage"].some(k=>row[k]!==false))throw unavailable();
    await qualifySharedStoragePolicies(client);
    const proofs=[{signature:"public.claim_shared_worker_slot(uuid,uuid,text,integer)",...config.coreProofs.claim},
     {signature:"public.renew_shared_worker_slot(jsonb,integer)",...config.coreProofs.renew},{signature:"public.release_shared_worker_slot(jsonb)",...config.coreProofs.release},
     {signature:"public.fence_shared_worker_slot(jsonb)",...config.coreProofs.fence},
     {signature:"public.read_shared_worker_execution_page(jsonb,uuid,integer)",...config.coreProofs.pending},{signature:"public.shared_worker_pool_configuration()",...config.coreProofs.capacity},
     {signature:`public.shared_${slot.lane}_worker_action(jsonb,jsonb,text,jsonb)`,...slot.gatewayProof},
     ...(slot.outboxProof?[{signature:"public.list_shared_strategy_dispatches(jsonb,integer)",...slot.outboxProof}]:[])];
    const authority=await verifySharedAuthorityCatalog(client,slot.lane,authorityManifest);
    for(const proof of proofs){
     const signature=/^public\.([a-z_]+)\((.*)\)$/u.exec(proof.signature);if(!signature)throw unavailable();
     const p=authority.lookup("public",signature[1]!,signature[2]!);
     if(!p||p.owner!=="postgres"||p.security_definer!==true||p.leakproof!==false||p.callable!==true||p.broad_execute!==false||p.volatility!==proof.volatility||p.language!==proof.language
      ||JSON.stringify(p.search_path)!==JSON.stringify(['search_path=""'])||p.body_sha256!==proof.sha256)throw unavailable();
    }
    const capacity=await client.query("SELECT public.shared_worker_pool_configuration() configuration");
    const configured=capacity.rows[0]?.configuration;
    if(capacity.rows.length!==1||!configured||configured.version!==1||configured.tenantScope!=="per_lane"||Object.keys(configured).length!==5||configured.globalConcurrency!==config.capacity.maxConcurrentExecutions||configured.maxPerTenantPerLane!==config.capacity.maxPerTenantPerLane
     ||!Array.isArray(configured.slotIds)||JSON.stringify([...configured.slotIds].sort())!==JSON.stringify(config.slots.map(s=>s.slotId).sort()))throw unavailable();
    failed=false;
   }catch{throw unavailable();}finally{let cleanupFailed=false;if(transaction)try{await client.query("ROLLBACK");}catch{failed=true;cleanupFailed=true;}
    try{client.release(failed||disconnected?unavailable():undefined);}catch{cleanupFailed=true;}
    finally{client.removeListener("error",onDisconnect);}
    if(cleanupFailed||disconnected)throw unavailable();}
  },async close(){closed=true;await pool.end();}};
}
