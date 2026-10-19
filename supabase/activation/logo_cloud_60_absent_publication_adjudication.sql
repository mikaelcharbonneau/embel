-- UNAPPLIED PROPOSAL: the single 2026-10-19 cloud publication failure.
-- Installation creates no decision and does not retry generation. The operator
-- must first stop/drain the worker and independently confirm zero DB sessions.
-- A separate owner-only INSERT records the reviewed decision. It retains the
-- ambiguous step and confirmed provider charge, releasing only the unused hold.
-- No credential, worker/client grant, capability or runtime policy is changed.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
create temporary table logo_absent_original_function on commit drop as
 select oid,proowner,proacl,prosecdef,provolatile,proconfig,proleakproof from pg_proc
 where oid='fluid_private.logo_publication_failure_adjudication_matches(uuid)'::regprocedure;
do $guard$
declare expected record; p pg_proc;
begin
 for expected in select * from (values
  ('fluid_private.logo_publication_failure_adjudication_matches(uuid)','2a421d795cfd73b10b20a8b18b80c212',false,'s',true,'postgres'),
  ('fluid_private.record_logo_publication_failure_adjudication()','04fb90bddbfe0f8bbc8dd6d1cf848a08',false,'v',true,'postgres'),
  ('fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid)','598a24c03e0e897c393ca3dddc5b2d1b',true,'v',false,'fluid_logo_worker'),
  ('fluid_private.logo_asset_job(uuid,uuid,uuid,uuid)','bfaaa947e52215ec1bbcd9734b3f2afd',false,'v',false,'postgres'),
  ('public.authorize_logo_generative_storage(uuid,uuid,uuid,text)','172e7f85dd623f93cd4a89b750bc0253',true,'v',false,'authenticated'),
  ('fluid_private.logo_generative_storage_job(jsonb,uuid,uuid)','b51015e2fb4db284499b47df932c8db1',false,'v',false,'postgres'),
  ('fluid_private.logo_generative_storage_object_allowed(text,text,text,text)','c19a47df6072cd6abae4aa6398de2fb9',true,'v',false,'authenticated'),
  ('fluid_private.logo_storage_context()','215a6e509f936fdbac5e89a8823e25f5',true,'v',false,'postgres'),
  ('fluid_private.settle_reservation(uuid)','3547545242855b939bdc82d62bef2143',false,'v',false,'postgres')
 ) e(signature,source_hash,definer,volatility,utc,extra_role) loop
  select * into strict p from pg_proc where oid=to_regprocedure(expected.signature);
  if md5(p.prosrc) is distinct from expected.source_hash or p.proowner is distinct from 'postgres'::regrole
   or current_user is distinct from 'postgres' or p.prosecdef is distinct from expected.definer
   or p.provolatile::text is distinct from expected.volatility or p.proleakproof
   or p.proconfig is distinct from (case when expected.utc then array['search_path=""','TimeZone=UTC'] else array['search_path=""'] end)
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where a.privilege_type<>'EXECUTE' or a.is_grantable or a.grantor<>p.proowner
     or a.grantee not in(p.proowner,to_regrole(expected.extra_role)))
   or not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where a.grantee=p.proowner and a.privilege_type='EXECUTE')
   or not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where a.grantee=to_regrole(expected.extra_role) and a.privilege_type='EXECUTE') then
   raise exception 'unexpected_logo_absent_adjudication_predecessor: %',expected.signature;
  end if;
 end loop;
end $guard$;

create table fluid_private.logo_absent_publication_adjudications (
 job_id uuid primary key references public.jobs(id),
 operator_decision_reference text not null check(operator_decision_reference ~ '^operator-decision:[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$'),
 reason text not null check(length(reason) between 40 and 2000),
 job_before jsonb not null,step_before jsonb not null,provider_before jsonb not null,
 reservation_before jsonb not null,reservation_after jsonb not null,local_marker jsonb not null,
 absence_evidence jsonb not null,account_before jsonb not null,account_after jsonb not null,
 operator_role name not null,operator_session name not null,recorded_at timestamptz not null
);

create function fluid_private.record_logo_absent_publication_adjudication()
returns trigger language plpgsql set search_path='' set timezone='UTC' as $$
declare
 pinned_job_id constant uuid := 'f51813b6-6ec9-4b81-b525-e0b540ca1662';
 pinned_job_sha256 constant text := 'b6745220b4f3a59785e5010d2e8e0d7cb96bc9dd971a7aa3347a366fa6c860d4';
 pinned_step_sha256 constant text := '51884bec0a2ced562011415d34126b2cf26848345ece0867b87791e4f7fa8d6c';
 pinned_provider_sha256 constant text := '7d5d6a1803ea07d83f96f8829d93b6331793845509cd5b6844629438024a6c6e';
 pinned_reservation_sha256 constant text := '728fe380c35ad05fc5931615107b178d54058861e4fa34680c5865449af4438f';
 pinned_marker_sha256 constant text := '60f7bd91f93bf0c29cada68784b405d96d7e908365c83ffa9bc455c33f288be9';
 j public.jobs;s public.job_steps;p public.logo_provider_responses;r public.usage_reservations;
 m fluid_private.logo_local_jobs;project public.projects;ledger public.usage_accounts;after_ledger public.usage_accounts;
 namespace text;released bigint;
