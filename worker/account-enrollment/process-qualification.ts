import "server-only";
import { createHash } from "node:crypto";
import { TLSSocket,checkServerIdentity } from "node:tls";
import JavaScriptClient from "pg/lib/client.js";
import JavaScriptPool from "pg-pool";
import type { Pool,PoolConfig } from "pg";
import { z } from "zod";
import type { OwnerWorkerProcessDescriptor } from "./adapter";
import { approvedWorkerProfileSchema,ownerWorkerRole,workerProfileFingerprint } from "./configuration";
import type { OwnerWorkerArtifactAttestation,OwnerWorkerDatabaseSecret } from "./process-contracts";
import { MANAGED_PRINCIPAL_BODY_SHA256 } from "../../src/server/runtime/managed-principal";

const project="fricsfwqibyhemknqgyf",direct=`db.${project}.supabase.co`,pooler="aws-0-us-east-1.pooler.supabase.com";
const caHash="700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
const unavailable=()=>Error("Owner worker qualification is unavailable");
export function assertOwnerWorkerArtifact(descriptor:OwnerWorkerProcessDescriptor,attestation:OwnerWorkerArtifactAttestation) {
 const binding=descriptor.binding,profile=approvedWorkerProfileSchema.parse(descriptor.profile);
 const actual={node:process.versions.node,icu:process.versions.icu,unicode:process.versions.unicode,platform:process.platform,arch:process.arch};
 if(profile.managedProofSha256!==MANAGED_PRINCIPAL_BODY_SHA256||attestation.sourceClean!==true||attestation.sourceRevision!==profile.sourceRevision||attestation.artifactSha256!==profile.artifactSha256
  ||attestation.deploymentId!==profile.deploymentId||Object.entries(profile.runtime).some(([key,value])=>Reflect.get(actual,key)!==value)
  ||Object.entries(profile.runtime).some(([key,value])=>Reflect.get(attestation.runtime,key)!==value)
  ||process.env.VERCEL!=="1"||process.env.VERCEL_ENV!=="production"||process.env.VERCEL_PROJECT_ID!==profile.projectId
  ||process.env.VERCEL_DEPLOYMENT_ID!==profile.deploymentId||binding.roleName!==ownerWorkerRole(profile.capability,binding.ownerId)
  ||binding.capability!==profile.capability||binding.deploymentId!==profile.deploymentId||binding.profileFingerprint!==workerProfileFingerprint(profile))throw unavailable();
}
export function ownerWorkerPoolOptions(descriptor:OwnerWorkerProcessDescriptor,secret:OwnerWorkerDatabaseSecret):PoolConfig {
 return restrictedOwnerPoolOptions(descriptor.binding.roleName,secret,`embel-owner-${descriptor.binding.capability}`);
}
/** Also used by the separately registered restricted launcher reporter. */
export function restrictedOwnerPoolOptions(roleName:string,secret:OwnerWorkerDatabaseSecret,applicationName:string):PoolConfig {
 try{
  if(createHash("sha256").update(secret.caPem).digest("hex")!==caHash||secret.databaseUrl.length>8192||/[\s\x00-\x1f\x7f]/u.test(secret.databaseUrl))throw unavailable();
  const url=new URL(secret.databaseUrl),user=decodeURIComponent(url.username),password=decodeURIComponent(url.password);
  if(!["postgres:","postgresql:"].includes(url.protocol)||![direct,pooler].includes(url.hostname)||url.port!=="5432"||url.pathname!=="/postgres"
   ||url.hash||[...url.searchParams].length!==1||url.searchParams.get("sslmode")!=="verify-full"||!password||/[\x00-\x1f\x7f]/u.test(password)
   ||!/^[_a-z][_a-z0-9]{0,62}$/u.test(roleName)||user!==(url.hostname===pooler?`${roleName}.${project}`:roleName))throw unavailable();
  return{host:url.hostname,port:5432,database:"postgres",user,password:()=>password,
   ssl:{ca:secret.caPem,rejectUnauthorized:true,servername:url.hostname,minVersion:"TLSv1.2"},sslnegotiation:"postgres",
   options:"-c row_security=on -c statement_timeout=15000 -c lock_timeout=1500 -c idle_in_transaction_session_timeout=5000",
   client_encoding:"UTF8",replication:"false",application_name:applicationName,
   max:2,connectionTimeoutMillis:5000,statement_timeout:15_000,query_timeout:15_000,lock_timeout:1500,
   idle_in_transaction_session_timeout:5000,idleTimeoutMillis:10_000,allowExitOnIdle:true} as PoolConfig;
 }catch{throw unavailable();}
}
export function createOwnerWorkerPool(descriptor:OwnerWorkerProcessDescriptor,secret:OwnerWorkerDatabaseSecret):Pool {
 const pool=new JavaScriptPool({...ownerWorkerPoolOptions(descriptor,secret),Client:JavaScriptClient});
 pool.on("error",()=>{/* Never emit credential-bearing driver objects. */});return pool;
}
const proofSchema=z.object({version:z.literal(2),ownerId:z.uuid(),generation:z.number().int().positive(),revision:z.number().int().positive(),operationKey:z.uuid(),capability:z.enum(["strategy","naming","logo"]),
 roleName:z.string(),roleOid:z.number().int().positive(),managerRoleName:z.literal("embel_account_role_manager"),managerRoleOid:z.number().int().positive()});
