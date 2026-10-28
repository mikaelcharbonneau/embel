import { createHash,createHmac,pbkdf2Sync } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createAccountEnrollmentFixture } from './account-enrollment-fixture';
import { asRole } from './local-supabase';
const owner='c2000000-0000-4000-8000-000000000001',actor='c2000000-0000-4000-8000-000000000002',legacy='c2000000-0000-4000-8000-000000000003';
const salt=Buffer.alloc(16,8),salted=pbkdf2Sync('disposable-fixture',salt,4096,32,'sha256');
const verifier=`SCRAM-SHA-256$4096:${salt.toString('base64')}$${createHash('sha256').update(createHmac('sha256',salted).update('Client Key').digest()).digest('base64')}:${createHmac('sha256',salted).update('Server Key').digest('base64')}`;
type Claim={id:string;ownerId:string;leaseToken:string;steps:{capability:string;operationKey:string}[]};
describe('managed enrollment Storage authorization and service-actor exclusion (SQL fixture)',()=>{
 let f:Awaited<ReturnType<typeof createAccountEnrollmentFixture>>,claim:Claim,home:{roleName:string},path:string;
 beforeAll(async()=>{f=await createAccountEnrollmentFixture();},60_000);
 afterAll(async()=>{await f?.close();});
 async function value<T=unknown>(name:string,args:unknown[]=[]):Promise<T>{const placeholders=args.map((_,i)=>`$${i+1}`).join(',');return((await f.operator.query(`select public.${name}(${placeholders}) value`,args)).rows[0] as {value:T}).value;}
 it('derives publication authority from the verified owner and exposes no credentials',async()=>{
  await f.seedUser(owner);await f.seedUser(legacy);await f.db.query("update fluid_private.account_service_enrollments set available_at='infinity' where owner_id=$1",[legacy]);
  const authority=await asRole(f.db,'authenticated',owner,async()=>(await f.db.query<{value:{ownerId:string;generation:number;identity:{ready:boolean};attachments:{ready:boolean}}}>('select public.get_account_service_enrollment_binding() value')).rows[0]!.value);
  expect(authority.ownerId).toBe(owner);expect(authority.identity.ready).toBe(false);expect(authority.attachments.ready).toBe(false);
  expect(JSON.stringify(authority)).not.toMatch(/credential|password|roleName|roleOid/);
  await expect(asRole(f.db,'anon',null,()=>f.db.query('select public.get_account_service_enrollment_binding()'))).rejects.toMatchObject({code:'42501'});
 });
 it('marks an unconfirmed service actor before confirmation, preventing recursive customer enrollment',async()=>{
  await f.seedUser(actor,{confirmed:false});
  await f.db.query("insert into fluid_private.account_service_actors(auth_user_id,purpose,registration_receipt)values($1,'logo_storage','fixture-actor-registered')",[actor]);
  await f.db.query('update auth.users set email_confirmed_at=clock_timestamp() where id=$1',[actor]);
  expect((await f.db.query('select id from fluid_private.account_service_enrollments where owner_id=$1',[actor])).rows).toHaveLength(0);
  await expect(asRole(f.db,'authenticated',actor,()=>f.db.query('select public.ensure_account_service_enrollment()'))).rejects.toMatchObject({code:'42501'});
  await expect(f.db.query("update fluid_private.account_service_actors set registration_receipt='changed' where auth_user_id=$1",[actor])).rejects.toMatchObject({code:'55000'});
 });
 it('keeps existing legacy and non-Home policies while denying stale JWT Home reads/inserts on ban',async()=>{
  claim=await value<Claim>('claim_account_service_enrollment');expect(claim.ownerId).toBe(owner);
  const step=claim.steps.find(s=>s.capability==='home_attachments')!,ref=`fixture:${step.operationKey}`;
  await value('record_account_service_enrollment',[claim.id,claim.leaseToken,'home_attachments','provisioning']);
  await value('record_account_service_enrollment',[claim.id,claim.leaseToken,'home_attachments','credential_reserved',ref]);
  home=await value('provision_account_enrollment_http',[claim.id,claim.leaseToken,'home_attachments',ref,verifier]);
  await value('record_account_service_enrollment',[claim.id,claim.leaseToken,'home_attachments','published',`fixture:${step.operationKey}`]);
  await value('record_account_service_enrollment',[claim.id,claim.leaseToken,'home_attachments','ready',`qualified:${step.operationKey}`]);
  await f.db.exec(`set session authorization ${home.roleName}`);
  try{path=(await f.db.query<{value:{storagePath:string}}>('select fluid_private.prepare_home_attachment($1::jsonb,1) value',[{requestKey:'c2000000-0000-4000-8000-000000000004',name:'proof.txt',mimeType:'text/plain',contentHash:'a'.repeat(64)}])).rows[0]!.value.storagePath;}
  finally{await f.db.exec('set session authorization postgres');}
  await f.db.query("insert into storage.objects(bucket_id,name,owner_id)values('fluid-assets',$1,$2)",[path,owner]);
  const read=()=>asRole(f.db,'authenticated',owner,async()=>{await f.db.exec("select set_config('storage.operation','object.get_authenticated',false)");return(await f.db.query('select id from storage.objects where name=$1',[path])).rows;});
  expect(await read()).toHaveLength(1);
  await f.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 day' where id=$1",[owner]);
  expect(await read()).toHaveLength(0);
  await expect(asRole(f.db,'authenticated',owner,async()=>{await f.db.exec("select set_config('storage.operation','object.upload',false)");return f.db.query("insert into storage.objects(bucket_id,name,owner_id)values('fluid-assets',$1,$2)",[path,owner]);})).rejects.toMatchObject({code:'42501'});
  await f.db.query("select set_config('request.jwt.claim.sub',$1,false)",[legacy]);
  const unchanged=await f.db.query<{legacy:boolean;other:boolean}>("select fluid_private.account_enrollment_home_storage_allowed('fluid-assets',$1) legacy,fluid_private.account_enrollment_home_storage_allowed('fluid-assets',$2) other",[`${legacy}/home/a/b`,`${owner}/project/a/b`]);
  await f.db.exec("select set_config('request.jwt.claim.sub','',false)");
  expect(unchanged.rows[0]).toEqual({legacy:true,other:true});
  const policy=(await f.db.query<{polpermissive:boolean;polcmd:string}>("select polpermissive,polcmd from pg_policy where polname='account_enrollment_home_storage_gate'")).rows[0];expect(policy).toEqual({polpermissive:false,polcmd:'*'});
 });
 it('requires fresh exact policy/helper and NOLOGIN/drain proof before accepting revocation',async()=>{
  // Earlier lease is invalidated by the Auth-trigger revision fence.
  await expect(value('record_account_service_enrollment',[claim.id,claim.leaseToken,'home_attachments','ready','stale'])).rejects.toMatchObject({code:'42501'});
  const revoke=await value<Claim>('claim_account_service_enrollment');expect(revoke.ownerId).toBe(owner);
  const args=[revoke.id,revoke.leaseToken,'home_attachments','http-binding:'+'b'.repeat(64)];
  await expect(value('verify_account_http_revocation',args)).rejects.toMatchObject({code:'55000'});
  await value('revoke_account_enrollment_http',args.slice(0,3));
  await expect(value('acknowledge_account_enrollment_revocation',[...args.slice(0,3),'forged'])).rejects.toMatchObject({code:'55000'});
  await f.db.exec('grant execute on function fluid_private.account_enrollment_home_storage_allowed(text,text) to anon');
  await expect(value('verify_account_http_revocation',args)).rejects.toMatchObject({code:'55000'});
  await f.db.exec('revoke execute on function fluid_private.account_enrollment_home_storage_allowed(text,text) from anon');
  await f.db.exec('alter policy account_enrollment_home_storage_gate on storage.objects using(true)');
  await expect(value('verify_account_http_revocation',args)).rejects.toMatchObject({code:'55000'});
  await f.db.exec('alter policy account_enrollment_home_storage_gate on storage.objects using(fluid_private.account_enrollment_home_storage_allowed(bucket_id,name))');
  const proof=await value<{authorityDisabled:boolean;runtimeStopped:boolean;storageDenied:boolean;receipt:string}>('verify_account_http_revocation',args);
  expect(proof).toMatchObject({authorityDisabled:true,runtimeStopped:true,storageDenied:true});
  await expect(value('acknowledge_account_enrollment_revocation',[...args.slice(0,3),proof.receipt])).resolves.toMatchObject({acknowledged:true});
 });
 it('revokes partial HTTP effects after a crash before credential/principal acknowledgement',async()=>{
  const partial='c2000000-0000-4000-8000-000000000005';await f.seedUser(partial);
  const claim=await value<Claim>('claim_account_service_enrollment');expect(claim.ownerId).toBe(partial);
  await value('record_account_service_enrollment',[claim.id,claim.leaseToken,'home_attachments','provisioning']);
  await f.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 day' where id=$1",[partial]);
  const revoke=await value<Claim>('claim_account_service_enrollment');expect(revoke.ownerId).toBe(partial);
  await value('revoke_account_enrollment_http',[revoke.id,revoke.leaseToken,'home_attachments']);
  const proof=await value<{receipt:string;storageDenied:boolean}>('verify_account_http_revocation',[revoke.id,revoke.leaseToken,'home_attachments','http-binding:'+'c'.repeat(64)]);
  expect(proof.storageDenied).toBe(true);
  await value('acknowledge_account_enrollment_revocation',[revoke.id,revoke.leaseToken,'home_attachments',proof.receipt]);
  expect(await value('finish_account_service_enrollment',[revoke.id,revoke.leaseToken,['home_attachments','identity_transactions','strategy','naming','logo']])).toMatchObject({status:'unavailable'});
 });

 it('claims completed rows for bounded same-operation maintenance after their existing available_at schedule',async()=>{
  const existing='c2000000-0000-4000-8000-000000000006';await f.seedUser(existing);
  // Synthetic status used only to verify scheduling. No capability readiness or
  // external process is inferred from this fixture-only administrative change.
  await f.db.query("update fluid_private.account_service_enrollments set state='ready',available_at=clock_timestamp()+interval '1 hour' where owner_id=$1",[existing]);
  expect(await value('claim_account_service_enrollment')).toBeNull();
  await f.db.query("update fluid_private.account_service_enrollments set available_at=clock_timestamp()-interval '1 second' where owner_id=$1",[existing]);
  const scheduled=await value<Claim>('claim_account_service_enrollment');expect(scheduled.ownerId).toBe(existing);
  const keys=scheduled.steps.map(step=>step.operationKey);
  await value('finish_account_service_enrollment',[scheduled.id,scheduled.leaseToken]);
  expect(await value('claim_account_service_enrollment')).toBeNull();
  await f.db.query("update fluid_private.account_service_enrollments set available_at=clock_timestamp()-interval '1 second' where owner_id=$1",[existing]);
  const retry=await value<Claim>('claim_account_service_enrollment');expect(retry.steps.map(step=>step.operationKey)).toEqual(keys);
 });

});