begin
 if tg_op='TRUNCATE' and not exists(select 1 from fluid_private.logo_absent_publication_adjudications) then return null;end if;
 if tg_op<>'INSERT' then raise exception 'immutable_logo_absent_adjudication' using errcode='55000';end if;
 if current_user is distinct from 'postgres'
  or current_user is distinct from pg_get_userbyid((select relowner from pg_class where oid=tg_relid)) then
  raise exception 'operator_required' using errcode='42501';end if;
 if new.job_id is distinct from pinned_job_id then raise exception 'wrong_logo_absent_incident' using errcode='55000';end if;
 -- Same project -> job order as prepare/observe/complete. A publication call
 -- already holding these locks must finish before this check; a delayed call
 -- behind us must subsequently reject the cleared lease and terminal job.
 select pr.* into strict project from public.projects pr join public.jobs jj on jj.project_id=pr.id and jj.owner_id=pr.owner_id
  where jj.id=new.job_id for update of pr;
 select * into strict j from public.jobs where id=new.job_id for update;
 select * into strict s from public.job_steps where job_id=j.id for update;
 select * into strict p from public.logo_provider_responses where job_id=j.id for update;
 select * into strict r from public.usage_reservations where job_id=j.id for update;
 select * into strict m from fluid_private.logo_local_jobs where job_id=j.id for share;
 select * into strict ledger from public.usage_accounts where owner_id=j.owner_id for update;
 namespace:=j.owner_id::text||'/'||j.project_id::text||'/';
 if encode(sha256(convert_to(to_jsonb(j)::text,'UTF8')),'hex') is distinct from pinned_job_sha256
  or encode(sha256(convert_to(to_jsonb(s)::text,'UTF8')),'hex') is distinct from pinned_step_sha256
  or encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') is distinct from pinned_provider_sha256
  or encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') is distinct from pinned_reservation_sha256
  or encode(sha256(convert_to(to_jsonb(m)::text,'UTF8')),'hex') is distinct from pinned_marker_sha256
  or j.operation is distinct from 'identity.logo_concept' or j.state is distinct from 'needs_reconciliation'
  or j.error_code is distinct from 'publication_unknown' or j.billing_mode is distinct from 'openai_api'
  or j.lease_token is not null or j.lease_expires_at is not null or j.finished_at is not null
  or j.cancel_requested_at is not null or j.project_deletion_requested_at is not null
  or project.deleted_at is not null or project.deletion_requested_at is not null
  or (s.owner_id,s.project_id,s.state,s.output) is distinct from (j.owner_id,j.project_id,'ambiguous','{"error":"publication_unknown"}'::jsonb)
  or s.completed_at is null or s.provider_request_id is null
  or j.plan_manifest is distinct from jsonb_build_array(jsonb_build_object('key',s.step_key,'maximumCostMicrousd',j.reserved_cost_microusd))
  or (p.owner_id,p.project_id) is distinct from (j.owner_id,j.project_id) or p.lease_token is null
  or p.observation->>'providerRequestId' is distinct from s.provider_request_id
  or p.observation->>'provider' is distinct from 'openai'
  or p.observation->>'model' is distinct from 'gpt-image-2.5-sunburst-2026-09-08'
  or p.observation->>'artifactHash' is null or p.observation->>'artifactHash' !~ '^[a-f0-9]{64}$'
  or p.observation#>>'{billing,status}' is distinct from 'recorded'
  or (p.observation#>>'{billing,confirmedMicrousd}')::bigint is distinct from j.actual_cost_microusd
  or j.actual_cost_microusd<=0 or j.actual_cost_microusd>j.reserved_cost_microusd
  or s.actual_cost_microusd is distinct from j.actual_cost_microusd
  or (r.owner_id,r.project_id,r.state,r.reserved_microusd,r.actual_microusd,r.captured_microusd)
   is distinct from (j.owner_id,j.project_id,'active',j.reserved_cost_microusd,j.actual_cost_microusd,j.actual_cost_microusd)
  or (m.owner_id,m.project_id,m.worker_id,m.policy_identity)
   is distinct from (j.owner_id,j.project_id,j.worker_id,j.input->>'policyIdentity')
  or not exists(select 1 from fluid_private.logo_worker_principals wp join pg_roles role on role.oid=wp.role_oid and role.rolname=wp.role_name
   where wp.owner_id=m.owner_id and wp.role_name=m.role_name and wp.role_oid=m.role_oid
   and role.rolcanlogin and not role.rolinherit and not role.rolsuper and not role.rolbypassrls
   and not role.rolcreatedb and not role.rolcreaterole and not role.rolreplication
   and not exists(select 1 from pg_auth_members where member=role.oid)) then
  raise exception 'logo_absent_adjudication_evidence_mismatch' using errcode='55000';end if;
 -- This recovery is intentionally unavailable while the worker is connected or
 -- any Logo job is leased. The deployment stop is independently verified; this
 -- DB check is an additional fail-closed gate, not a distributed stop mechanism.
 if exists(select 1 from pg_stat_activity where usename=m.role_name)
  or exists(select 1 from public.jobs where owner_id=j.owner_id and operation like 'identity.logo_%'
   and (state in('running','cancel_requested') or lease_token is not null or lease_expires_at is not null)) then
  raise exception 'logo_absent_adjudication_requires_drained_worker' using errcode='55000';end if;
 -- An upload through the restricted Storage identity requires both a committed
 -- publication reservation and an exact grant for that live job/lease. No
 -- reservation exists here, so this is absence of a committed output, never a
 -- claim that the already charged provider request did not execute.
 if exists(select 1 from public.logo_asset_publications a where a.job_id=j.id or
   (a.owner_id=j.owner_id and a.project_id=j.project_id and
    (a.request_key::text=j.input->>'attemptId' or a.source_receipt_id::text=j.input->>'attemptId' or a.content_hash=p.observation->>'artifactHash')))
  or exists(select 1 from fluid_private.logo_generative_storage_grants where job_id=j.id)
  or exists(select 1 from public.logo_raster_results where job_id=j.id)
  or exists(select 1 from public.asset_versions where owner_id=j.owner_id and project_id=j.project_id and content_hash=p.observation->>'artifactHash')
  or exists(select 1 from storage.objects o where o.bucket_id='fluid-assets' and left(o.name,length(namespace))=namespace
   and (o.created_at>=s.created_at or not exists(select 1 from public.logo_asset_publications a
    where o.name=a.owner_id::text||'/'||a.project_id::text||'/'||a.asset_id::text||'/'||a.version_id::text))) then
  raise exception 'logo_absent_adjudication_output_not_absent' using errcode='55000';end if;
 new.job_before:=to_jsonb(j);new.step_before:=to_jsonb(s);new.provider_before:=to_jsonb(p);
 new.reservation_before:=to_jsonb(r);new.local_marker:=to_jsonb(m);new.account_before:=to_jsonb(ledger);
 new.operator_role:=current_user;new.operator_session:=session_user;new.recorded_at:=clock_timestamp();
 select jsonb_build_object('publicationCount',0,'grantCount',0,'resultCount',0,'artifactVersionCount',0,
  'workerSessionCount',0,'activeLogoJobCount',0,'storageObjectsSinceStep',0,'unmappedStorageObjects',0,
  'namespace',namespace,'namespaceObjectCount',count(*),'namespaceNewestObjectAt',max(o.created_at),
  'namespaceObjectRowsSha256',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(o)::text,E'\n' order by o.id::text),''),'UTF8')),'hex'),
  'stepStartedAt',s.created_at,'checkedAt',new.recorded_at) into new.absence_evidence
 from storage.objects o where o.bucket_id='fluid-assets' and left(o.name,length(namespace))=namespace;
 perform fluid_private.settle_reservation(j.id);
 select to_jsonb(rr) into strict new.reservation_after from public.usage_reservations rr where job_id=j.id;
 select * into strict after_ledger from public.usage_accounts where owner_id=j.owner_id;
 new.account_after:=to_jsonb(after_ledger);released:=greatest(r.reserved_microusd-r.actual_microusd,0);
 if new.reservation_after is distinct from (new.reservation_before||'{"state":"settled"}'::jsonb)
  or new.account_after is distinct from (new.account_before||jsonb_build_object('reserved_microusd',ledger.reserved_microusd-released)) then
  raise exception 'logo_absent_adjudication_accounting_changed' using errcode='55000';end if;
 update public.jobs set state='failed',error_code='publication_not_committed',finished_at=new.recorded_at where id=j.id;
 return new;