/** Independent actual TLS/session/managed-proof qualification. No heartbeat,
 * admission, policy activation, job claim or provider call is performed here. */
export async function qualifyOwnerWorkerPool(pool:Pool,descriptor:OwnerWorkerProcessDescriptor,signal:AbortSignal) {
 signal.throwIfAborted();const client=await pool.connect();let failed=true;
 try{
  const socket=client.connection.stream,hostname=pool.options.host!;
  if(!(socket instanceof TLSSocket)||!socket.encrypted||!socket.authorized||socket.authorizationError
   ||!["TLSv1.2","TLSv1.3"].includes(socket.getProtocol()??"")||checkServerIdentity(hostname,socket.getPeerCertificate()))throw unavailable();
  await client.query("BEGIN READ ONLY");
  const catalog=await client.query(`SELECT session_user::text role_name,current_user::text active_role,r.oid::bigint role_oid,
   encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') proof_hash,p.prosecdef,p.proconfig,p.proleakproof,
   (pg_get_userbyid(p.proowner)='postgres' AND p.provolatile='s' AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
    AND has_function_privilege(session_user,p.oid,'EXECUTE') AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE (a.grantee=0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role'))) AND a.privilege_type='EXECUTE')) proof_trusted
   FROM pg_roles r CROSS JOIN pg_proc p WHERE r.rolname=session_user
   AND p.oid=to_regprocedure('public.account_enrollment_managed_principal()')`);
  const row=catalog.rows[0];if(catalog.rows.length!==1||row.role_name!==descriptor.binding.roleName||row.active_role!==row.role_name
   ||Number(row.role_oid)!==descriptor.binding.roleOid||row.proof_hash!==MANAGED_PRINCIPAL_BODY_SHA256||row.proof_hash!==descriptor.profile.managedProofSha256||row.prosecdef!==true||row.proof_trusted!==true
   ||row.proleakproof!==false||JSON.stringify(row.proconfig)!==JSON.stringify(['search_path=""']))throw unavailable();
  const result=await client.query("SELECT public.account_enrollment_managed_principal() value"),proof=proofSchema.parse(result.rows[0]?.value);
  const b=descriptor.binding;if(result.rows.length!==1||proof.ownerId!==b.ownerId||proof.generation!==b.generation||proof.revision!==b.revision||proof.operationKey!==b.operationKey||proof.capability!==b.capability||proof.roleName!==b.roleName||proof.roleOid!==b.roleOid)throw unavailable();
  signal.throwIfAborted();failed=false;
 }finally{try{await client.query("ROLLBACK");}catch{failed=true;}client.release(failed?unavailable():undefined);}
 if(failed)throw unavailable();
}
