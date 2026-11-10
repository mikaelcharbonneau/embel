-- PROPOSED OPERATOR PACKET. Not applied. See docs/cloud-logo-worker-20261019.md.
-- Only fricsfwqibyhemknqgyf, after separate Logo cloud credential/usage approval.
-- No credentials, grants, schema, jobs, assets, history or accounting are changed.
-- Capture the baseline and readiness deadline before freeze; SQL cannot prove
-- that the Mac or another Vercel instance has stopped.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
set local search_path='';
do $freeze$
declare
 o constant uuid:='6840f4c2-15a6-45a7-97be-41e7e5e37f42';
 u constant uuid:='853fa383-9606-4577-924f-966194dc2f67';
 r constant oid:=25288;
 w constant text:='embel-logo-local-20261018';
 h constant text:='175c12bb65f63fe8839b58323ba6e5bbe605d06062a9a708bfdd23efbb8515d5';
 c fluid_private.logo_local_capabilities;
 s fluid_private.logo_storage_principals;
 flags boolean[];
 expected record;
begin
 for expected in select * from (values
  ('public.local_logo_operation(uuid,text,jsonb)','893b3a61975bf7965d6e3c8535f252f5',true,'v',array['search_path=""'],'{postgres=X/postgres,authenticated=X/postgres}'),
  ('fluid_private.logo_local_project_clear(uuid,uuid)','00eaa6d40429c91eadeaccedecf12a0b',false,'s',array['search_path=""'],'{postgres=X/postgres}'),
  ('public.claim_logo_job(text,integer)','9f9df81497f1c23ef25697a89fa9de2e',true,'v',array['search_path=""'],'{postgres=X/postgres,fluid_logo_worker=X/postgres}'),
  ('public.report_logo_worker_ready(text,jsonb,integer)','512b77ff6b01205f07e4dbf09e2adee3',true,'v',array['search_path=""'],'{postgres=X/postgres,fluid_logo_worker=X/postgres}'),
  ('fluid_private.logo_publication_failure_adjudication_matches(uuid)','3aefd0303d54cd31382fb7debbaf90e3',false,'s',array['search_path=""','TimeZone=UTC'],'{postgres=X/postgres}'),
  ('fluid_private.logo_absent_publication_adjudication_matches(uuid)','b35222e467ee7e74be8b74d91aea1c4b',false,'s',array['search_path=""','TimeZone=UTC'],'{postgres=X/postgres}'),
  ('fluid_private.logo_worker_owner()','28c3876cb1de6b2adf58ba12b6ecec2c',true,'s',array['search_path=""'],'{postgres=X/postgres,fluid_logo_worker=X/postgres}')
 ) e(signature,source_hash,definer,volatility,config,acl) loop
  if not exists(select 1 from pg_catalog.pg_proc p where p.oid=expected.signature::regprocedure
   and md5(p.prosrc)=expected.source_hash and p.proowner='postgres'::regrole
   and p.prosecdef=expected.definer and p.provolatile::text=expected.volatility and not p.proleakproof
   and p.proconfig=expected.config and p.proacl::text=expected.acl)
  then raise exception 'cloud_logo_function_drift'; end if;
 end loop;