end $$;
create trigger logo_absent_adjudication_insert before insert on fluid_private.logo_absent_publication_adjudications
 for each row execute function fluid_private.record_logo_absent_publication_adjudication();
create trigger logo_absent_adjudication_immutable before update or delete on fluid_private.logo_absent_publication_adjudications
 for each row execute function fluid_private.record_logo_absent_publication_adjudication();
create trigger logo_absent_adjudication_no_truncate before truncate on fluid_private.logo_absent_publication_adjudications
 for each statement execute function fluid_private.record_logo_absent_publication_adjudication();

create function fluid_private.logo_absent_publication_adjudication_matches(p_job uuid)
returns boolean language sql stable set search_path='' set timezone='UTC' as $$
 select exists(select 1 from fluid_private.logo_absent_publication_adjudications x
  join public.jobs j on j.id=x.job_id join public.job_steps s on s.job_id=j.id
  join public.logo_provider_responses p on p.job_id=j.id join public.usage_reservations r on r.job_id=j.id
  join fluid_private.logo_local_jobs m on m.job_id=j.id
  where j.id=p_job and j.state='failed' and j.error_code='publication_not_committed' and j.finished_at=x.recorded_at
   and to_jsonb(j)-array['state','error_code','finished_at']=x.job_before-array['state','error_code','finished_at']
   and to_jsonb(s)=x.step_before and s.state='ambiguous' and (select count(*) from public.job_steps where job_id=j.id)=1
   and to_jsonb(p)=x.provider_before and (select count(*) from public.logo_provider_responses where job_id=j.id)=1
   and to_jsonb(r)=x.reservation_after and r.state='settled' and to_jsonb(m)=x.local_marker
   and not exists(select 1 from public.logo_asset_publications a where a.job_id=j.id or
    (a.owner_id=j.owner_id and a.project_id=j.project_id and
     (a.request_key::text=j.input->>'attemptId' or a.source_receipt_id::text=j.input->>'attemptId' or a.content_hash=p.observation->>'artifactHash')))
   and not exists(select 1 from fluid_private.logo_generative_storage_grants where job_id=j.id)
   and not exists(select 1 from public.logo_raster_results where job_id=j.id)
   and not exists(select 1 from public.asset_versions where owner_id=j.owner_id and project_id=j.project_id and content_hash=p.observation->>'artifactHash'));
$$;

-- Add this independently verified absence witness to the existing matcher. The
-- previous uploaded-but-uncommitted witness remains byte-for-byte as a branch;
-- its immutable records and original recording trigger are not changed.
do $patch$
declare definition text;original constant text :=
 $old$and not exists(select 1 from public.logo_raster_results where job_id=j.id));$old$;
begin
 definition:=pg_get_functiondef('fluid_private.logo_publication_failure_adjudication_matches(uuid)'::regprocedure);
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then
  raise exception 'unexpected_logo_absent_adjudication_fragment';end if;
 execute replace(definition,original,
  'and not exists(select 1 from public.logo_raster_results where job_id=j.id)) or fluid_private.logo_absent_publication_adjudication_matches(p_job);');
end $patch$;

do $acl$
declare object_id oid;recipient record;column_grant record;
begin
 alter table fluid_private.logo_absent_publication_adjudications enable row level security;
 alter table fluid_private.logo_absent_publication_adjudications force row level security;
 object_id:='fluid_private.logo_absent_publication_adjudications'::regclass;
 for recipient in select distinct a.grantee from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  where c.oid=object_id and a.grantee<>c.relowner loop
  execute format('revoke all on table %s from %s cascade',object_id::regclass,
   case when recipient.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(recipient.grantee)) end);
 end loop;
 for column_grant in select at.attname,a.grantee from pg_attribute at join pg_class c on c.oid=at.attrelid
  cross join lateral aclexplode(at.attacl) a where c.oid=object_id and a.grantee<>c.relowner loop
  execute format('revoke all (%I) on table %s from %s cascade',column_grant.attname,object_id::regclass,
   case when column_grant.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(column_grant.grantee)) end);
 end loop;
 foreach object_id in array array['fluid_private.record_logo_absent_publication_adjudication()'::regprocedure,
  'fluid_private.logo_absent_publication_adjudication_matches(uuid)'::regprocedure] loop
  for recipient in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where p.oid=object_id and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object_id::regprocedure,
    case when recipient.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(recipient.grantee)) end);
  end loop;
 end loop;
 if exists(select 1 from logo_absent_original_function old left join pg_proc p on p.oid=old.oid
  where p.oid is null or (p.proowner,p.proacl,p.prosecdef,p.provolatile,p.proconfig,p.proleakproof)
   is distinct from (old.proowner,old.proacl,old.prosecdef,old.provolatile,old.proconfig,old.proleakproof)) then
  raise exception 'logo_absent_adjudication_security_changed';end if;
end $acl$;
commit;