-- Lock admission, this logical readiness publisher, then its policies in the
-- same order as readiness publication. A policy lock fences concurrent claim/
-- begin-step commits. No external request or process shutdown occurs under SQL.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(o::text,723902));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(r::text||':'||w,0));
 perform 1 from fluid_private.logo_runtime_policies where owner_id=o order by operation for update;
 select * into strict c from fluid_private.logo_local_capabilities where owner_id=o for update;
 select * into strict s from fluid_private.logo_storage_principals where auth_user_id=u for update;
 perform 1 from fluid_private.logo_generative_storage_capabilities where auth_user_id=u order by operation for update;
 if (c.role_name,c.role_oid,c.worker_id,c.policy_identity) is distinct from
 ('fluid_logo_worker'::name,r,w,h) or (s.owner_id,s.role_name,s.role_oid,s.worker_id) is distinct from
 (o,'fluid_logo_worker'::name,r,w)
 or not exists(select 1 from fluid_private.logo_worker_principals p
  join pg_catalog.pg_roles role on role.oid=p.role_oid and role.rolname=p.role_name
  where p.owner_id=o and p.role_name='fluid_logo_worker' and p.role_oid=r
  and role.rolcanlogin and not role.rolinherit and not role.rolsuper and not role.rolbypassrls
  and not role.rolcreatedb and not role.rolcreaterole and not role.rolreplication and role.rolconnlimit=-1
  and not exists(select 1 from pg_catalog.pg_auth_members m where m.member=role.oid))
 or (select count(*) from fluid_private.logo_worker_principals where owner_id=o)<>1
 or (select count(*) from fluid_private.logo_storage_principals where owner_id=o)<>1
 or not exists(select 1 from auth.users where id=u and not is_anonymous)
 then raise exception 'cloud_logo_binding_mismatch'; end if;
 if (select count(*) from fluid_private.logo_runtime_policies where owner_id=o)<>2
 or exists(select 1 from fluid_private.logo_runtime_policies p where p.owner_id=o and
 (p.operation not in('identity.logo_concept','identity.logo_refine') or p.policy_identity is distinct from h
 or p.handler_version is distinct from 'logo-image-v1' or p.provider is distinct from 'openai'
 or p.model is distinct from 'gpt-image-2.5-sunburst-2026-09-08' or p.engine is not null
 or p.max_cost_microusd is distinct from 2000000::bigint or p.subscription_policy is not null))
 or (select count(*) from fluid_private.logo_generative_storage_capabilities where auth_user_id=u)<>2
 or exists(select 1 from fluid_private.logo_generative_storage_capabilities g where g.auth_user_id=u
 and (g.operation not in('identity.logo_concept','identity.logo_refine') or g.policy_identity is distinct from h))
 then raise exception 'cloud_logo_policy_mismatch'; end if;
 -- Reject privilege drift without reading password hashes or credentials.
 if (select count(*) from pg_catalog.pg_proc p cross join lateral aclexplode(p.proacl) a
     where a.grantee=r and a.privilege_type='EXECUTE')<>14
 or exists(select 1 from pg_catalog.pg_proc p cross join lateral aclexplode(p.proacl) a
  where a.grantee=r and (a.is_grantable or p.oid not in(
   'fluid_private.logo_worker_owner()'::regprocedure,'public.report_logo_worker_ready(text,jsonb,integer)'::regprocedure,
   'public.claim_logo_job(text,integer)'::regprocedure,'public.heartbeat_logo_job(uuid,uuid,integer)'::regprocedure,
   'public.register_logo_job_plan(uuid,uuid,jsonb)'::regprocedure,'public.begin_logo_job_step(uuid,uuid,text,text,bigint)'::regprocedure,
   'public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text)'::regprocedure,'public.finish_logo_job(uuid,uuid,text)'::regprocedure,
   'public.expire_logo_job_leases()'::regprocedure,'public.read_leased_logo_record(uuid,uuid,text,jsonb)'::regprocedure,
   'public.record_logo_provider_response(uuid,uuid,jsonb)'::regprocedure,'fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid)'::regprocedure,
   'fluid_private.read_logo_asset_publication(uuid,jsonb,uuid,uuid)'::regprocedure,'fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid)'::regprocedure)))
 or exists(select 1 from pg_catalog.pg_class t cross join lateral aclexplode(t.relacl) a where a.grantee=r)
 or exists(select 1 from pg_catalog.pg_attribute t cross join lateral aclexplode(t.attacl) a where a.grantee=r)
 or exists(select 1 from pg_catalog.pg_class where relowner=r)
 or exists(select 1 from pg_catalog.pg_proc where proowner=r)
 or exists(select 1 from pg_catalog.pg_namespace where nspowner=r)
 then raise exception 'cloud_logo_privilege_drift'; end if;
 select array_agg(flag order by key) into flags from (
  select 'local' key,c.enabled flag union all select 'storage',s.enabled
  union all select 'policy:'||operation,enabled from fluid_private.logo_runtime_policies where owner_id=o
  union all select 'generative:'||operation,enabled from fluid_private.logo_generative_storage_capabilities where auth_user_id=u) x;
 -- Preserve queued work and every historical receipt. Even expired, uncleared
 -- leases block cutover. Age never proves an issued provider call did not run.
 if exists(select 1 from public.jobs j where j.owner_id=o and j.operation like 'identity.logo%'
 and (j.state in('running','cancel_requested','needs_reconciliation') or j.lease_token is not null
 or j.lease_expires_at is not null or (j.state='queued' and j.cancel_requested_at is not null)))
 then raise exception 'cloud_logo_active_or_unresolved_work'; end if;
 if exists(select 1 from public.job_steps step join public.jobs job on job.id=step.job_id
 where job.owner_id=o and job.operation like 'identity.logo%' and
 (step.state='in_flight' or (step.state='ambiguous'
 and fluid_private.logo_publication_failure_adjudication_matches(job.id) is distinct from true)))
 then raise exception 'cloud_logo_pending_provider_outcome'; end if;
 if flags=array[false,false,false,false,false,false] then
  if exists(select 1 from fluid_private.logo_worker_readiness where owner_id=o) then raise exception 'cloud_logo_frozen_readiness_mismatch'; end if;
  raise notice 'cloud_logo_already_frozen'; return;
 end if;
 if flags<>array[true,true,true,true,true,true] then raise exception 'cloud_logo_unexpected_freeze_state'; end if;
 update fluid_private.logo_runtime_policies set enabled=false where owner_id=o and operation in('identity.logo_concept','identity.logo_refine');
 update fluid_private.logo_local_capabilities set enabled=false where owner_id=o;
 update fluid_private.logo_storage_principals set enabled=false where auth_user_id=u;
 update fluid_private.logo_generative_storage_capabilities set enabled=false where auth_user_id=u and operation in('identity.logo_concept','identity.logo_refine');
 -- The existing policy-update trigger withdraws both readiness rows.
 if exists(select 1 from fluid_private.logo_worker_readiness where owner_id=o)
 then raise exception 'cloud_logo_freeze_readiness_not_withdrawn'; end if;
 raise notice 'cloud_logo_frozen';
end $freeze$;
commit;

-- Operational metadata only. No token or credential is returned.
select c.owner_id,c.role_name,c.role_oid,c.worker_id,c.policy_identity,
 c.enabled as local_enabled,s.enabled as storage_enabled,
 (select jsonb_object_agg(operation,enabled) from fluid_private.logo_runtime_policies where owner_id=c.owner_id) policies,
 (select jsonb_object_agg(operation,enabled) from fluid_private.logo_generative_storage_capabilities where auth_user_id=s.auth_user_id) storage_capabilities,
 (select max(ready_until) from fluid_private.logo_worker_readiness where owner_id=c.owner_id) ready_until
from fluid_private.logo_local_capabilities c join fluid_private.logo_storage_principals s on s.owner_id=c.owner_id
where c.owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42' and s.auth_user_id='853fa383-9606-4577-924f-966194dc2f67';
